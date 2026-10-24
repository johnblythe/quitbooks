/**
 * Pure matching of CSV rows to hand-entered (manual) transactions, so an entry Lauren typed in when
 * a Zelle arrived isn't counted a second time when the same row shows up in the bank export.
 */

/** How many days apart a manual entry and the bank's posting date may be and still match. */
export const MATCH_WINDOW_DAYS = 3;

export type MatchRowInput = { line: number; date: string; amountCents: number };
export type ManualCandidate = { id: string; date: string; amountCents: number; description: string };
export type ManualMatch = { line: number; candidate: ManualCandidate; dayDistance: number };

/** Whole days between two YYYY-MM-DD strings (UTC maths, no time-zone drift). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

/**
 * One-to-one, greedy by closest date. Every (row, candidate) pair with the same amount and a date
 * within MATCH_WINDOW_DAYS is considered; the closest pairs are assigned first, so a manual entry is
 * never claimed by two CSV rows and a CSV row never claims two entries. Ties break on file order
 * (line), then on the older manual entry, then on id, so the result is deterministic.
 */
export function matchManualEntries(rows: MatchRowInput[], candidates: ManualCandidate[]): Map<number, ManualMatch> {
  const pairs: ManualMatch[] = [];
  const byAmount = new Map<number, ManualCandidate[]>();
  for (const c of candidates) {
    const list = byAmount.get(c.amountCents);
    if (list) list.push(c);
    else byAmount.set(c.amountCents, [c]);
  }
  for (const r of rows) {
    for (const c of byAmount.get(r.amountCents) ?? []) {
      const dayDistance = Math.abs(daysBetween(r.date, c.date));
      if (dayDistance <= MATCH_WINDOW_DAYS) pairs.push({ line: r.line, candidate: c, dayDistance });
    }
  }
  pairs.sort(
    (a, b) =>
      a.dayDistance - b.dayDistance ||
      a.line - b.line ||
      a.candidate.date.localeCompare(b.candidate.date) ||
      a.candidate.id.localeCompare(b.candidate.id),
  );
  const usedLines = new Set<number>();
  const usedCandidates = new Set<string>();
  const result = new Map<number, ManualMatch>();
  for (const p of pairs) {
    if (usedLines.has(p.line) || usedCandidates.has(p.candidate.id)) continue;
    usedLines.add(p.line);
    usedCandidates.add(p.candidate.id);
    result.set(p.line, p);
  }
  return result;
}
