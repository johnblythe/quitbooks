/**
 * Database side of splitting a transaction, free of Next/auth imports so tests can run it against
 * PGlite. The server actions in `src/app/actions/splits.ts` authenticate and call into here.
 */
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { BOOTH_RENT_KEY } from "@/db/defaults";
import type { IsoDate } from "./dates";
import { expandLedgerLines, toMetricTxs } from "./ledger";
import type { MetricTx } from "./metrics";
import { validateSplit, type SplitLineInput } from "./splits";

const { transactions, transactionSplits, categories, stylists } = schema;

export type SplitOutcome = { ok: true; date: string } | { ok: false; error: string };

/**
 * Replaces a transaction's split lines in ONE transaction. The parent row is locked and its
 * amount re-read, so the lines are checked against the amount as stored, never the client's.
 * The parent loses its own category/stylist and leaves the Inbox.
 */
export async function saveSplit(db: Db, transactionId: string, lines: SplitLineInput[]): Promise<SplitOutcome> {
  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ id: transactions.id, date: transactions.date, amountCents: transactions.amountCents })
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .for("update");
    if (!parent) return { ok: false, error: "That transaction no longer exists." } as const;

    const cats = await tx
      .select({ id: categories.id, archived: categories.archived, systemKey: categories.systemKey })
      .from(categories);
    const people = await tx.select({ id: stylists.id }).from(stylists);
    const v = validateSplit(lines, {
      parentAmountCents: parent.amountCents,
      categories: cats,
      boothRentCategoryId: cats.find((c) => c.systemKey === BOOTH_RENT_KEY)?.id ?? null,
      stylistIds: people.map((p) => p.id),
    });
    if (!v.ok) return { ok: false, error: v.error } as const;

    await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId));
    await tx.insert(transactionSplits).values(v.lines.map((l, i) => ({ ...l, transactionId, position: i })));
    await tx
      .update(transactions)
      .set({ isSplit: true, categoryId: null, stylistId: null, updatedAt: new Date() })
      .where(eq(transactions.id, transactionId));
    return { ok: true, date: parent.date } as const;
  });
}

/**
 * Turns a split row back into a single one. With no category it goes back to the Inbox; with one,
 * it takes that category (and stylist). Removing a split from an unsplit row is a no-op.
 */
export async function removeSplit(
  db: Db,
  transactionId: string,
  choice: { categoryId: string | null; stylistId: string | null },
): Promise<SplitOutcome> {
  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ id: transactions.id, date: transactions.date, isSplit: transactions.isSplit })
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .for("update");
    if (!parent) return { ok: false, error: "That transaction no longer exists." } as const;
    if (!parent.isSplit) return { ok: true, date: parent.date } as const;

    if (choice.categoryId) {
      const [cat] = await tx
        .select({ archived: categories.archived })
        .from(categories)
        .where(eq(categories.id, choice.categoryId));
      if (!cat || cat.archived) return { ok: false, error: "Pick a category that isn't hidden." } as const;
    }
    const stylistId = choice.categoryId ? choice.stylistId : null;
    if (stylistId) {
      const [st] = await tx.select({ id: stylists.id }).from(stylists).where(eq(stylists.id, stylistId));
      if (!st) return { ok: false, error: "That stylist no longer exists." } as const;
    }

    await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId));
    await tx
      .update(transactions)
      .set({ isSplit: false, categoryId: choice.categoryId, stylistId, updatedAt: new Date() })
      .where(eq(transactions.id, transactionId));
    return { ok: true, date: parent.date } as const;
  });
}

/** A transaction's split lines in order, with names for display. */
export async function splitLinesFor(db: Pick<Db, "select">, transactionId: string) {
  return db
    .select({
      id: transactionSplits.id,
      transactionId: transactionSplits.transactionId,
      position: transactionSplits.position,
      categoryId: transactionSplits.categoryId,
      stylistId: transactionSplits.stylistId,
      amountCents: transactionSplits.amountCents,
      memo: transactionSplits.memo,
      categoryName: categories.name,
      categoryKind: categories.kind,
      stylistName: stylists.name,
    })
    .from(transactionSplits)
    .leftJoin(categories, eq(transactionSplits.categoryId, categories.id))
    .leftJoin(stylists, eq(transactionSplits.stylistId, stylists.id))
    .where(eq(transactionSplits.transactionId, transactionId))
    .orderBy(asc(transactionSplits.position));
}

/** Split lines of every split parent dated within the range (inclusive; open ends allowed). */
export async function splitLinesInRange(db: Pick<Db, "select">, from?: IsoDate, to?: IsoDate) {
  return db
    .select({
      transactionId: transactionSplits.transactionId,
      position: transactionSplits.position,
      categoryId: transactionSplits.categoryId,
      stylistId: transactionSplits.stylistId,
      amountCents: transactionSplits.amountCents,
      memo: transactionSplits.memo,
      categoryName: categories.name,
      categoryKind: categories.kind,
      stylistName: stylists.name,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
    .leftJoin(categories, eq(transactionSplits.categoryId, categories.id))
    .leftJoin(stylists, eq(transactionSplits.stylistId, stylists.id))
    .where(
      and(
        eq(transactions.isSplit, true),
        from ? gte(transactions.date, from) : undefined,
        to ? lte(transactions.date, to) : undefined,
      ),
    );
}

/** Metric rows for a date range with split parents expanded into their lines. */
export async function metricTxsInRange(db: Pick<Db, "select">, from?: IsoDate, to?: IsoDate): Promise<MetricTx[]> {
  const [rows, splits] = await Promise.all([
    db
      .select({
        id: transactions.id,
        date: transactions.date,
        amountCents: transactions.amountCents,
        categoryId: transactions.categoryId,
        stylistId: transactions.stylistId,
        isSplit: transactions.isSplit,
      })
      .from(transactions)
      .where(and(from ? gte(transactions.date, from) : undefined, to ? lte(transactions.date, to) : undefined)),
    splitLinesInRange(db, from, to),
  ]);
  return toMetricTxs(expandLedgerLines(rows, splits));
}
