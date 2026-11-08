/**
 * Reads a QuickBooks Online "Profit and Loss by Month" CSV export: the QuickBooks side of
 * `npm run qbo:compare`. Pure, so every layout it tolerates is unit-tested (qbo-pnl.test.ts).
 *
 * Rule: every dollar in the file is either read into an account, or the run can't say MATCH. A row
 * the parser can't place throws (QboPnlParseError, with the line). A file whose own totals don't add
 * up is read, but each disagreement is a blocking `problem`.
 *
 * The layout is written from memory and unverified against a real export. What it assumes:
 * - Preamble lines (company, report title, date range, "Cash Basis") come before a header row whose
 *   cells after the first are month labels plus an optional "Total" column, e.g. `,Jan 2026,...,Total`.
 *   Labels may be "Jan 2026", "January 2026", Excel's "Jan-26" / "Jan 26", or a partial month such as
 *   "Oct 1-15, 2026". Months are consecutive; only the first and last may be partial.
 * - The first column holds the row label; amounts sit under the month headers and nowhere else. A
 *   column that is blank on every line (e.g. a leading empty column) is dropped first.
 * - Sections are headings with no amounts (Income, Cost of Goods Sold, Expenses, Other Income,
 *   Other Expenses), each closed by "Total X" or "Total for X".
 * - A parent account with sub-accounts is a heading (with or without its own amounts) closed by its
 *   own Total row, or is shown by indentation, or the account name is written "Parent:Child".
 * - Gross Profit, Net Operating Income, Net Other Income and Net Income (each optionally followed by
 *   "(Loss)") are summary rows: kept as cross-checks, never as accounts.
 * - Income and expense amounts are both positive; a refund in an expense account is negative. After
 *   a round trip through Excel, a cell that is only a dash (" - ", "$ -") is zero, and "$ (12.00)" is
 *   negative.
 * - The "Cash Basis ..." footer comes after the last section. Its date stamp may be on a line of its
 *   own after Net Income.
 * - The Total column is ignored for the comparison (it's recomputed), but checked against the months.
 */
import Papa from "papaparse";
import { addMonths, monthEnd, type IsoDate, type MonthKey } from "./dates";
import { categoryKey } from "./import-categories";
import { formatCents, parseAmountToCents } from "./money";

export type QboSection = "income" | "cogs" | "expenses" | "otherIncome" | "otherExpenses";

export const SECTION_LABEL: Record<QboSection, string> = {
  income: "Income",
  cogs: "Cost of Goods Sold",
  expenses: "Expenses",
  otherIncome: "Other Income",
  otherExpenses: "Other Expenses",
};

/** Income-type sections hold money in; the rest hold money out. Both are positive in the report. */
export function sectionDirection(s: QboSection): "income" | "expense" {
  return s === "income" || s === "otherIncome" ? "income" : "expense";
}

/** One month column. A partial month ("Oct 1-15, 2026") covers only part of its month. */
export type QboColumn = { label: string; month: MonthKey; from: IsoDate; to: IsoDate; partial: boolean };

export type QboAccount = {
  /** The leaf name: "Electric" for "Utilities:Electric" or an indented Electric under Utilities. */
  name: string;
  /** Parents first, leaf last: ["Utilities", "Electric"]. A top-level account is [name]. */
  path: string[];
  section: QboSection;
  /** Amount per month, positive as QuickBooks shows it. Blank cells are 0. */
  cents: Record<MonthKey, number>;
  /** Row in the file (1-based), for messages. */
  line: number;
};

export type QboCheckName = "Gross Profit" | "Net Operating Income" | "Net Other Income" | "Net Income";

/**
 * The file disagrees with itself (a Total or summary row vs its accounts), or can't be trusted as a
 * whole (no Net Income row, a section with no Total row, Accrual basis). Any problem blocks MATCH.
 * `month` is set when the problem is about one month, so `selectMonths` can drop it with that month.
 */
export type QboProblem = { message: string; month: MonthKey | null };

export type QboPnl = {
  columns: QboColumn[];
  months: MonthKey[];
  /** Sections present in the file, in the order they appear. */
  sections: QboSection[];
  accounts: QboAccount[];
  /** Summary rows as QuickBooks reported them. Cross-checks only. */
  checks: { name: QboCheckName; line: number; cents: Record<MonthKey, number> }[];
  basis: "cash" | "accrual" | null;
  /** Blocking: see QboProblem. */
  problems: QboProblem[];
  /** Worth reading, but no money is at stake (e.g. the basis isn't stated). */
  warnings: string[];
};

