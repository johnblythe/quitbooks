/**
 * Reads a QuickBooks Online "Profit and Loss by Month" CSV export: the QuickBooks side of
 * `npm run qbo:compare`. Pure, so every layout it tolerates is unit-tested (qbo-pnl.test.ts).
 *
 * The layout is written from memory and unverified against a real export. What it assumes:
 * - Preamble lines (company, report title, date range, "Cash Basis") come before a header row whose
 *   cells after the first are month labels plus an optional "Total" column, e.g. `,Jan 2026,...,Total`.
 *   Labels may be "Jan 2026", "January 2026" or a partial month such as "Oct 1-15, 2026".
 * - The first column holds the row label; amount columns line up under the month headers.
 * - Sections are headings with no amounts (Income, Cost of Goods Sold, Expenses, Other Income,
 *   Other Expenses), each closed by "Total X" or "Total for X".
 * - A parent account with sub-accounts is a heading (with or without its own amounts) closed by its
 *   own Total row, or is shown by indentation, or the account name is written "Parent:Child".
 * - Gross Profit, Net Operating Income, Net Other Income and Net Income are summary rows: kept as
 *   cross-checks, never as accounts.
 * - Income and expense amounts are both positive; a refund in an expense account is negative.
 * - The Total column is ignored for the comparison (it's recomputed), but checked against the months.
 */
import Papa from "papaparse";
import { monthEnd, type IsoDate, type MonthKey } from "./dates";
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

