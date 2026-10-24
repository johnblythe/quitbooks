/**
 * Date helpers. Dates are handled as ISO "YYYY-MM-DD" strings (matching Postgres `date`)
 * to avoid time-zone drift. Months are "YYYY-MM".
 */

export type IsoDate = string; // YYYY-MM-DD
export type MonthKey = string; // YYYY-MM

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * Parses common bank date formats into YYYY-MM-DD.
 * Supports: YYYY-MM-DD, MM/DD/YYYY, M/D/YYYY, MM/DD/YY, MM-DD-YYYY.
 */
export function parseBankDate(input: string): IsoDate | null {
  const s = input.trim();
  if (isIsoDate(s)) return s;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return normalize(+iso[1], +iso[2], +iso[3]);

  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s);
  if (us) {
    let year = +us[3];
    if (us[3].length === 2) year += year >= 70 ? 1900 : 2000;
    return normalize(year, +us[1], +us[2]);
  }
  return null;
}

function normalize(y: number, m: number, d: number): IsoDate | null {
  const out = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(out) ? out : null;
}

export function monthOf(date: IsoDate): MonthKey {
  return date.slice(0, 7);
}

export function monthStart(month: MonthKey): IsoDate {
  return `${month}-01`;
}

export function monthEnd(month: MonthKey): IsoDate {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

/** Adds (or subtracts) whole days to a YYYY-MM-DD date. */
export function addDays(date: IsoDate, delta: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Inclusive list of months from `from` to `to`. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** Today's date in the salon's time zone (Indianapolis). */
export function todayIso(timeZone = "America/Indiana/Indianapolis"): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

export function formatMonth(month: MonthKey, style: "long" | "short" = "long"): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: style,
    year: style === "long" ? "numeric" : "2-digit",
    timeZone: "UTC",
  });
}

export function formatDate(date: IsoDate): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