/** The file can't be read as a P&L by month. The message says why and what to do. */
export class QboPnlParseError extends Error {}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return null;
  if (w === "sept") return 9;
  const i = MONTH_NAMES.findIndex((m) => m === w || m.slice(0, 3) === w);
  return i < 0 ? null : i + 1;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A month column header, or why it can't be one. Null when the text isn't month-shaped at all.
 * Accepts "Jan 2026", "January 2026", "Sept 2026", "Oct 1-15, 2026", "Oct 1 - Oct 15, 2026" and
 * "Oct 1, 2026" (one day). Also the month-year forms a file gets when it is opened and re-saved in
 * Excel: "Jan-2026", and Excel's "mmm-yy", "Jan-26" or "Jan 26". A two-digit year is 20xx and needs
 * a 3-letter month, so "November 17" from an unquoted date stamp isn't read as November 2017. The
 * column checks still apply.
 */
export function parseColumnLabel(raw: string): { column: QboColumn } | { error: string } | null {
  const label = raw.replace(/\s+/g, " ").trim();

  const whole = /^([A-Za-z]+)\.?[ -](\d{4})$/.exec(label) ?? /^([A-Za-z]{3})[ -](\d{2})$/.exec(label);
  if (whole) {
    const mo = monthNumber(whole[1]);
    if (!mo) return null;
    const year = whole[2].length === 2 ? `20${whole[2]}` : whole[2];
    const month = `${year}-${pad(mo)}`;
    return { column: { label, month, from: `${month}-01`, to: monthEnd(month), partial: false } };
  }

  const range = /^([A-Za-z]+)\.? (\d{1,2}) ?[-–—] ?(?:([A-Za-z]+)\.? )?(\d{1,2}),? (\d{4})$/.exec(label);
  const day = range ? null : /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/.exec(label);
  if (!range && !day) return null;
  const mo = monthNumber((range ?? day)![1]);
  if (!mo) return null;
  if (range?.[3] && monthNumber(range[3]) !== mo) {
    return { error: `The column "${label}" spans two months. Run the report with columns by Months.` };
  }
  const year = range ? range[5] : day![3];
  const d1 = Number(range ? range[2] : day![2]);
  const d2 = Number(range ? range[4] : day![2]);
  const month = `${year}-${pad(mo)}`;
  const last = Number(monthEnd(month).slice(8));
  if (d1 < 1 || d2 > last || d1 > d2) return { error: `The column "${label}" isn't a real date range.` };
  const from = `${month}-${pad(d1)}`;
  const to = `${month}-${pad(d2)}`;
  return { column: { label, month, from, to, partial: !(d1 === 1 && d2 === last) } };
}

const SECTION_NAMES: Record<string, QboSection> = {
  income: "income",
  "cost of goods sold": "cogs",
  "cost of sales": "cogs",
  cogs: "cogs",
  expenses: "expenses",
  expense: "expenses",
  "other income": "otherIncome",
  "other expenses": "otherExpenses",
  "other expense": "otherExpenses",
};

// Each may end in "(Loss)" or "(Income)", e.g. "Net Income (Loss)". Accepting more spellings can't
// lose money: summary rows never become accounts, and each one is cross-checked against the accounts.
const OR_LOSS = String.raw`(?:\s*\((?:income|loss)\))?`;
const CHECKS: [RegExp, QboCheckName][] = [
  [new RegExp(`^gross profit${OR_LOSS}$`, "i"), "Gross Profit"],
  [new RegExp(`^net operating (?:income|loss)${OR_LOSS}$`, "i"), "Net Operating Income"],
  [new RegExp(`^net other (?:income|loss)${OR_LOSS}$`, "i"), "Net Other Income"],
  [new RegExp(`^net (?:income|loss)${OR_LOSS}$`, "i"), "Net Income"],
];
/** Starts like a summary row but isn't one we know, so it couldn't be cross-checked. */
const SUMMARY_LIKE = /^(?:net|gross)\b/i;

const BASIS = /^(cash|accrual) basis\b/i;
const TOTAL = /^total(?:\s+for)?\s+(.+)$/i;

