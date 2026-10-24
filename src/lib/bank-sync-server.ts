/**
 * Bank feed sync (SimpleFIN). Server-side only: it decrypts the Access URL. Deliberately free of
 * Next/auth imports (like import-commit.ts) so it runs against any `Db`, including PGlite in tests;
 * `db`, `fetch`, the clock and the key are all injectable. Never log or return the Access URL.
 */
import { and, between, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { defaultCutover } from "./bank-status";
import { decryptSecret, encryptSecret } from "./bank-crypto";
import { addDays, isIsoDate, todayIso, type IsoDate } from "./dates";
import { MATCH_WINDOW_DAYS, matchManualEntries, type ManualCandidate } from "./import-match";
import { makeCategorizer } from "./categorizer";
import {
  SimplefinError,
  claimSetupToken,
  collectErrors,
  dateToFetchStartUnix,
  fetchAccountSet,
  mapAccount,
  mapTransaction,
  redactSecrets,
  splitWindows,
  unixToLocalDate,
  type MappedTx,
  type SfAccount,
  type SfAccountSet,
} from "./simplefin";

const { bankConnections, bankAccounts, bankSyncRuns, transactions } = schema;

export type SyncDeps = {
  db: Db;
  fetchFn?: typeof fetch;
  now?: Date;
  /** AES key; defaults to BANK_TOKEN_KEY from the environment. */
  key?: Buffer;
};

export type SyncResult = { inserted: number; linked: number; skipped: number; errors: string[] };

/** Re-fetch this many days before the last good sync to catch late-posting items. */
export const OVERLAP_DAYS = 7;
/** "Sync now" is ignored if the last attempt was more recent than this (SimpleFIN allows 24 requests/day). */
export const MIN_SYNC_INTERVAL_MS = 15 * 60_000;
const MAX_ERROR_CHARS = 500;

type Executor = Pick<Db, "select" | "insert" | "update">;

export function emptyResult(): SyncResult {
  return { inserted: 0, linked: 0, skipped: 0, errors: [] };
}

/** First fetch day for a connection: max(cutover, last good sync - 7 days), in local dates. */
export function fetchStartDate(cutover: IsoDate, lastSyncedAt: Date | null): IsoDate {
  if (!lastSyncedAt) return cutover;
  const overlap = addDays(unixToLocalDate(lastSyncedAt.getTime() / 1000), -OVERLAP_DAYS);
  return overlap > cutover ? overlap : cutover;
}

// ---------- connect / configure ----------

/**
 * Claims a setup token (one-time), stores the encrypted Access URL, and stores the accounts it
 * reports (none included yet). The caller then picks accounts and the start date.
 */
export async function connectBank(
  deps: SyncDeps,
  token: string,
  opts: { label?: string } = {},
): Promise<{ connectionId: string }> {
  const { db, fetchFn } = deps;
  const accessUrl = await claimSetupToken(token, fetchFn);
  // Encrypt first so a missing key fails before anything is stored.
  const enc = encryptSecret(accessUrl, deps.key);
  const set = await fetchAccountSet(accessUrl, { balancesOnly: true }, fetchFn);

  const [latest] = await db.select({ d: transactions.date }).from(transactions).orderBy(desc(transactions.date)).limit(1);
  const today = todayIso();
  const cutover = defaultCutover(latest?.d ?? null, today);

  return db.transaction(async (tx) => {
    const [conn] = await tx
      .insert(bankConnections)
      .values({
        accessUrlEnc: enc,
        label: (opts.label ?? "").trim().slice(0, 60) || "BMO",
        cutoverDate: cutover,
      })
      .returning({ id: bankConnections.id });
    for (const a of set.accounts) {
      const m = mapAccount(a, set);
      await tx.insert(bankAccounts).values({
        connectionId: conn.id,
        externalId: m.externalId,
        name: m.name,
        orgName: m.orgName,
        currency: m.currency,
        balanceCents: m.balanceCents,
        availableCents: m.availableCents,
        balanceDate: m.balanceDate,
      });
    }
    return { connectionId: conn.id };
  });
}

/** Saves which accounts to sync and the start date. Syncing needs at least one included account. */
export async function saveBankSelection(
  db: Db,
  connectionId: string,
  input: { includeAccountIds: string[]; cutoverDate: IsoDate },
): Promise<void> {
  if (!isIsoDate(input.cutoverDate)) throw new SimplefinError("Pick a valid start date.");
  await db.transaction(async (tx) => {
    const accounts = await tx.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.connectionId, connectionId));
    const valid = new Set(accounts.map((a) => a.id));
    const wanted = input.includeAccountIds.filter((id) => valid.has(id));
    await tx.update(bankAccounts).set({ include: false }).where(eq(bankAccounts.connectionId, connectionId));
    if (wanted.length) await tx.update(bankAccounts).set({ include: true }).where(inArray(bankAccounts.id, wanted));
    await tx.update(bankConnections).set({ cutoverDate: input.cutoverDate }).where(eq(bankConnections.id, connectionId));
  });
}

