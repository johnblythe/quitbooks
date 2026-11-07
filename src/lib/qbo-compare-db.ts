/**
 * Database side of `npm run qbo:compare`. READ ONLY: everything is read inside one
 * `READ ONLY, REPEATABLE READ` transaction, which Postgres itself refuses to write in, and the
 * transaction's read-only flag is checked before anything is read. Free of Next/auth imports so the
 * script and PGlite tests share it.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import type { IsoDate, MonthKey } from "./dates";
import { CATEGORIZED_MAPPING_NAME } from "./import-categories";
import { expandLedgerLines } from "./ledger";
import { compareBooks, formatReport, mismatchSummary, resolveOverrides, type CompareResult, type OurCategory, type OurLine } from "./qbo-compare";
import { parseQboPnl, selectMonths } from "./qbo-pnl";
import { splitLinesInRange } from "./split-server";

const { categories, transactions, csvMappings } = schema;

type ReadTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Runs `fn` in a read-only transaction and refuses to go on unless Postgres confirms it is one.
 * Any INSERT/UPDATE/DELETE inside fails with "cannot execute ... in a read-only transaction".
 */
export async function withReadOnly<T>(db: Db, fn: (tx: ReadTx) => Promise<T>): Promise<T> {
  return db.transaction(
    async (tx) => {
      const res = await tx.execute(sql`show transaction_read_only`);
      const flag = (res.rows[0] as Record<string, unknown> | undefined)?.transaction_read_only;
      if (flag !== "on") throw new Error("Couldn't open a read-only transaction, so nothing was read.");
      return fn(tx);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export type OurBooks = {
  categories: OurCategory[];
  lines: OurLine[];
  /** `csv_mappings` "BMO:categories" -> mapping.categoryMap, or null if nothing was imported with categories. */
  savedMap: Record<string, unknown> | null;
};

/** Every category (hidden ones too, as the P&L page uses), the ledger lines in range, and the saved map. */
export async function loadOurBooks(db: Db, from: IsoDate, to: IsoDate): Promise<OurBooks> {
  return withReadOnly(db, async (tx) => {
    const cats = await tx
      .select({ id: categories.id, name: categories.name, kind: categories.kind, archived: categories.archived })
      .from(categories);
    const rows = await tx
      .select({
        id: transactions.id,
        date: transactions.date,
        amountCents: transactions.amountCents,
        description: transactions.description,
        source: transactions.source,
        categoryId: transactions.categoryId,
        stylistId: transactions.stylistId,
        isSplit: transactions.isSplit,
      })
      .from(transactions)
      .where(and(gte(transactions.date, from), lte(transactions.date, to)))
      .orderBy(transactions.date, transactions.createdAt);
    const splits = await splitLinesInRange(tx, from, to);
    const [saved] = await tx
      .select({ mapping: csvMappings.mapping })
      .from(csvMappings)
      .where(eq(csvMappings.name, CATEGORIZED_MAPPING_NAME));
    return {
      categories: cats,
      lines: expandLedgerLines(rows, splits),
      savedMap: (saved?.mapping.categoryMap as Record<string, unknown> | undefined) ?? null,
    };
  });
}

export type QboCompareRun = { result: CompareResult; report: string; summary: string; match: boolean };

/** Parse the export, read our books (read-only), compare, and format. Throws on unreadable input. */
export async function runQboCompare(
  db: Db,
  opts: { csvText: string; fileName: string; from?: MonthKey; to?: MonthKey; toleranceCents?: number; overrides?: unknown },
): Promise<QboCompareRun> {
  const pnl = selectMonths(parseQboPnl(opts.csvText), opts.from, opts.to);
  // Columns run oldest to newest, so this spans every column (a partial month included).
  const books = await loadOurBooks(db, pnl.columns[0].from, pnl.columns[pnl.columns.length - 1].to);
  const overrides = opts.overrides === undefined ? undefined : resolveOverrides(opts.overrides, books.categories);
  const result = compareBooks({
    pnl,
    categories: books.categories,
    lines: books.lines,
    savedMap: books.savedMap,
    overrides,
    toleranceCents: opts.toleranceCents ?? 0,
  });
  const report = formatReport(result, { file: opts.fileName, basis: pnl.basis, readOnly: true });
  return { result, report, summary: mismatchSummary(result), match: result.mismatches.length === 0 };
}