type Row = {
  line: number;
  indent: number;
  label: string;
  /** First non-empty cell, for recognising the footer. */
  first: string;
  /** Per month column; null = blank cell. Only meaningful when `bad` is null. */
  amounts: (number | null)[];
  hasAmounts: boolean;
  /** The Total column's amount, or null when blank. */
  totalCell: number | null;
  /**
   * Why the row's cells can't be read as amounts. Thrown, unless the row is skipped before that: the
   * "Cash Basis ..." footer with no amounts, or a date stamp after Net Income outside any section.
   */
  bad: string | null;
  /** Set on "Total X" / "Total for X" rows. */
  totalName: string | null;
  /** The whole line is a date stamp (see isDateStamp). */
  stamp: boolean;
  blank: boolean;
};

/**
 * One amount cell. A file re-saved in Excel can carry its accounting format, which writes zero as a
 * lone dash (" - ", "$ -") and a negative as "$ (12.00)". Only a cell that is nothing but the dash
 * (with spaces or a "$") is zero; everything else goes through parseAmountToCents.
 */
export function parseCellAmount(text: string): number | null {
  const t = text.trim();
  if (/^\$?\s*[-–—]\s*$/.test(t)) return 0;
  const dollarParens = /^\$\s*(\(.*\))$/.exec(t);
  return parseAmountToCents(dollarParens ? dollarParens[1] : t);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * The line is the report's date stamp, e.g. "Saturday, November 7, 2026 10:15 AM GMT-05:00" (some
 * exports put it on its own line after "Cash Basis"). Unquoted, its commas split it across the
 * amount columns, so it is recognised from the whole line put back together.
 */
function isDateStamp(cells: string[]): boolean {
  const text = cells.join(",").replace(/[,\s]+$/, "").replace(/\s+/g, " ").trim();
  const m =
    /^(?:([A-Za-z]+), ?)?([A-Za-z]+)\.? (\d{1,2}), ?(\d{4})(?: \d{1,2}:\d{2}(?::\d{2})? ?(?:[AP]M)?)?(?: (?:GMT|UTC)?[+-]\d{1,2}(?::?\d{2})?| [A-Z]{2,5})?$/i.exec(
      text,
    );
  const weekday = (w: string) => WEEKDAYS.some((d) => d === w.toLowerCase() || d.slice(0, 3) === w.toLowerCase());
  return !!m && (!m[1] || weekday(m[1])) && monthNumber(m[2]) !== null && Number(m[3]) >= 1 && Number(m[3]) <= 31;
}

type Frame =
  | { kind: "section"; section: QboSection; label: string; line: number; sum: number[] }
  | { kind: "group"; label: string; path: string[]; line: number; sum: number[]; closeBy: "total" | "indent"; indent: number };

/**
 * The header is the first line whose cells after the first are all month labels or "Total", with at
 * least one month. An unquoted date stamp that only looks like one ("Nov 17" reads as a month) is
 * passed over; its problem is what's reported if no header follows, or if any amount sits between it
 * and the header (that money would go unread). Any other header-like line with a bad column is refused.
 */
function findHeader(rows: string[][]): { index: number; columns: { col: number; column: QboColumn }[]; totalCol: number | null } {
  let firstError: { index: number; message: string } | null = null;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i].map((c) => c.trim());
    const results = cells.map((text, col) => ({ col, text, res: col > 0 && text ? parseColumnLabel(text) : null }));
    if (!results.some((r) => r.res && "column" in r.res)) {
      const bad = results.find((r) => r.res && "error" in r.res)?.res as { error: string } | undefined;
      if (bad && !firstError) firstError = { index: i, message: `Line ${i + 1}: ${bad.error}` };
      continue;
    }
    const columns: { col: number; column: QboColumn }[] = [];
    let totalCol: number | null = null;
    let problem: string | null = null;
    for (const r of results.slice(1)) {
      if (!r.text) continue;
      if (/^total$/i.test(r.text)) {
        if (totalCol !== null) problem ??= `Line ${i + 1} has two "Total" columns.`;
        totalCol = r.col;
      } else if (!r.res) {
        problem ??= `Line ${i + 1}, column ${r.col + 1}: the header "${r.text}" isn't a month. Expected labels like "Jan 2026", "January 2026" or "Oct 1-15, 2026". Run Profit and Loss with columns by Months.`;
      } else if ("error" in r.res) {
        problem ??= `Line ${i + 1}: ${r.res.error}`;
      } else {
        columns.push({ col: r.col, column: r.res.column });
      }
    }
    if (problem) {
      // Only a date stamp is passed over; any other header-like line is the header, with a bad column.
      if (!isDateStamp(rows[i])) throw new QboPnlParseError(problem);
      firstError ??= { index: i, message: problem };
      continue;
    }
    if (firstError && rows.slice(firstError.index + 1, i).some((r) => r.slice(1).some((c) => c.trim() && parseCellAmount(c) !== null))) {
      throw new QboPnlParseError(firstError.message);
    }
    checkContiguous(columns.map((c) => c.column), i + 1);
    return { index: i, columns, totalCol };
  }
  throw new QboPnlParseError(
    firstError?.message ??
      `Couldn't find the header row with the month columns (like ",Jan 2026,Feb 2026,...,Total"). Run Profit and Loss with columns by Months, Cash basis, and export it to CSV.`,
  );
}

