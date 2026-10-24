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
