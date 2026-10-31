/**
 * Bank feed sync (SimpleFIN). Server-side only: it decrypts the Access URL. Deliberately free of
 * Next/auth imports (like import-commit.ts) so it runs against any `Db`, including PGlite in tests;
 * `db`, `fetch`, the clock and the key are all injectable. Never log or return the Access URL.
 */
import { and, between, desc, eq, gt, inArray, isNull, max, min, sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { defaultCutover } from "./bank-status";
import { csvOverlapMessage, feedCoverageStart, needsFullSync } from "./bank-cutover";
import { decryptSecret, encryptSecret, loadBankKey } from "./bank-crypto";
import { addDays, formatDate, isIsoDate, todayIso, type IsoDate } from "./dates";
import { MATCH_WINDOW_DAYS, matchManualEntries, type ManualCandidate } from "./import-match";
import { makeCategorizer } from "./categorizer";
import {
  SimplefinError,
  claimSetupToken,
  classifyErrors,
  dateToFetchStartUnix,
  fetchAccountSet,
  mapAccount,
  mapTransaction,
  redactSecrets,
  splitWindows,
  unixToLocalDate,
  type FetchOptions,
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

/** `errors` fail the sync (red); `warnings` are shown in amber (see syncConnection). */
export type SyncResult = { inserted: number; linked: number; skipped: number; errors: string[]; warnings: string[] };

/** Re-fetch this many days before the last good sync to catch late-posting items. */
export const OVERLAP_DAYS = 7;
/**
 * A full fetch (first sync, or after the start date moves earlier) is one request per 45 days back,
 * and SimpleFIN allows 24 a day, so a start date that needs one can be at most this far back.
 */
export const MAX_BACKFILL_DAYS = 365;
/** "Sync now" is ignored if the last attempt was more recent than this (SimpleFIN allows 24 requests/day). */
export const MIN_SYNC_INTERVAL_MS = 15 * 60_000;
/**
 * SimpleFIN requests allowed per connection in any rolling 24 hours, counted from bank_sync_runs.
 * SimpleFIN allows 24 a day and can disable a link that goes over, so this leaves room to spare.
 */
export const DAILY_REQUEST_BUDGET = 20;
export const CATCH_UP_NOTE = "Catching up older history tomorrow: SimpleFIN allows only a few downloads a day.";
export const BUDGET_USED_NOTE = "Skipped this sync: SimpleFIN's daily download limit is used up. It catches up tomorrow.";
export const ACCOUNTS_NOT_READY = "SimpleFIN hasn't finished loading your bank yet. Try again in a few minutes.";
const MAX_ERROR_CHARS = 500;
const DAY_MS = 86_400_000;

type Executor = Pick<Db, "select" | "insert" | "update">;

export function emptyResult(): SyncResult {
  return { inserted: 0, linked: 0, skipped: 0, errors: [], warnings: [] };
}

function messageOf(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e));
}

/** First fetch day for a connection: max(cutover, last good sync - 7 days), in local dates. */
export function fetchStartDate(cutover: IsoDate, lastSyncedAt: Date | null): IsoDate {
  if (!lastSyncedAt) return cutover;
  const overlap = addDays(unixToLocalDate(lastSyncedAt.getTime() / 1000), -OVERLAP_DAYS);
  return overlap > cutover ? overlap : cutover;
}

export type SyncPlan = { requests: FetchOptions[]; catchUpLater: boolean };

/**
 * The SimpleFIN requests one sync makes, given how many the daily budget has left. Normally one
 * request per 45 days from fetchStartDate (or from the start date when a full fetch is pending).
 * When that doesn't fit, it fetches only the recent days (from the last sync, else the newest
 * windows that fit) and sets `catchUpLater`, so a full fetch stays pending for a later sync.
 */
