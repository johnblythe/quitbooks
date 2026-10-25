import "server-only";
import { connection } from "next/server";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { BOOTH_RENT_KEY, SETTING_KEYS, type OpeningBalance } from "@/db/defaults";
import type { CsvMapping } from "./csv";
import { makeCategorizer } from "./categorizer";
import { defaultCutover } from "./bank-status";
import { monthEnd, monthStart, todayIso, type IsoDate, type MonthKey } from "./dates";
import type { MetricTx } from "./metrics";
import { inInbox } from "./inbox-where";
import { expandLedgerLines } from "./ledger";
import { metricTxsInRange, splitLinesFor, splitLinesInRange } from "./split-server";
import { bankAttention } from "./bank-status";

/**
 * Data access layer. Every read awaits connection() so it runs at request time
 * (Cache Components would otherwise try to prerender it at build).
 */

const { categories, stylists, transactions, rules, settings, csvMappings, importBatches, bankConnections, bankAccounts } = schema;

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
  isSplit: transactions.isSplit,
  suggestedCategoryId: transactions.suggestedCategoryId,
  suggestedAt: transactions.suggestedAt,
  categoryName: categories.name,
  categoryKind: categories.kind,
  stylistName: stylists.name,
};

export type TxRow = Awaited<ReturnType<typeof getUncategorized>>[number];

/** A month's transactions (with each split's line count) plus their ledger lines, for totals. */
export async function getTransactionsForMonth(month: MonthKey) {
  await connection();
  const db = await getDb();
  const [from, to] = [monthStart(month), monthEnd(month)];
  const [rows, splits] = await Promise.all([
    db
      .select(txSelect)
      .from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(stylists, eq(transactions.stylistId, stylists.id))
      .where(and(gte(transactions.date, from), lte(transactions.date, to)))
      .orderBy(desc(transactions.date), desc(transactions.createdAt)),
    splitLinesInRange(db, from, to),
  ]);
  const lines = expandLedgerLines(rows, splits);
  const counts = new Map<string, number>();
  for (const l of lines) if (l.split) counts.set(l.tx.id, l.count);
  return { rows: rows.map((r) => ({ ...r, splitCount: counts.get(r.id) ?? 0 })), lines };
}

export async function getUncategorized(limit = 100) {
  await connection();
  const db = await getDb();
  return db
    .select(txSelect)
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(stylists, eq(transactions.stylistId, stylists.id))
    .where(inInbox())
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
    .where(inInbox());
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

/** A transaction's split lines in order (empty if it isn't split). */
export async function getSplitLines(transactionId: string) {
  await connection();
  return splitLinesFor(await getDb(), transactionId);
}

/**
 * Lightweight rows for metrics/reports over a date range (inclusive). Split parents come back as
 * one row per split line (parent's date, line's amount/category/stylist), so every metric that
 * groups by category sees the lines. Amounts still sum to the bank, so the balance is unchanged.
 */
export async function getMetricTxs(from?: IsoDate, to?: IsoDate): Promise<MetricTx[]> {
  await connection();
  return metricTxsInRange(await getDb(), from, to);
}

/** Ledger lines for the detailed P&L CSV: one per unsplit transaction, one per split line. */
export async function getLedgerLinesInRange(from: IsoDate, to: IsoDate) {
  await connection();
  const db = await getDb();
  const [rows, splits] = await Promise.all([
    db
      .select(txSelect)
      .from(transactions)
      .leftJoin(categories, eq(transactions.categoryId, categories.id))
      .leftJoin(stylists, eq(transactions.stylistId, stylists.id))
      .where(and(gte(transactions.date, from), lte(transactions.date, to)))
      .orderBy(asc(transactions.date), asc(transactions.createdAt)),
    splitLinesInRange(db, from, to),
  ]);
  return expandLedgerLines(rows, splits);
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
  return makeCategorizer(await getDb());
}

/** Today's date, computed per request (never baked in at build time). */
export async function requestToday() {
  await connection();
  return todayIso();
}

/**
 * The bank feed connection and its accounts. Deliberately selects no credential column:
 * the encrypted Access URL never leaves the sync code.
 */
export async function getBankConnection() {
  await connection();
  const db = await getDb();
  const [conn] = await db
    .select({
      id: bankConnections.id,
      label: bankConnections.label,
      cutoverDate: bankConnections.cutoverDate,
      lastSyncedAt: bankConnections.lastSyncedAt,
      lastError: bankConnections.lastError,
      lastErrorAt: bankConnections.lastErrorAt,
      createdAt: bankConnections.createdAt,
    })
    .from(bankConnections)
    .orderBy(asc(bankConnections.createdAt))
    .limit(1);
  if (!conn) return null;
  const accounts = await db
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      orgName: bankAccounts.orgName,
      balanceCents: bankAccounts.balanceCents,
      availableCents: bankAccounts.availableCents,
      balanceDate: bankAccounts.balanceDate,
      include: bankAccounts.include,
    })
    .from(bankAccounts)
    .where(eq(bankAccounts.connectionId, conn.id))
    .orderBy(asc(bankAccounts.name));
  return { ...conn, accounts, active: accounts.some((a) => a.include) };
}

export type BankConnectionView = NonNullable<Awaited<ReturnType<typeof getBankConnection>>>;

/** Banner text when the feed needs attention (error, or no good sync for 3+ days), else null. */
export async function getBankAttention(): Promise<string | null> {
  const c = await getBankConnection();
  if (!c) return null;
  return bankAttention({ lastSyncedAt: c.lastSyncedAt, lastError: c.lastError, createdAt: c.createdAt, active: c.active }, new Date());
}

/** Latest default start date suggestion for a new connection: day after the newest transaction, else 90 days ago. */
export async function getDefaultBankCutover() {
  const today = await requestToday();
  const db = await getDb();
  const [row] = await db.select({ d: transactions.date }).from(transactions).orderBy(desc(transactions.date)).limit(1);
  return defaultCutover(row?.d ?? null, today);
}
