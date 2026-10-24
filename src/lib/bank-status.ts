import { addDays, type IsoDate } from "./dates";

/** Pure helpers for the bank feed UI: attention banner and the books-vs-bank reconciliation line. */

export const STALE_DAYS = 3;
export const BRIDGE_FIX_URL = "https://beta-bridge.simplefin.org";

export type BankHealthInput = {
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  /** False while setup isn't finished (no account chosen): nothing to be stale about. */
  active: boolean;
};

/** Message for the "needs attention" banner, or null when the feed is healthy. */
export function bankAttention(c: BankHealthInput, now: Date): string | null {
  if (!c.active) return null;
  if (c.lastError) return c.lastError;
  const ref = c.lastSyncedAt ?? c.createdAt;
  const ageDays = (now.getTime() - ref.getTime()) / 86_400_000;
  if (ageDays > STALE_DAYS) {
    return c.lastSyncedAt
      ? `The last successful sync was more than ${STALE_DAYS} days ago.`
      : `It has never synced successfully.`;
  }
  return null;
}

export type Reconciliation =
  | { kind: "match"; bankCents: number; booksCents: number }
  | { kind: "off"; bankCents: number; booksCents: number; diffCents: number };

/** diffCents = books - bank; positive means the books show more than the bank. */
export function reconcile(bankCents: number, booksCents: number): Reconciliation {
  return bankCents === booksCents
    ? { kind: "match", bankCents, booksCents }
    : { kind: "off", bankCents, booksCents, diffCents: booksCents - bankCents };
}

/** Default start date for a new connection: the day after the latest transaction, else 90 days ago. */
export function defaultCutover(latestTxDate: IsoDate | null, today: IsoDate): IsoDate {
  return latestTxDate ? addDays(latestTxDate, 1) : addDays(today, -90);
}