/**
 * Months must follow one another with no gap, and only the first column may start late or the last
 * end early: otherwise money in the gap would never be compared.
 */
function checkContiguous(columns: QboColumn[], line: number) {
  columns.forEach((c, k) => {
    const prev = columns[k - 1];
    if (prev && c.month !== addMonths(prev.month, 1)) {
      throw new QboPnlParseError(
        c.month <= prev.month
          ? `Line ${line}: month columns must run oldest to newest, once each ("${prev.label}" then "${c.label}").`
          : `Line ${line}: the month columns skip from "${prev.label}" to "${c.label}", so the months between would never be compared. Export every month in the range.`,
      );
    }
    if ((k > 0 && !c.from.endsWith("-01")) || (k < columns.length - 1 && c.to !== monthEnd(c.month))) {
      throw new QboPnlParseError(
        `Line ${line}: the column "${c.label}" covers only part of its month, but isn't the first or last column, so days would be missed.`,
      );
    }
  });
}

/** Parses the whole export. Throws QboPnlParseError when the file can't be read as a P&L by month. */
export function parseQboPnl(text: string): QboPnl {
  const raw = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { skipEmptyLines: false }).data;
  const rows = raw.map((r) => (Array.isArray(r) ? r.map((c) => (typeof c === "string" ? c : "")) : []));
  // A first column that is blank on every line (e.g. from a spreadsheet) holds nothing: drop it, so
  // the labels are back in the first column.
  while (rows.some((r) => r.length > 1) && rows.every((r) => !(r[0] ?? "").trim())) {
    for (let i = 0; i < rows.length; i++) rows[i] = rows[i].slice(1);
  }
  const header = findHeader(rows);
  const columns = header.columns.map((c) => c.column);
  const months = columns.map((c) => c.month);
  const problems: QboProblem[] = [];
  const warnings: string[] = [];
  const toRecord = (vals: number[]) => Object.fromEntries(months.map((m, k) => [m, vals[k] ?? 0]));
  const money = formatCents;
  const fail = (line: number, message: string): never => {
    throw new QboPnlParseError(`Line ${line}: ${message}`);
  };

  let basis: QboPnl["basis"] = null;
  for (const r of rows.slice(0, header.index)) {
    const b = BASIS.exec(r.map((c) => c.trim()).find(Boolean) ?? "");
    if (b) basis = b[1].toLowerCase() as "cash" | "accrual";
  }

  const known = new Set([0, ...header.columns.map((c) => c.col), ...(header.totalCol === null ? [] : [header.totalCol])]);
  const body: Row[] = rows.slice(header.index + 1).map((cells, k) => {
    const line = header.index + 2 + k;
    const rawLabel = cells[0] ?? "";
    const label = rawLabel.replace(/\s+/g, " ").trim();
    const indent = /^\s*/.exec(rawLabel)![0].replace(/\t/g, "    ").length;
    const first = cells.map((c) => c.trim()).find(Boolean) ?? "";
    let bad: string | null = null;
    // Money anywhere but under a month or the Total column (e.g. an unquoted 1,800.00 split in two)
    // would otherwise be misread or dropped without a trace.
    const strayCol = cells.findIndex((c, col) => !known.has(col) && c.trim() !== "");
    if (strayCol >= 0) {
      const stray = cells[strayCol].trim();
      bad =
        parseCellAmount(stray) === null
          ? `"${stray}" in column ${strayCol + 1} has no heading above it. Account names must be in the first column and amounts under the month headings. Export the report from QuickBooks again.`
          : `"${stray}" in column ${strayCol + 1} isn't under a month heading. Amounts must line up with the header, and a thousands separator must be quoted ("1,800.00"). Export the report again.`;
    }
    const amounts = header.columns.map(({ col, column }) => {
      const t = (cells[col] ?? "").trim();
      if (!t) return null;
      const cents = parseCellAmount(t);
      if (cents === null) bad ??= `"${t}" under ${column.label} isn't an amount.`;
      return cents;
    });
    const totalText = header.totalCol === null ? "" : (cells[header.totalCol] ?? "").trim();
    const totalCell = totalText ? parseCellAmount(totalText) : null;
    if (totalText && totalCell === null) bad ??= `"${totalText}" in the Total column isn't an amount.`;
    const total = TOTAL.exec(label);
    return {
      line,
      indent,
      label,
      first,
      amounts,
      hasAmounts: amounts.some((a) => a !== null),
      totalCell,
      bad,
      totalName: total ? total[1].trim() : null,
      stamp: isDateStamp(cells),
      blank: !first,
    };
  });

  const accounts: QboAccount[] = [];
  const checks: QboPnl["checks"] = [];
  const sections: QboSection[] = [];
  const stack: Frame[] = [];
  const zeros = () => columns.map(() => 0);
  let netIncomeSeen = false;

  const frameNames = (f: Frame): string[] =>
    f.kind === "section" ? [] : [categoryKey(f.label), categoryKey(f.path[f.path.length - 1]), categoryKey(f.path.join(":"))];
  const closes = (totalName: string, f: Frame) =>
    f.kind === "section" ? SECTION_NAMES[categoryKey(totalName)] === f.section : frameNames(f).includes(categoryKey(totalName));
  /** Index of the next row at or after `from` that is a Total row whose name passes `test`, else -1. */
  const nextTotal = (from: number, test: (name: string) => boolean) => {
    for (let j = from; j < body.length; j++) if (body[j].totalName && test(body[j].totalName!)) return j;
    return -1;
  };
  const sectionFrame = () => (stack[0]?.kind === "section" ? stack[0] : null);
  /** The open section has no Total row left in the file: its boundary is wherever the next section starts. */
  const sectionIsDangling = (i: number) => {
    const s = sectionFrame();
    return !!s && nextTotal(i, (n) => closes(n, s)) === -1;
  };
  const noTotal = (s: Frame) =>
    problems.push({ message: `"${s.label}" (line ${s.line}) has no Total row, so where it ends was guessed and its accounts can't be checked.`, month: null });
  const closeDangling = () => {
    const s = sectionFrame();
    if (s) noTotal(s);
    stack.length = 0;
  };

  const addAccount = (path: string[], row: Row, section: QboSection) => {
    const cents = row.amounts.map((a) => a ?? 0);
    for (const f of stack) cents.forEach((c, k) => (f.sum[k] += c));
    accounts.push({ name: path[path.length - 1], path, section, cents: toRecord(cents), line: row.line });
  };

  const checkTotal = (what: string, line: number, reported: (number | null)[], sum: number[]) => {
    reported.forEach((r, k) => {
      const want = r ?? 0;
      if (want !== sum[k]) {
        problems.push({
          message: `Line ${line}: "${what}" for ${columns[k].label} says ${money(want)}, but the accounts above it add up to ${money(sum[k])}.`,
          month: months[k],
        });
      }
    });
  };

  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    if (r.blank) continue;
    // The footer ("Cash Basis Saturday, November 7, 2026 ...") comes after the last section and may be
    // unquoted, spilling date text into the amount columns, so its bad cells are not read. One with
    // amounts ("Cash Basis Adjustment,500.00") is not the footer: it goes on to fail below.
    const footer = BASIS.exec(r.first);
    if (footer && !stack.length && !r.hasAmounts) {
      basis = footer[1].toLowerCase() as "cash" | "accrual";
      continue;
    }
    // The footer's date stamp on a line of its own. Skipped only after Net Income and outside any
    // section, where nothing is part of the report's totals.
    if (r.stamp && !stack.length && netIncomeSeen) continue;
    if (r.bad) fail(r.line, r.bad);
    if (footer) {
      if (r.hasAmounts) fail(r.line, `"${r.label}" has amounts but looks like the "${footer[0]}" footer. Rename the account in QuickBooks so it doesn't start with "${footer[0]}", then export again.`);
      continue;
    }

    // A row whose months don't add up to its own Total column was misread somehow.
    if (r.totalCell !== null && r.hasAmounts && r.label) {
      const sum = r.amounts.reduce<number>((s, a) => s + (a ?? 0), 0);
      if (sum !== r.totalCell) {
        problems.push({ message: `Line ${r.line}: "${r.label}" Total column says ${money(r.totalCell)}, but its months add up to ${money(sum)}.`, month: null });
      }
    }

    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.kind === "group" && top.closeBy === "indent" && r.indent <= top.indent) stack.pop();
      else break;
    }

    if (r.totalName) {
      let k = stack.length - 1;
      while (k >= 0 && !closes(r.totalName, stack[k])) k--;
      if (k < 0) {
        if (r.hasAmounts) {
          fail(
            r.line,
            `"${r.label}" has amounts and starts with "Total", but doesn't close any section or parent account above it, so it can't be read safely. If it is an account, rename it in QuickBooks so it doesn't start with "Total", then export again.`,
          );
        }
        continue;
      }
      for (const f of stack.slice(k + 1)) {
        if (f.kind === "group" && f.closeBy === "total") warnings.push(`"${f.label}" (line ${f.line}) closed without its own Total row.`);
      }
      checkTotal(r.label, r.line, r.amounts, stack[k].sum);
      stack.length = k;
      continue;
    }

    const check = CHECKS.find(([re]) => re.test(r.label));
    if (check && (!stack.length || sectionIsDangling(i))) {
      if (stack.length) closeDangling();
      checks.push({ name: check[1], line: r.line, cents: toRecord(r.amounts.map((a) => a ?? 0)) });
      if (check[1] === "Net Income") netIncomeSeen = true;
      continue;
    }

    const heading = SECTION_NAMES[categoryKey(r.label)];
    if (heading && !r.hasAmounts && (!stack.length || (heading !== sectionFrame()?.section && sectionIsDangling(i)))) {
      if (stack.length) closeDangling();
      stack.push({ kind: "section", section: heading, label: r.label, line: r.line, sum: zeros() });
      if (!sections.includes(heading)) sections.push(heading);
      continue;
    }

    const section = sectionFrame();
    if (!section) {
      if (r.hasAmounts && SUMMARY_LIKE.test(r.label)) {
        fail(
          r.line,
          `"${r.label}" has amounts and looks like a summary row, but isn't one this tool knows (Gross Profit, Net Operating Income, Net Other Income, Net Income), so it can't be checked against the accounts.`,
        );
      }
      if (r.hasAmounts) {
        fail(
          r.line,
          `"${r.label}" has amounts but isn't under Income, Cost of Goods Sold, Expenses, Other Income or Other Expenses, so it can't be placed.`,
        );
      }
      continue; // a text line between sections
    }
    if (!r.label) {
      if (r.hasAmounts) fail(r.line, "this row has amounts but no account name.");
      continue;
    }

    // An account, or a parent account that opens a group of sub-accounts.
    const parent = [...stack].reverse().find((f): f is Extract<Frame, { kind: "group" }> => f.kind === "group");
    const base = parent?.path ?? [];
    const parts = r.label.split(":").map((p) => p.trim()).filter(Boolean);
    const startsWithBase = parts.length > base.length && base.every((b, k) => categoryKey(b) === categoryKey(parts[k]));
    const path = parts.length > 1 && startsWithBase ? parts : [...base, ...parts];

    const enclosing = stack[stack.length - 1];
    const stop =
      enclosing.kind === "group" && enclosing.closeBy === "indent" ? body.length : nextTotal(i + 1, (n) => closes(n, enclosing));
    const ownNames = [categoryKey(r.label), categoryKey(path[path.length - 1]), categoryKey(path.join(":"))];
    const ownTotal = nextTotal(i + 1, (n) => ownNames.includes(categoryKey(n)));
    const byTotal = ownTotal !== -1 && (stop === -1 || ownTotal < stop);
    const next = body.slice(i + 1).find((b) => !b.blank && !BASIS.test(b.first));
    const byIndent = !byTotal && !!next && next.indent > r.indent && !next.totalName;

    if (byTotal || byIndent) {
      stack.push({ kind: "group", label: r.label, path, line: r.line, sum: zeros(), closeBy: byTotal ? "total" : "indent", indent: r.indent });
    }
    // A parent's own amounts are postings to the parent itself: keep them as an account of that name.
    if (r.hasAmounts) addAccount(path, r, section.section);
  }
  for (const f of stack) if (f.kind === "section") noTotal(f);

  // The same account written twice (e.g. split across pages) is one account.
  const merged = new Map<string, QboAccount>();
  for (const a of accounts) {
    const key = `${a.section}\u0000${a.path.map(categoryKey).join(":")}`;
    const seen = merged.get(key);
    if (!seen) merged.set(key, { ...a, cents: { ...a.cents } });
    else for (const m of months) seen.cents[m] += a.cents[m];
  }
  const finalAccounts = [...merged.values()];
  if (!finalAccounts.length) {
    throw new QboPnlParseError(
      "No accounts found under Income, Cost of Goods Sold, Expenses, Other Income or Other Expenses. Is this a Profit and Loss export?",
    );
  }

  // Cross-check the summary rows against what the accounts add up to.
  const computed = computedChecks(finalAccounts);
  for (const c of checks) {
    columns.forEach((col) => {
      const want = computed[c.name](col.month);
      if (c.cents[col.month] !== want) {
        problems.push({
          message: `Line ${c.line}: "${c.name}" for ${col.label} says ${money(c.cents[col.month])}, but the accounts add up to ${money(want)}.`,
          month: col.month,
        });
      }
    });
  }
  if (!checks.some((c) => c.name === "Net Income")) {
    problems.push({ message: `No "Net Income" row found, so the file can't be checked against itself. Was it cut off?`, month: null });
  }
  if (basis === "accrual") {
    problems.push({ message: "This QuickBooks report is Accrual basis; our books are cash basis. Run it again with Cash basis.", month: null });
  }
  if (basis === null) warnings.push(`Couldn't find "Cash Basis" in the file. Make sure the report was run on Cash basis.`);

  return { columns, months, sections, accounts: finalAccounts, checks, basis, problems, warnings };
}