export type QboPnl = {
  columns: QboColumn[];
  months: MonthKey[];
  /** Sections present in the file, in the order they appear. */
  sections: QboSection[];
  accounts: QboAccount[];
  /** Summary rows as QuickBooks reported them. Cross-checks only. */
  checks: { name: QboCheckName; line: number; cents: Record<MonthKey, number> }[];
  basis: "cash" | "accrual" | null;
  /** Things in the file that don't add up, or that were skipped. The comparison still runs. */
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
 * "Oct 1, 2026" (one day).
 */
export function parseColumnLabel(raw: string): { column: QboColumn } | { error: string } | null {
  const label = raw.replace(/\s+/g, " ").trim();

  const whole = /^([A-Za-z]+)\.? (\d{4})$/.exec(label);
  if (whole) {
    const mo = monthNumber(whole[1]);
    if (!mo) return null;
    const month = `${whole[2]}-${pad(mo)}`;
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

function nameKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
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

const CHECKS: [RegExp, QboCheckName][] = [
  [/^gross profit$/i, "Gross Profit"],
  [/^net operating (income|loss)$/i, "Net Operating Income"],
  [/^net other (income|loss)$/i, "Net Other Income"],
  [/^net (income|loss)$/i, "Net Income"],
];

const BASIS = /^(cash|accrual) basis\b/i;
const TOTAL = /^total(?:\s+for)?\s+(.+)$/i;

type Row = {
  line: number;
  indent: number;
  label: string;
  /** Per column; null = blank cell. */
  amounts: (number | null)[];
  hasAmounts: boolean;
  /** Set on "Total X" / "Total for X" rows. */
  totalName: string | null;
  basis: "cash" | "accrual" | null;
  blank: boolean;
};

type Frame =
  | { kind: "section"; section: QboSection; label: string; line: number; sum: number[] }
  | { kind: "group"; label: string; path: string[]; line: number; sum: number[]; closeBy: "total" | "indent"; indent: number };

function findHeader(rows: string[][]): { index: number; columns: { col: number; column: QboColumn }[]; totalCol: number | null } {
  let firstError: string | null = null;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i].map((c) => c.trim());
    const results = cells.map((text, col) => ({ col, text, res: col > 0 && text ? parseColumnLabel(text) : null }));
    if (!results.some((r) => r.res && "column" in r.res)) {
      const bad = results.find((r) => r.res && "error" in r.res)?.res as { error: string } | undefined;
      if (bad && !firstError) firstError = `Line ${i + 1}: ${bad.error}`;
      continue;
    }
    const columns: { col: number; column: QboColumn }[] = [];
    let totalCol: number | null = null;
    for (const r of results.slice(1)) {
      if (!r.text) continue;
      if (/^total$/i.test(r.text)) {
        if (totalCol !== null) throw new QboPnlParseError(`Line ${i + 1} has two "Total" columns.`);
        totalCol = r.col;
        continue;
      }
      if (!r.res) {
        throw new QboPnlParseError(
          `Line ${i + 1}, column ${r.col + 1}: the header "${r.text}" isn't a month. Expected labels like "Jan 2026", "January 2026" or "Oct 1-15, 2026". Run Profit and Loss with columns by Months.`,
        );
      }
      if ("error" in r.res) throw new QboPnlParseError(`Line ${i + 1}: ${r.res.error}`);
      columns.push({ col: r.col, column: r.res.column });
    }
    for (let k = 1; k < columns.length; k++) {
      if (columns[k].column.month <= columns[k - 1].column.month) {
        throw new QboPnlParseError(
          `Line ${i + 1}: month columns must run oldest to newest, once each ("${columns[k - 1].column.label}" then "${columns[k].column.label}").`,
        );
      }
    }
    return { index: i, columns, totalCol };
  }
  throw new QboPnlParseError(
    firstError ??
      `Couldn't find the header row with the month columns (like ",Jan 2026,Feb 2026,...,Total"). Run Profit and Loss with columns by Months, Cash basis, and export it to CSV.`,
  );
}

/** Parses the whole export. Throws QboPnlParseError when the file can't be read as a P&L by month. */
export function parseQboPnl(text: string): QboPnl {
  const raw = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { skipEmptyLines: false }).data;
  const rows = raw.map((r) => (Array.isArray(r) ? r.map((c) => (typeof c === "string" ? c : "")) : []));
  const header = findHeader(rows);
  const columns = header.columns.map((c) => c.column);
  const months = columns.map((c) => c.month);
  const warnings: string[] = [];
  const toRecord = (vals: number[]) => Object.fromEntries(months.map((m, k) => [m, vals[k] ?? 0]));
  const money = formatCents;

  let basis: QboPnl["basis"] = null;
  for (const r of rows.slice(0, header.index)) {
    const first = r.map((c) => c.trim()).find(Boolean) ?? "";
    const b = BASIS.exec(first);
    if (b) basis = b[1].toLowerCase() as "cash" | "accrual";
  }

  const body: Row[] = rows.slice(header.index + 1).map((cells, k) => {
    const line = header.index + 2 + k;
    const rawLabel = cells[0] ?? "";
    const label = rawLabel.replace(/\s+/g, " ").trim();
    const indent = /^\s*/.exec(rawLabel)![0].replace(/\t/g, "    ").length;
    const firstCell = cells.map((c) => c.trim()).find(Boolean) ?? "";
    const b = BASIS.exec(firstCell);
    // The footer ("Cash Basis Saturday, November 7, 2026 ...") may be unquoted and spill into the
    // amount columns, so it is recognised before any amount is read.
    if (b || !firstCell) {
      const kind = b ? (b[1].toLowerCase() as "cash" | "accrual") : null;
      return { line, indent, label, amounts: [], hasAmounts: false, totalName: null, basis: kind, blank: !b };
    }
    const amounts = header.columns.map(({ col, column }) => {
      const t = (cells[col] ?? "").trim();
      if (!t) return null;
      const cents = parseAmountToCents(t);
      if (cents === null) {
        throw new QboPnlParseError(`Line ${line}: "${t}" under ${column.label} isn't an amount.`);
      }
      return cents;
    });
    const hasAmounts = amounts.some((a) => a !== null);
    const total = TOTAL.exec(label);
    const row: Row = { line, indent, label, amounts, hasAmounts, totalName: total ? total[1].trim() : null, basis: null, blank: false };
    // The Total column is ignored, but a row whose months don't add up to it was misread somehow.
    if (header.totalCol !== null && hasAmounts && !row.totalName && label) {
      const t = (cells[header.totalCol] ?? "").trim();
      const reported = t ? parseAmountToCents(t) : null;
      const sum = amounts.reduce<number>((s, a) => s + (a ?? 0), 0);
      if (reported !== null && reported !== sum) {
        warnings.push(`Line ${line}: "${label}" Total column says ${money(reported)}, but its months add up to ${money(sum)}.`);
      }
    }
    return row;
  });

  const accounts: QboAccount[] = [];
  const checks: QboPnl["checks"] = [];
  const sections: QboSection[] = [];
  const stack: Frame[] = [];
  const zeros = () => columns.map(() => 0);

  const frameNames = (f: Frame): string[] =>
    f.kind === "section" ? [] : [nameKey(f.label), nameKey(f.path[f.path.length - 1]), nameKey(f.path.join(":"))];
  const closes = (totalName: string, f: Frame) =>
    f.kind === "section" ? SECTION_NAMES[nameKey(totalName)] === f.section : frameNames(f).includes(nameKey(totalName));
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
  const closeDangling = () => {
    const s = sectionFrame();
    if (s) warnings.push(`"${s.label}" (line ${s.line}) has no Total row, so where it ends was guessed.`);
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
        warnings.push(
          `Line ${line}: "${what}" for ${columns[k].label} says ${money(want)}, but the accounts above it add up to ${money(sum[k])}.`,
        );
      }
    });
  };

  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    if (r.blank) continue;
    if (r.basis) {
      basis = r.basis;
      continue;
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
        if (r.hasAmounts) warnings.push(`Line ${r.line}: "${r.label}" doesn't close any section or parent account above it, so it was ignored.`);
        continue;
      }
      for (const f of stack.slice(k + 1)) {
        if (f.kind === "group" && f.closeBy === "total") warnings.push(`"${f.label}" (line ${f.line}) closed without its own Total row.`);
      }
      const f = stack[k];
      checkTotal(r.label, r.line, r.amounts, f.sum);
      stack.length = k;
      continue;
    }

    const check = CHECKS.find(([re]) => re.test(r.label));
    if (check && (!stack.length || sectionIsDangling(i))) {
      if (stack.length) closeDangling();
      checks.push({ name: check[1], line: r.line, cents: toRecord(r.amounts.map((a) => a ?? 0)) });
      continue;
    }

    const heading = SECTION_NAMES[nameKey(r.label)];
    if (heading && !r.hasAmounts && (!stack.length || (heading !== sectionFrame()?.section && sectionIsDangling(i)))) {
      if (stack.length) closeDangling();
      stack.push({ kind: "section", section: heading, label: r.label, line: r.line, sum: zeros() });
      if (!sections.includes(heading)) sections.push(heading);
      continue;
    }

    const section = sectionFrame();
    if (!section) {
      if (r.hasAmounts) {
        warnings.push(
          `Line ${r.line}: "${r.label}" has amounts but isn't under Income, Cost of Goods Sold, Expenses, Other Income or Other Expenses, so it was left out.`,
        );
      }
      continue;
    }
    if (!r.label) {
      if (r.hasAmounts) warnings.push(`Line ${r.line} has amounts but no account name, so it was left out.`);
      continue;
    }

    // An account, or a parent account that opens a group of sub-accounts.
    const parent = [...stack].reverse().find((f): f is Extract<Frame, { kind: "group" }> => f.kind === "group");
    const base = parent?.path ?? [];
    const parts = r.label.split(":").map((p) => p.trim()).filter(Boolean);
    const startsWithBase = parts.length > base.length && base.every((b, k) => nameKey(b) === nameKey(parts[k]));
    const path = parts.length > 1 && startsWithBase ? parts : [...base, ...parts];

    const enclosing = stack[stack.length - 1];
    const stop =
      enclosing.kind === "group" && enclosing.closeBy === "indent" ? body.length : nextTotal(i + 1, (n) => closes(n, enclosing));
    const ownNames = [nameKey(r.label), nameKey(path[path.length - 1]), nameKey(path.join(":"))];
    const ownTotal = nextTotal(i + 1, (n) => ownNames.includes(nameKey(n)));
    const byTotal = ownTotal !== -1 && (stop === -1 || ownTotal < stop);
    const next = body.slice(i + 1).find((b) => !b.blank && !b.basis);
    const byIndent = !byTotal && !!next && next.indent > r.indent && !next.totalName;

    if (byTotal || byIndent) {
      stack.push({ kind: "group", label: r.label, path, line: r.line, sum: zeros(), closeBy: byTotal ? "total" : "indent", indent: r.indent });
    }
    // A parent's own amounts are postings to the parent itself: keep them as an account of that name.
    if (r.hasAmounts) addAccount(path, r, section.section);
  }
  for (const f of stack) {
    if (f.kind === "section") warnings.push(`"${f.label}" (line ${f.line}) has no Total row, so where it ends was guessed.`);
  }

  // The same account written twice (e.g. split across pages) is one account.
  const merged = new Map<string, QboAccount>();
  for (const a of accounts) {
    const key = `${a.section}\u0000${a.path.map(nameKey).join(":")}`;
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
  const bySection = (s: QboSection, m: MonthKey) =>
    finalAccounts.filter((a) => a.section === s).reduce((sum, a) => sum + a.cents[m], 0);
  const computed: Record<QboCheckName, (m: MonthKey) => number> = {
    "Gross Profit": (m) => bySection("income", m) - bySection("cogs", m),
    "Net Operating Income": (m) => bySection("income", m) - bySection("cogs", m) - bySection("expenses", m),
    "Net Other Income": (m) => bySection("otherIncome", m) - bySection("otherExpenses", m),
    "Net Income": (m) =>
      bySection("income", m) - bySection("cogs", m) - bySection("expenses", m) + bySection("otherIncome", m) - bySection("otherExpenses", m),
  };
  for (const c of checks) {
    columns.forEach((col) => {
      const want = computed[c.name](col.month);
      if (c.cents[col.month] !== want) {
        warnings.push(
          `Line ${c.line}: "${c.name}" for ${col.label} says ${money(c.cents[col.month])}, but the accounts add up to ${money(want)}.`,
        );
      }
    });
  }
  if (!checks.some((c) => c.name === "Net Income")) warnings.push(`No "Net Income" row found, so the file couldn't be cross-checked. Was it cut off?`);
  if (basis === "accrual") warnings.push("This QuickBooks report is Accrual basis; our books are cash basis. Run it again with Cash basis.");
  if (basis === null) warnings.push(`Couldn't find "Cash Basis" in the file. Make sure the report was run on Cash basis.`);

  return { columns, months, sections, accounts: finalAccounts, checks, basis, warnings };
}