/** Deletes the connection, its accounts and the encrypted URL. Imported transactions stay. */
export async function disconnectBank(db: Db, connectionId: string): Promise<void> {
  await db.delete(bankConnections).where(eq(bankConnections.id, connectionId));
}

/** Earliest start date among active (account-selected) connections, or null when there is no live feed. */
export async function activeCutoverDate(db: Pick<Db, "select">): Promise<IsoDate | null> {
  const rows = await db
    .select({ d: bankConnections.cutoverDate })
    .from(bankConnections)
    .innerJoin(bankAccounts, and(eq(bankAccounts.connectionId, bankConnections.id), eq(bankAccounts.include, true)));
  const dates = rows.map((r) => r.d).sort();
  return dates[0] ?? null;
}

// ---------- sync ----------

async function findManualCandidates(
  db: Executor,
  rows: MappedTx[],
): Promise<ManualCandidate[]> {
  if (!rows.length) return [];
  const dates = rows.map((r) => r.date).sort();
  const from = addDays(dates[0], -MATCH_WINDOW_DAYS);
  const to = addDays(dates[dates.length - 1], MATCH_WINDOW_DAYS);
  const amounts = [...new Set(rows.map((r) => r.amountCents))];
  const found: ManualCandidate[] = [];
  for (let i = 0; i < amounts.length; i += 500) {
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
          isNull(transactions.bankAccountId),
          inArray(transactions.amountCents, amounts.slice(i, i + 500)),
          between(transactions.date, from, to),
        ),
      );
    found.push(...res);
  }
  return found;
}

type Categorizer = Awaited<ReturnType<typeof makeCategorizer>>;

/** Writes one account's rows in ONE transaction: link to manual entries, insert the rest, update the balance. */
async function applyAccount(
  db: Db,
  acct: { id: string },
  mapped: MappedTx[],
  cutover: IsoDate,
  categorize: Categorizer,
  balance: ReturnType<typeof mapAccount>,
): Promise<{ inserted: number; linked: number; skipped: number }> {
  return db.transaction(async (tx) => {
    let skipped = 0;
    const inWindow = mapped.filter((t) => {
      if (t.date < cutover) {
        skipped++;
        return false;
      }
      return true;
    });

    const existing = new Set<string>();
    for (let i = 0; i < inWindow.length; i += 500) {
      const ids = inWindow.slice(i, i + 500).map((t) => t.externalId);
      const found = await tx
        .select({ e: transactions.externalId })
        .from(transactions)
        .where(and(eq(transactions.bankAccountId, acct.id), inArray(transactions.externalId, ids)));
      found.forEach((r) => r.e && existing.add(r.e));
    }
    const fresh = inWindow.filter((t) => !existing.has(t.externalId));
    skipped += inWindow.length - fresh.length;

    const candidates = await findManualCandidates(tx, fresh);
    const byLine = new Map(fresh.map((t, i) => [i, t]));
    const matches = matchManualEntries(
      fresh.map((t, i) => ({ line: i, date: t.date, amountCents: t.amountCents })),
      candidates,
    );

    let linked = 0;
    const toInsert: MappedTx[] = [];
    for (const [line, t] of byLine) {
      const m = matches.get(line);
      if (m) {
        const res = await tx
          .update(transactions)
          .set({ bankAccountId: acct.id, externalId: t.externalId, updatedAt: new Date() })
          .where(
            and(
              eq(transactions.id, m.candidate.id),
              eq(transactions.source, "manual"),
              isNull(transactions.bankAccountId),
              isNull(transactions.dedupeHash),
            ),
          )
          .returning({ id: transactions.id });
        if (res.length) {
          linked++;
          continue;
        }
      }
      toInsert.push(t);
    }

    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += 200) {
      const chunk = toInsert.slice(i, i + 200).map((t) => {
        const auto = categorize({ date: t.date, amountCents: t.amountCents, description: t.description });
        return {
          date: t.date,
          amountCents: t.amountCents,
          description: t.description,
          categoryId: auto.categoryId,
          stylistId: auto.stylistId,
          source: "bank_sync" as const,
          bankAccountId: acct.id,
          externalId: t.externalId,
        };
      });
      const res = await tx
        .insert(transactions)
        .values(chunk)
        .onConflictDoNothing({ target: [transactions.bankAccountId, transactions.externalId] })
        .returning({ id: transactions.id });
      inserted += res.length;
      skipped += chunk.length - res.length;
    }

    if (balance.balanceCents !== null) {
      await tx
        .update(bankAccounts)
        .set({
          balanceCents: balance.balanceCents,
          availableCents: balance.availableCents,
          balanceDate: balance.balanceDate,
          name: balance.name,
        })
        .where(eq(bankAccounts.id, acct.id));
    }
    return { inserted, linked, skipped };
  });
}

