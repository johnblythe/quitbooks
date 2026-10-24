import "server-only";
import { connection } from "next/server";
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { BOOTH_RENT_KEY, SETTING_KEYS, type OpeningBalance } from "@/db/defaults";
import type { CsvMapping } from "./csv";
import type { CategorizeInput } from "./categorize";
import { categorize } from "./categorize";
import { monthEnd, monthStart, todayIso, type IsoDate, type MonthKey } from "./dates";
import type { MetricTx } from "./metrics";

/**
 * Data access layer. Every read awaits connection() so it runs at request time
 * (Cache Components would otherwise try to prerender it at build).
 */

const { categories, stylists, transactions, rules, settings, csvMappings, importBatches } = schema;

export const BMO_MAPPING_NAME = "BMO";

export async function getCategories(opts: { includeArchived?: boolean } = {}) {
  await connection();
  const db = await getDb();
  return db
    .select()
    .from(categories)
    .where(opts.includeArchived ? undefined : eq(categories.archived, false))
    .orderBy(asc(categories.kind), asc(categories.sortOrder), asc(categories.name));
}

export async function getStylists() {
  await connection();
  const db = await getDb();
  return db.select().from(stylists).orderBy(asc(stylists.name));
}

export async function getRules() {
  await connection();
  const db = await getDb();
  return db
    .select({
      id: rules.id,
      pattern: rules.pattern,
      categoryId: rules.categoryId,
      direction: rules.direction,
      priority: rules.priority,
      categoryName: categories.name,
    })
    .from(rules)
    .innerJoin(categories, eq(rules.categoryId, categories.id))
    .orderBy(asc(rules.priority), asc(rules.pattern));
}

export async function getSettings(): Promise<{ totalChairs: number; openingBalance: OpeningBalance | null }> {
  await connection();
  const db = await getDb();
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    totalChairs: Number(map.get(SETTING_KEYS.totalChairs) ?? 0),
    openingBalance: (map.get(SETTING_KEYS.openingBalance) as OpeningBalance | undefined) ?? null,
  };
}

export async function getBoothRentCategoryId(): Promise<string | null> {
  await connection();
  const db = await getDb();
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.systemKey, BOOTH_RENT_KEY));
  return row?.id ?? null;
}

const txSelect = {
  id: transactions.id,
  date: transactions.date,
  amountCents: transactions.amountCents,
  description: transactions.description,
  note: transactions.note,
  source: transactions.source,
  categoryId: transactions.categoryId,
  stylistId: transactions.stylistId,
  categoryName: categories.name,
  categoryKind: categories.kind,
  stylistName: stylists.name,
};

export type TxRow = Awaited<ReturnType<typeof getTransactionsForMonth>>[number];

export async function getTransactionsForMonth(month: MonthKey) {
  await connection();
  const db = await getDb();
  return db
    .select(txSelect)
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(stylists, eq(transactions.stylistId, stylists.id))
    .where(and(gte(transactions.date, monthStart(month)), lte(transactions.date, monthEnd(month))))
    .orderBy(desc(transactions.date), desc(transactions.createdAt));
}

export async function getUncategorized(limit = 100) {
  await connection();
  const db = await getDb();
  return db
    .select(txSelect)
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(stylists, eq(transactions.stylistId, stylists.id))
    .where(isNull(transactions.categoryId))
    .orderBy(desc(transactions.date))
    .limit(limit);
}

/** Max rows the grouped Inbox loads at once. */
export const INBOX_LIMIT = 2000;

/** Every uncategorized row for the grouped Inbox (capped), plus the true total. */
export async function getInboxRows(limit = INBOX_LIMIT) {
  const [rows, total] = await Promise.all([getUncategorized(limit), countUncategorized()]);
  return { rows, total, capped: total > rows.length };
}

export async function countUncategorized(): Promise<number> {
  await connection();
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(isNull(transactions.categoryId));
  return row?.n ?? 0;
}

export async function getTransaction(id: string) {
  await connection();
  const db = await getDb();
  const [row] = await db
    .select(txSelect)
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(stylists, eq(transactions.stylistId, stylists.id))
    .where(eq(transactions.id, id));
  return row ?? null;
}

/** Lightweight rows for metrics/reports over a date range (inclusive). */
export async function getMetricTxs(from?: IsoDate, to?: IsoDate): Promise<MetricTx[]> {
  await connection();
  const db = await getDb();
  const conds = [from ? gte(transactions.date, from) : undefined, to ? lte(transactions.date, to) : undefined];
  return db
    .select({
      date: transactions.date,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      stylistId: transactions.stylistId,
    })
    .from(transactions)
    .where(and(...conds));
}

/** Detailed rows for the P&L CSV export. */
export async function getTransactionsInRange(from: IsoDate, to: IsoDate) {
  await connection();
  const db = await getDb();
  return db
    .select(txSelect)
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(stylists, eq(transactions.stylistId, stylists.id))
    .where(and(gte(transactions.date, from), lte(transactions.date, to)))
    .orderBy(asc(transactions.date));
}

export async function getSavedMapping(): Promise<CsvMapping | null> {
  await connection();
  const db = await getDb();
  const [row] = await db.select().from(csvMappings).where(eq(csvMappings.name, BMO_MAPPING_NAME));
  return row?.mapping ?? null;
}

export async function getRecentImports(limit = 5) {
  await connection();
  const db = await getDb();
  return db.select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(limit);
}

/** Everything the categorizer needs, loaded once per import or entry. */
export async function getCategorizer() {
  const db = await getDb();
  const [allStylists, allRules, boothRentCategoryId] = await Promise.all([
    db.select().from(stylists),
    db.select().from(rules).orderBy(asc(rules.priority), desc(sql`length(${rules.pattern})`), asc(rules.createdAt), asc(rules.id)),
    getBoothRentCategoryId(),
  ]);
  return (tx: CategorizeInput) =>
    categorize(tx, { stylists: allStylists, rules: allRules, boothRentCategoryId });
}

/** Today's date, computed per request (never baked in at build time). */
export async function requestToday() {
  await connection();
  return todayIso();
}