/**
 * Restricts a parsed report to the months from..to (inclusive, YYYY-MM; either may be omitted).
 * Months asked for but not in the file become warnings, since they can't be compared.
 */
export function selectMonths(pnl: QboPnl, from?: MonthKey, to?: MonthKey): QboPnl {
  if (from && to && from > to) throw new QboPnlParseError(`--from ${from} is after --to ${to}.`);
  const columns = pnl.columns.filter((c) => (!from || c.month >= from) && (!to || c.month <= to));
  const first = pnl.columns[0];
  const last = pnl.columns[pnl.columns.length - 1];
  if (!columns.length) {
    throw new QboPnlParseError(
      `The file covers ${first.label} to ${last.label}; none of those months are in ${from ?? "the start"} to ${to ?? "the end"}.`,
    );
  }
  const warnings = [...pnl.warnings];
  if (from && from < first.month) warnings.push(`The file starts at ${first.label}, so months before it weren't compared.`);
  if (to && to > last.month) warnings.push(`The file ends at ${last.label}, so months after it weren't compared.`);
  const months = columns.map((c) => c.month);
  const pick = (r: Record<MonthKey, number>) => Object.fromEntries(months.map((m) => [m, r[m]]));
  return {
    ...pnl,
    columns,
    months,
    accounts: pnl.accounts.map((a) => ({ ...a, cents: pick(a.cents) })),
    checks: pnl.checks.map((c) => ({ ...c, cents: pick(c.cents) })),
    warnings,
  };
}