function joinErrors(errors: string[]): string {
  const text = redactSecrets(errors.join("; "));
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

/** Syncs one connection. Never throws for provider/HTTP problems: they land in `errors` and `last_error`. */
export async function syncConnection(deps: SyncDeps, connectionId: string): Promise<SyncResult> {
  const { db, fetchFn } = deps;
  const now = deps.now ?? new Date();
  const result = emptyResult();

  const [conn] = await db.select().from(bankConnections).where(eq(bankConnections.id, connectionId));
  if (!conn) {
    result.errors.push("Bank connection not found.");
    return result;
  }
  const accounts = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.connectionId, connectionId), eq(bankAccounts.include, true)));
  if (!accounts.length) return result;

  const [run] = await db.insert(bankSyncRuns).values({ connectionId, startedAt: now }).returning({ id: bankSyncRuns.id });

  try {
    const accessUrl = decryptSecret(conn.accessUrlEnc, deps.key);
    const startDate = fetchStartDate(conn.cutoverDate, conn.lastSyncedAt);
    const startUnix = dateToFetchStartUnix(startDate);
    const endUnix = Math.floor(now.getTime() / 1000);

    // Network first, DB writes after: no request is ever made while a transaction is open.
    const txByAccount = new Map<string, Map<string, MappedTx>>();
    const accountInfo = new Map<string, SfAccount>();
    let lastSet: SfAccountSet | undefined;
    for (const [s, e] of splitWindows(startUnix, endUnix)) {
      const set = await fetchAccountSet(accessUrl, { startUnix: s, endUnix: e }, fetchFn);
      lastSet = set;
      for (const msg of collectErrors(set)) if (!result.errors.includes(msg)) result.errors.push(msg);
      for (const a of set.accounts) {
        accountInfo.set(String(a.id), a);
        const bucket = txByAccount.get(String(a.id)) ?? new Map<string, MappedTx>();
        for (const t of a.transactions ?? []) {
          const m = mapTransaction(t);
          if (m) bucket.set(m.externalId, m);
          else result.skipped++; // pending or unusable
        }
        txByAccount.set(String(a.id), bucket);
      }
    }

    const categorize = await makeCategorizer(db);
    for (const acct of accounts) {
      const info = accountInfo.get(acct.externalId);
      if (!info) {
        result.errors.push(`Account "${acct.name}" wasn't returned by SimpleFIN.`);
        continue;
      }
      const r = await applyAccount(
        db,
        acct,
        [...(txByAccount.get(acct.externalId)?.values() ?? [])],
        conn.cutoverDate,
        categorize,
        mapAccount(info, lastSet),
      );
      result.inserted += r.inserted;
      result.linked += r.linked;
      result.skipped += r.skipped;
    }
  } catch (e) {
    const msg = e instanceof SimplefinError || e instanceof Error ? e.message : String(e);
    result.errors.push(redactSecrets(msg));
  }

  const failed = result.errors.length > 0;
  const error = failed ? joinErrors(result.errors) : null;
  await db
    .update(bankConnections)
    .set(failed ? { lastError: error, lastErrorAt: now } : { lastSyncedAt: now, lastError: null, lastErrorAt: null })
    .where(eq(bankConnections.id, connectionId));
  await db
    .update(bankSyncRuns)
    .set({ finishedAt: new Date(), inserted: result.inserted, linked: result.linked, skipped: result.skipped, error })
    .where(eq(bankSyncRuns.id, run.id));
  return result;
}

/** "Sync now": skipped when the last attempt (good or bad) was under 15 minutes ago. */
export async function syncConnectionThrottled(
  deps: SyncDeps,
  connectionId: string,
): Promise<{ throttled: true; retryInMinutes: number } | ({ throttled: false } & SyncResult)> {
  const now = deps.now ?? new Date();
  const [conn] = await deps.db
    .select({ s: bankConnections.lastSyncedAt, e: bankConnections.lastErrorAt })
    .from(bankConnections)
    .where(eq(bankConnections.id, connectionId));
  const last = Math.max(conn?.s?.getTime() ?? 0, conn?.e?.getTime() ?? 0);
  if (last && now.getTime() - last < MIN_SYNC_INTERVAL_MS) {
    return { throttled: true, retryInMinutes: Math.ceil((MIN_SYNC_INTERVAL_MS - (now.getTime() - last)) / 60_000) };
  }
  return { throttled: false, ...(await syncConnection(deps, connectionId)) };
}

/** Cron entry: every connection, counts only. */
export async function syncAllConnections(deps: SyncDeps): Promise<{ connections: number } & Omit<SyncResult, "errors"> & { errors: number }> {
  const conns = await deps.db.select({ id: bankConnections.id }).from(bankConnections);
  const total = { connections: conns.length, inserted: 0, linked: 0, skipped: 0, errors: 0 };
  for (const c of conns) {
    const r = await syncConnection(deps, c.id);
    total.inserted += r.inserted;
    total.linked += r.linked;
    total.skipped += r.skipped;
    total.errors += r.errors.length;
  }
  return total;
}