export function planSync(
  c: Pick<schema.BankConnection, "cutoverDate" | "lastSyncedAt" | "fullSyncPending">,
  now: Date,
  remaining: number,
): SyncPlan {
  if (remaining <= 0) return { requests: [], catchUpLater: true };
  const end = Math.floor(now.getTime() / 1000);
  const windowsFrom = (d: IsoDate) => splitWindows(dateToFetchStartUnix(d), end);
  const asRequests = (w: [number, number][]) => w.map(([startUnix, endUnix]) => ({ startUnix, endUnix }));
  const wanted = windowsFrom(c.fullSyncPending ? c.cutoverDate : fetchStartDate(c.cutoverDate, c.lastSyncedAt));
  // A start date in the future has no window yet: still fetch balances, so the accounts are seen.
  if (!wanted.length) return { requests: [{ balancesOnly: true }], catchUpLater: false };
  if (wanted.length <= remaining) return { requests: asRequests(wanted), catchUpLater: false };
  const recent = c.lastSyncedAt ? windowsFrom(fetchStartDate(c.cutoverDate, c.lastSyncedAt)) : wanted;
  return { requests: asRequests(recent.slice(-remaining)), catchUpLater: true };
}

/** SimpleFIN requests this connection made (or reserved) in the 24 hours before `now`. */
export async function requestsInLastDay(db: Pick<Db, "select">, connectionId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${bankSyncRuns.requests}), 0)::int` })
    .from(bankSyncRuns)
    .where(and(eq(bankSyncRuns.connectionId, connectionId), gt(bankSyncRuns.startedAt, new Date(now.getTime() - DAY_MS))));
  return row?.n ?? 0;
}

/**
 * Records a run that reserves up to `plan(remaining).requests.length` requests, then re-counts, so
 * two runs starting together can't both spend the last of the budget; the later one shrinks.
 */
async function reserveRequests(
  db: Db,
  connectionId: string,
  now: Date,
  plan: (remaining: number) => SyncPlan,
): Promise<{ runId: string; plan: SyncPlan }> {
  const remaining = DAILY_REQUEST_BUDGET - (await requestsInLastDay(db, connectionId, now));
  let chosen = plan(remaining);
  const [run] = await db
    .insert(bankSyncRuns)
    .values({ connectionId, startedAt: now, requests: chosen.requests.length })
    .returning({ id: bankSyncRuns.id });
  const over = (await requestsInLastDay(db, connectionId, now)) - DAILY_REQUEST_BUDGET;
  if (over > 0) {
    chosen = plan(chosen.requests.length - over);
    await db.update(bankSyncRuns).set({ requests: chosen.requests.length }).where(eq(bankSyncRuns.id, run.id));
  }
  return { runId: run.id, plan: chosen };
}

/** Up to 3 attempts with a short backoff, for a write that must not be lost to a brief DB blip. */
async function withRetry<T>(fn: () => Promise<T>, delaysMs = [100, 400]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delaysMs.length) throw e;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

// ---------- connect / configure ----------

/**
 * Claims a setup token (one-time), stores the encrypted Access URL right away, then fetches and
 * stores the accounts it reports (none included yet). The caller then picks accounts and the start
 * date. The key is loaded and the database read once before the claim, so a missing key or a down
 * database fails without spending the token; the one write after the claim is retried (3 attempts).
 * If the account fetch fails afterwards, the connection is kept with `accountsError` (also in its
 * last_error) and refreshBankAccounts can retry without a new token.
 */
export async function connectBank(
  deps: SyncDeps,
  token: string,
  opts: { label?: string } = {},
): Promise<{ connectionId: string; accountsError?: string }> {
  const { db, fetchFn } = deps;
  const key = deps.key ?? loadBankKey();
  const [latest] = await db.select({ d: transactions.date }).from(transactions).orderBy(desc(transactions.date)).limit(1);
  const cutover = defaultCutover(latest?.d ?? null, todayIso());

  const accessUrl = await claimSetupToken(token, fetchFn);
  const values = {
    accessUrlEnc: encryptSecret(accessUrl, key),
    label: (opts.label ?? "").trim().slice(0, 60) || "BMO",
    cutoverDate: cutover,
  };
  let conn: { id: string };
  try {
    [conn] = await withRetry(() => db.insert(bankConnections).values(values).returning({ id: bankConnections.id }));
  } catch {
    throw new SimplefinError("Couldn't save the bank link, and the setup token is now used up. Make a new token at SimpleFIN Bridge and try again.");
  }
  try {
    await refreshBankAccounts({ ...deps, key }, conn.id);
  } catch (e) {
    return { connectionId: conn.id, accountsError: messageOf(e) };
  }
  return { connectionId: conn.id };
}

/**
 * Fetches the account list (one balances-only request, counted in the daily budget) and stores it
 * under this connection. An account seen before, under a connection since disconnected, is
 * re-attached rather than added again, so its feed rows still dedupe. Re-attached accounts start out
 * not included. No accounts yet (the bank is still loading at SimpleFIN) is a failure, with
 * SimpleFIN's own messages when it sent any. On failure the reason is saved in last_error and rethrown.
 */
export async function refreshBankAccounts(deps: SyncDeps, connectionId: string): Promise<void> {
  const { db, fetchFn } = deps;
  const now = deps.now ?? new Date();
  const [conn] = await db
    .select({ enc: bankConnections.accessUrlEnc })
    .from(bankConnections)
    .where(eq(bankConnections.id, connectionId));
  if (!conn) throw new SimplefinError("Bank connection not found.");
  let runId: string | undefined;
  try {
    const reserved = await reserveRequests(db, connectionId, now, (remaining) => ({
      requests: remaining > 0 ? [{ balancesOnly: true }] : [],
      catchUpLater: false,
    }));
    runId = reserved.runId;
    if (!reserved.plan.requests.length) throw new SimplefinError("SimpleFIN's daily download limit is used up. Try again tomorrow.");
    const set = await fetchAccountSet(decryptSecret(conn.enc, deps.key), { balancesOnly: true }, fetchFn);
    if (!set.accounts.length) {
      const said = classifyErrors(set, { accountIds: new Set() });
      const messages = [...said.errors, ...said.unattributed, ...said.others];
      throw new SimplefinError(messages.length ? joinErrors(messages) : ACCOUNTS_NOT_READY);
    }
    await db.transaction(async (tx) => {
      for (const a of set.accounts) {
        const m = mapAccount(a, set);
        const values = {
          connectionId,
          connId: m.connId,
          name: m.name,
          orgName: m.orgName,
          currency: m.currency,
          balanceCents: m.balanceCents,
          availableCents: m.availableCents,
          balanceDate: m.balanceDate,
        };
        await tx
          .insert(bankAccounts)
          .values({ externalId: m.externalId, ...values })
          .onConflictDoUpdate({
            target: bankAccounts.externalId,
            set: {
              ...values,
              include: sql`case when ${bankAccounts.connectionId} = ${connectionId} then ${bankAccounts.include} else false end`,
            },
          });
      }
      await tx.update(bankConnections).set({ lastError: null, lastErrorAt: null }).where(eq(bankConnections.id, connectionId));
    });
    await db.update(bankSyncRuns).set({ finishedAt: new Date() }).where(eq(bankSyncRuns.id, runId));
  } catch (e) {
    const message = messageOf(e);
    if (runId) await db.update(bankSyncRuns).set({ finishedAt: new Date(), error: message }).where(eq(bankSyncRuns.id, runId));
    await db
      .update(bankConnections)
      .set({ lastError: message, lastErrorAt: now })
      .where(eq(bankConnections.id, connectionId));
    throw new SimplefinError(message);
  }
}

/**
 * Saves which accounts to sync and the start date. Syncing needs at least one included account.
 * Rejects a start date on or before the last CSV-imported row (the feed would double those days).
 * An earlier start date or a newly included account makes the next sync a full fetch from the start
 * date (dedupe makes the re-fetch safe), which can go back at most MAX_BACKFILL_DAYS.
 */
export async function saveBankSelection(
  db: Db,
  connectionId: string,
  input: { includeAccountIds: string[]; cutoverDate: IsoDate },
  opts: { today?: IsoDate } = {},
): Promise<void> {
  if (!isIsoDate(input.cutoverDate)) throw new SimplefinError("Pick a valid start date.");
  const today = opts.today ?? todayIso();
  await db.transaction(async (tx) => {
    const [conn] = await tx
      .select({ cutoverDate: bankConnections.cutoverDate, lastSyncedAt: bankConnections.lastSyncedAt, fullSyncPending: bankConnections.fullSyncPending })
      .from(bankConnections)
      .where(eq(bankConnections.id, connectionId));
    if (!conn) throw new SimplefinError("Bank connection not found.");
    const [csv] = await tx.select({ d: max(transactions.date) }).from(transactions).where(eq(transactions.source, "csv"));
    const overlap = csvOverlapMessage(input.cutoverDate, csv?.d ?? null);
    if (overlap) throw new SimplefinError(overlap);

    const accounts = await tx
      .select({ id: bankAccounts.id, include: bankAccounts.include })
      .from(bankAccounts)
      .where(eq(bankAccounts.connectionId, connectionId));
    const valid = new Set(accounts.map((a) => a.id));
    const wanted = input.includeAccountIds.filter((id) => valid.has(id));
    const refetch = needsFullSync(
      { cutover: conn.cutoverDate, included: accounts.filter((a) => a.include).map((a) => a.id) },
      { cutover: input.cutoverDate, included: wanted },
    );
    const oldest = addDays(today, -MAX_BACKFILL_DAYS);
    if ((refetch || conn.fullSyncPending || !conn.lastSyncedAt) && input.cutoverDate < oldest) {
      throw new SimplefinError(
        `SimpleFIN allows only a few downloads a day, so the feed can start at most a year back. Pick ${formatDate(oldest)} or later.`,
      );
    }

    await tx.update(bankAccounts).set({ include: false }).where(eq(bankAccounts.connectionId, connectionId));
    if (wanted.length) await tx.update(bankAccounts).set({ include: true }).where(inArray(bankAccounts.id, wanted));
    await tx
      .update(bankConnections)
      .set({ cutoverDate: input.cutoverDate, ...(refetch ? { fullSyncPending: true } : {}) })
      .where(eq(bankConnections.id, connectionId));
  });
}

/**
 * Deletes the connection and the encrypted URL. Its accounts are kept, detached, so feed rows stay
 * tied to them and connecting the same SimpleFIN accounts again doesn't import everything twice.
 * Imported transactions stay.
 */
export async function disconnectBank(db: Db, connectionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(bankAccounts).set({ include: false }).where(eq(bankAccounts.connectionId, connectionId));
    await tx.delete(bankConnections).where(eq(bankConnections.id, connectionId));
  });
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

/**
 * First date the CSV import skips: the earlier of a live feed's start date and the earliest feed row
 * in the books. Feed rows stay after a disconnect, so the guard does too. Null with neither.
 */
export async function csvCutoverDate(db: Pick<Db, "select">): Promise<IsoDate | null> {
  const cutover = await activeCutoverDate(db);
  const [row] = await db.select({ d: min(transactions.date) }).from(transactions).where(eq(transactions.source, "bank_sync"));
  return feedCoverageStart(cutover, row?.d ?? null);
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
          ...(balance.connId ? { connId: balance.connId } : {}),
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

/**
 * Syncs one connection. Never throws for provider/HTTP problems. What SimpleFIN reports decides the
 * outcome:
 * - a problem with our accounts (an included account missing from the response, or an error naming
 *   one of them or its bank login): `errors`, saved in last_error (red), and last_synced_at holds so
 *   the next sync fetches the same days again. A missing account's error also carries every message
 *   SimpleFIN sent, since the real reason ("Please re-authenticate") may not name the account;
 * - an error that names nothing: a warning (amber), and last_synced_at still holds;
 * - an error about other accounts or logins on the same Bridge: a warning, and the sync counts.
 * Requests stay within DAILY_REQUEST_BUDGET: a full fetch that doesn't fit is done on a later sync.
 */
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

  const { runId, plan } = await reserveRequests(db, connectionId, now, (remaining) => planSync(conn, now, remaining));
  if (!plan.requests.length) {
    result.warnings.push(BUDGET_USED_NOTE);
    await db.update(bankConnections).set({ lastWarning: BUDGET_USED_NOTE }).where(eq(bankConnections.id, connectionId));
    await db.update(bankSyncRuns).set({ finishedAt: new Date(), error: BUDGET_USED_NOTE }).where(eq(bankSyncRuns.id, runId));
    return result;
  }

  let made = 0;
  let unattributed = 0;
  try {
    const accessUrl = decryptSecret(conn.accessUrlEnc, deps.key);
    const ours = {
      accountIds: new Set(accounts.map((a) => a.externalId)),
      connIds: new Set(accounts.flatMap((a) => (a.connId ? [a.connId] : []))),
    };
    const said = { errors: [] as string[], unattributed: [] as string[], others: [] as string[] };
    const addUnique = (list: string[], msgs: string[]) => {
      for (const m of msgs) if (!list.includes(m)) list.push(m);
    };

    // Network first, DB writes after: no request is ever made while a transaction is open.
    const txByAccount = new Map<string, Map<string, MappedTx>>();
    const accountInfo = new Map<string, SfAccount>();
    let lastSet: SfAccountSet | undefined;
    for (const req of plan.requests) {
      made++;
      const set = await fetchAccountSet(accessUrl, req, fetchFn);
      lastSet = set;
      const c = classifyErrors(set, ours);
      addUnique(said.errors, c.errors);
      addUnique(said.unattributed, c.unattributed);
      addUnique(said.others, c.others);
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

    const missing = accounts.filter((a) => !accountInfo.has(a.externalId));
    if (missing.length) {
      result.errors.push(...said.errors, ...said.unattributed, ...said.others);
      for (const a of missing) result.errors.push(`Account "${a.name}" wasn't returned by SimpleFIN.`);
    } else {
      result.errors.push(...said.errors);
      result.warnings.push(...said.unattributed, ...said.others);
      unattributed = said.unattributed.length;
    }

    const categorize = await makeCategorizer(db);
    for (const acct of accounts) {
      const info = accountInfo.get(acct.externalId);
      if (!info) continue;
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
    result.errors.push(messageOf(e));
  }
  if (plan.catchUpLater) result.warnings.push(CATCH_UP_NOTE);

  const failed = result.errors.length > 0;
  const hold = failed || unattributed > 0;
  const error = failed ? joinErrors(result.errors) : null;
  const lastWarning = result.warnings.length ? joinErrors(result.warnings) : null;
  // A full fetch stays pending until one completes cleanly; a budget-trimmed sync makes one pending.
  const pending = plan.catchUpLater ? { fullSyncPending: true } : !hold && conn.fullSyncPending ? { fullSyncPending: false } : {};
  await db
    .update(bankConnections)
    .set(
      failed
        ? { lastError: error, lastErrorAt: now, lastWarning, ...pending }
        : { ...(hold ? {} : { lastSyncedAt: now }), lastError: null, lastErrorAt: null, lastWarning, ...pending },
    )
    .where(eq(bankConnections.id, connectionId));
  await db
    .update(bankSyncRuns)
    .set({ finishedAt: new Date(), inserted: result.inserted, linked: result.linked, skipped: result.skipped, error, requests: made })
    .where(eq(bankSyncRuns.id, runId));
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
export async function syncAllConnections(
  deps: SyncDeps,
): Promise<{ connections: number } & Omit<SyncResult, "errors" | "warnings"> & { errors: number; warnings: number }> {
  const conns = await deps.db.select({ id: bankConnections.id }).from(bankConnections);
  const total = { connections: conns.length, inserted: 0, linked: 0, skipped: 0, errors: 0, warnings: 0 };
  for (const c of conns) {
    const r = await syncConnection(deps, c.id);
    total.inserted += r.inserted;
    total.linked += r.linked;
    total.skipped += r.skipped;
    total.errors += r.errors.length;
    total.warnings += r.warnings.length;
  }
  return total;
}
