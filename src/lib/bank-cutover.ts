import { addDays, formatDate, type IsoDate } from "./dates";

/**
 * CSV rows dated on/after an active bank feed's start date are covered by the feed. Bank
 * descriptions differ between the feed and a CSV, so the hash dedupe can't catch the overlap.
 */
export function splitByCutover<T extends { date: string }>(rows: T[], cutover: string | null): { kept: T[]; covered: T[] } {
  if (!cutover) return { kept: rows, covered: [] };
  const kept: T[] = [];
  const covered: T[] = [];
  for (const r of rows) (r.date >= cutover ? covered : kept).push(r);
  return { kept, covered };
}

export function coveredNote(n: number): string {
  return `${n} row${n === 1 ? " is" : "s are"} covered by your bank feed and ${n === 1 ? "was" : "were"} skipped.`;
}

/**
 * Where the CSV guard starts: the earlier of a live feed's start date and the earliest feed row in
 * the books (the start date may have moved later after a sync, or the feed been disconnected, and
 * those rows are still there). Null when there is neither.
 */
export function feedCoverageStart(cutover: IsoDate | null, earliestFeedRow: IsoDate | null): IsoDate | null {
  if (!cutover || !earliestFeedRow) return cutover ?? earliestFeedRow;
  return earliestFeedRow < cutover ? earliestFeedRow : cutover;
}

/** Why a feed start date can't overlap CSV-imported rows (same reason as above), or null when it doesn't. */
export function csvOverlapMessage(cutover: IsoDate, latestCsvDate: IsoDate | null): string | null {
  if (!latestCsvDate || cutover > latestCsvDate) return null;
  return `Your imported CSV goes through ${formatDate(latestCsvDate)}. Start the feed on ${formatDate(addDays(latestCsvDate, 1))} or later.`;
}

/**
 * Whether a new account selection or start date needs the next sync to fetch from the start date
 * again: the normal fetch only goes back a week from the last sync, so an earlier start date or a
 * newly included account would otherwise never be fetched.
 */
export function needsFullSync(
  before: { cutover: IsoDate; included: string[] },
  after: { cutover: IsoDate; included: string[] },
): boolean {
  if (after.cutover < before.cutover) return true;
  const had = new Set(before.included);
  return after.included.some((id) => !had.has(id));
}
