/**
 * Database side of the CSV import, kept free of Next/auth imports so it can run against any `Db`
 * (the app's, or a throwaway PGlite in tests). The server actions in `src/app/actions/import.ts`
 * authenticate, validate arguments and call into here.
 */
import { and, between, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import type { CsvMapping, ParsedRow } from "./csv";
import { addDays } from "./dates";
import { MATCH_WINDOW_DAYS, type ManualCandidate } from "./import-match";
import type { ImportLink } from "./import-schema";

const { transactions, importBatches, csvMappings } = schema;

/** Anything that can run queries: the Db itself or a transaction on it. */
type Executor = Pick<Db, "select" | "insert" | "update">;

export async function existingHashes(db: Executor, hashes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  // Chunk to keep query parameters reasonable.
  for (let i = 0; i < hashes.length; i += 500) {
    const chunk = hashes.slice(i, i + 500);
    const rows = await db
      .select({ h: transactions.dedupeHash })
      .from(transactions)
      .where(inArray(transactions.dedupeHash, chunk));
    rows.forEach((r) => r.h && found.add(r.h));
  }
  return found;
}

/**
 * Manual entries that could be the same transaction as one of `rows`: source 'manual', no dedupe
 * hash yet, same amount, within the match window of the rows' date range. The pure
 * `matchManualEntries` then decides which pairs to pair up.
 */
export async function findManualCandidates(
  db: Executor,
  rows: { date: string; amountCents: number }[],
): Promise<ManualCandidate[]> {
  if (!rows.length) return [];
  const dates = rows.map((r) => r.date).sort();
  const from = addDays(dates[0], -MATCH_WINDOW_DAYS);
  const to = addDays(dates[dates.length - 1], MATCH_WINDOW_DAYS);
  const amounts = [...new Set(rows.map((r) => r.amountCents))];
  const found: ManualCandidate[] = [];
  for (let i = 0; i < amounts.length; i += 500) {
    const chunk = amounts.slice(i, i + 500);
    const res = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        amountCents: transactions.amountCents,
        description: transactions.description,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.source, "manual"),
          isNull(transactions.dedupeHash),
          inArray(transactions.amountCents, chunk),
          between(transactions.date, from, to),
        ),
      );
    found.push(...res);
  }
  return found;
}

/** A confirmed link that no longer holds (the manual entry changed or was already linked). */
export class ImportLinkError extends Error {}

export type CommitInput = {
  userId: string;
  filename: string;
  mappingName: string;
  mapping: CsvMapping;
  rows: ParsedRow[];
  links: ImportLink[];
  categorizer: (r: ParsedRow) => { categoryId: string | null; stylistId: string | null };
};

export type CommitOutcome = {
  inserted: number;
  /** Rows already in the ledger from an earlier import. */
  duplicates: number;
  /** Rows tied to an existing manual entry instead of being inserted. */
  linked: number;
  months: string[];
};

/**
 * Writes an import in ONE transaction: the batch row, the new transactions, the links to manual
 * entries, the batch counts and the saved mapping. If anything throws, nothing is left behind.
 */
export async function commitParsedImport(db: Db, input: CommitInput): Promise<CommitOutcome> {
  const { userId, rows, links } = input;

  const byLine = new Map(rows.map((r) => [r.line, r]));
  const linkLines = new Set<number>();
  const linkTargets = new Set<string>();
  for (const l of links) {
    if (!byLine.has(l.line)) throw new ImportLinkError(`Line ${l.line} isn't in this file.`);
    if (linkLines.has(l.line) || linkTargets.has(l.transactionId)) {
      throw new ImportLinkError("The same row or entry was linked twice.");
    }
    linkLines.add(l.line);
    linkTargets.add(l.transactionId);
  }

  return db.transaction(async (tx) => {
    const dupes = await existingHashes(tx, rows.map((r) => r.dedupeHash));

    // Re-check every confirmed link against the database as it is now, inside the transaction.
    for (const l of links) {
      const row = byLine.get(l.line)!;
      if (dupes.has(row.dedupeHash)) {
        throw new ImportLinkError(`Line ${l.line} was already imported, so it can't also be linked.`);
      }
      const updated = await tx
        .update(transactions)
        .set({ dedupeHash: row.dedupeHash, updatedAt: new Date() })
        .where(
          and(
            eq(transactions.id, l.transactionId),
            eq(transactions.source, "manual"),
            isNull(transactions.dedupeHash),
            eq(transactions.amountCents, row.amountCents),
            between(transactions.date, addDays(row.date, -MATCH_WINDOW_DAYS), addDays(row.date, MATCH_WINDOW_DAYS)),
          ),
        )
        .returning({ id: transactions.id });
      if (!updated.length) {
        throw new ImportLinkError(
          `An entry you matched on line ${l.line} changed while you were reviewing. Preview the file again.`,
        );
      }
    }

    const fresh = rows.filter((r) => !dupes.has(r.dedupeHash) && !linkLines.has(r.line));
    const duplicates = rows.filter((r) => dupes.has(r.dedupeHash)).length;

    const [batch] = await tx
      .insert(importBatches)
      .values({
        filename: input.filename.slice(0, 200) || "import.csv",
        rowCount: rows.length,
        insertedCount: 0,
        skippedCount: 0,
        createdBy: userId,
      })
      .returning({ id: importBatches.id });

    let inserted = 0;
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200).map((r) => {
        const auto = input.categorizer(r);
        return {
          date: r.date,
          amountCents: r.amountCents,
          description: r.description,
          categoryId: auto.categoryId,
          stylistId: auto.stylistId,
          source: "csv" as const,
          importBatchId: batch.id,
          dedupeHash: r.dedupeHash,
          createdBy: userId,
        };
      });
      // onConflictDoNothing guards against a double-submit racing the duplicate check.
      const res = await tx
        .insert(transactions)
        .values(chunk)
        .onConflictDoNothing({ target: transactions.dedupeHash })
        .returning({ id: transactions.id });
      inserted += res.length;
    }

    const linked = links.length;
    // "skipped" = rows in the file that were not inserted (already here, or tied to a manual entry).
    await tx
      .update(importBatches)
      .set({ insertedCount: inserted, skippedCount: rows.length - inserted })
      .where(eq(importBatches.id, batch.id));

    await tx
      .insert(csvMappings)
      .values({ name: input.mappingName, mapping: input.mapping })
      .onConflictDoUpdate({ target: csvMappings.name, set: { mapping: input.mapping } });

    const months = [...new Set(fresh.map((r) => r.date.slice(0, 7)))].sort();
    return { inserted, duplicates, linked, months };
  });
}