/** What each summary row should say, recomputed from the accounts. */
export function computedChecks(accounts: QboAccount[]): Record<QboCheckName, (m: MonthKey) => number> {
  const bySection = (s: QboSection, m: MonthKey) => accounts.filter((a) => a.section === s).reduce((sum, a) => sum + (a.cents[m] ?? 0), 0);
  return {
    "Gross Profit": (m) => bySection("income", m) - bySection("cogs", m),
    "Net Operating Income": (m) => bySection("income", m) - bySection("cogs", m) - bySection("expenses", m),
    "Net Other Income": (m) => bySection("otherIncome", m) - bySection("otherExpenses", m),
    "Net Income": (m) =>
      bySection("income", m) - bySection("cogs", m) - bySection("expenses", m) + bySection("otherIncome", m) - bySection("otherExpenses", m),
  };
}

/**
 * Restricts a parsed report to the months from..to (inclusive, YYYY-MM; either may be omitted).
 * Asking for a month the file doesn't have is an error: it could never be compared, and a MATCH
 * would wrongly cover it.
 */
export function selectMonths(pnl: QboPnl, from?: MonthKey, to?: MonthKey): QboPnl {
  if (from && to && from > to) throw new QboPnlParseError(`--from ${from} is after --to ${to}.`);
  const first = pnl.columns[0];
  const last = pnl.columns[pnl.columns.length - 1];
  if ((from && from < first.month) || (to && to > last.month)) {
    throw new QboPnlParseError(
      `The file covers ${first.label} to ${last.label}, but you asked for ${from ?? first.month} to ${to ?? last.month}. Export the Profit and Loss for every month you want checked, or narrow --from/--to.`,
    );
  }
  const columns = pnl.columns.filter((c) => (!from || c.month >= from) && (!to || c.month <= to));
  const months = columns.map((c) => c.month);
  const pick = (r: Record<MonthKey, number>) => Object.fromEntries(months.map((m) => [m, r[m]]));
  return {
    ...pnl,
    columns,
    months,
    accounts: pnl.accounts.map((a) => ({ ...a, cents: pick(a.cents) })),
    checks: pnl.checks.map((c) => ({ ...c, cents: pick(c.cents) })),
    problems: pnl.problems.filter((p) => p.month === null || months.includes(p.month)),
  };
}
