/**
 * Compares our cash-basis P&L with a QuickBooks "Profit and Loss by Month" export, month by month
 * and category by category, and writes the result as Markdown. Pure: the database side is in
 * qbo-compare-db.ts and the CLI in scripts/qbo-compare.ts.
 *
 * Our numbers come from `computePnl` over ledger lines (splits expanded), so this measures exactly
 * what the app's P&L shows: transfers left out, and uncategorized money netted into one Inbox cell
 * per month (see INBOX_KEY), with a gross check so netting can't hide money.
 * The comparison is at OUR category level: several QuickBooks accounts may feed one category.
 */
import type { MonthKey } from "./dates";
import { categoryKey, isPlaceholderCategory, type CategoryKind, type SavedCategoryChoice } from "./import-categories";
import { toMetricTxs, type LedgerLine, type LedgerSplit, type LedgerTx } from "./ledger";
import { computePnl, UNCATEGORIZED_IN, UNCATEGORIZED_OUT } from "./metrics";
import { formatCents } from "./money";
import { SECTION_LABEL, sectionDirection, type QboAccount, type QboColumn, type QboPnl, type QboProblem, type QboSection } from "./qbo-pnl";

export type OurCategory = { id: string; name: string; kind: CategoryKind; archived: boolean };
export type OurTx = LedgerTx & { description: string; source: "manual" | "csv" | "bank_sync" };
export type OurLine = LedgerLine<OurTx, LedgerSplit>;

/** Where a QuickBooks account's money is expected in our books. */
export type MapTarget = { type: "category"; categoryId: string } | { type: "inbox" };
export type MapVia = "--map" | "saved import mapping" | "same name" | "QuickBooks placeholder";

export type AccountMapping = {
  account: QboAccount;
  /** "Parent:Child" (or just the name for a top-level account). */
  fullName: string;
  target: MapTarget | null;
  /** Our category's name, "Inbox (uncategorized)", or null when not mapped. */
  targetLabel: string | null;
  via: MapVia | null;
  /** The name that matched, when it was a parent account rather than the account itself. */
  rolledUpTo: string | null;
};

/** Bad input from the person running the script (e.g. a --map entry naming no category of ours). */
export class QboCompareInputError extends Error {}

const INBOX_NAMES = new Set(["inbox", "uncategorized"]);

/** Keys compare names case- and space-insensitively, "Parent : Child" the same as "Parent:Child". */
function mapKey(name: string): string {
  return categoryKey(name).replace(/\s*:\s*/g, ":");
}

export function fullAccountName(a: Pick<QboAccount, "path">): string {
  return a.path.join(":");
}

/** Names to try for an account, most specific first: full name, leaf name, then each parent. */
function candidates(path: string[]): { name: string; rolledUp: boolean }[] {
  const out: { name: string; rolledUp: boolean }[] = [{ name: path.join(":"), rolledUp: false }];
  if (path.length > 1) out.push({ name: path[path.length - 1], rolledUp: false });
  for (let n = path.length - 1; n >= 1; n--) {
    out.push({ name: path.slice(0, n).join(":"), rolledUp: true });
    if (n > 1) out.push({ name: path[n - 1], rolledUp: true });
  }
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(mapKey(c.name)) && seen.add(mapKey(c.name)));
}

function categoryByName(categories: OurCategory[], name: string): OurCategory | undefined {
  const key = mapKey(name);
  const hits = categories.filter((c) => mapKey(c.name) === key);
  return hits.find((c) => !c.archived) ?? hits[0];
}

/**
 * Checks a `--map` file ({"QuickBooks name": "Our category name"}) against our categories.
 * "Inbox" or "Uncategorized" (when no category has that name) means our uncategorized money.
 */
export function resolveOverrides(raw: unknown, categories: OurCategory[]): Map<string, MapTarget> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new QboCompareInputError('--map must be a JSON object like {"QuickBooks account": "Our category"}.');
  }
  const out = new Map<string, MapTarget>();
  const problems: string[] = [];
  for (const [qbo, ours] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof ours !== "string" || !ours.trim()) {
      problems.push(`"${qbo}" must map to a category name.`);
      continue;
    }
    const cat = categoryByName(categories, ours);
    if (cat) out.set(mapKey(qbo), { type: "category", categoryId: cat.id });
    else if (INBOX_NAMES.has(categoryKey(ours))) out.set(mapKey(qbo), { type: "inbox" });
    else problems.push(`"${qbo}" maps to "${ours}", which isn't one of our categories.`);
  }
  if (problems.length) {
    const names = categories.map((c) => c.name).sort((a, b) => a.localeCompare(b)).join(", ");
    throw new QboCompareInputError(`--map: ${problems.join(" ")} Our categories: ${names}. Use "Inbox" for uncategorized.`);
  }
  return out;
}

/**
 * The saved import mapping, keyed like `mapKey`. The import saves only "existing" and "inbox"
 * choices: a "Create new" pick is saved as an "existing" choice of the category it created
 * (`resolveCategoryChoices` and `mergeCategoryMap` in import-commit.ts). Any other shape is ignored.
 */
function savedIndex(saved: Record<string, unknown> | null | undefined): Map<string, SavedCategoryChoice> {
  const out = new Map<string, SavedCategoryChoice>();
  for (const [key, v] of Object.entries(saved ?? {})) {
    if (!v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    if (c.type === "inbox") out.set(mapKey(key), { type: "inbox" });
    else if (c.type === "existing" && typeof c.categoryId === "string") out.set(mapKey(key), { type: "existing", categoryId: c.categoryId });
  }
  return out;
}

/**
 * Maps each QuickBooks account onto our books. Sources, in order: the --map override, the saved
 * import mapping (`BMO:categories`), the same name (any case), then QuickBooks placeholders
 * (Uncategorized Income/Expense, Ask My Accountant) to our Inbox. Within each source the full name
 * is tried first, then the leaf name, then each parent ("rolled up").
 */
export function mapAccounts(
  accounts: QboAccount[],
  categories: OurCategory[],
  savedMap: Record<string, unknown> | null | undefined,
  overrides: Map<string, MapTarget> = new Map(),
): AccountMapping[] {
  const saved = savedIndex(savedMap);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const ids = new Set(byId.keys());
  const label = (t: MapTarget) => (t.type === "inbox" ? "Inbox (uncategorized)" : byId.get(t.categoryId)!.name);
  const fromSaved = (name: string): MapTarget | null => {
    const s = saved.get(mapKey(name));
    if (!s) return null;
    if (s.type === "inbox") return s;
    return ids.has(s.categoryId) ? { type: "category", categoryId: s.categoryId } : null;
  };
  const fromName = (name: string): MapTarget | null => {
    const c = categoryByName(categories, name);
    return c ? { type: "category", categoryId: c.id } : null;
  };
  const fromPlaceholder = (name: string): MapTarget | null => (isPlaceholderCategory(name) ? { type: "inbox" } : null);
  const sources: [MapVia, (name: string) => MapTarget | null][] = [
    ["--map", (n) => overrides.get(mapKey(n)) ?? null],
    ["saved import mapping", fromSaved],
    ["same name", fromName],
    ["QuickBooks placeholder", fromPlaceholder],
  ];

  return accounts.map((account) => {
    const fullName = fullAccountName(account);
    for (const [via, find] of sources) {
      for (const c of candidates(account.path)) {
        const target = find(c.name);
        if (target) return { account, fullName, target, targetLabel: label(target), via, rolledUpTo: c.rolledUp ? c.name : null };
      }
    }
    return { account, fullName, target: null, targetLabel: null, via: null, rolledUpTo: null };
  });
}

export type CellFeed = { account: string; section: QboSection; cents: number };

/**
 * The Inbox's cell: our uncategorized money against the QuickBooks accounts mapped to the Inbox
 * (the placeholders Uncategorized Income/Expense and Ask My Accountant), as one net amount per month,
 * money in minus money out. Net, because a placeholder nets both directions inside one account (a
 * refund in Uncategorized Expense), while our Inbox keeps them as separate rows.
 */
export const INBOX_KEY = "__inbox";
const INBOX_LABEL = "Inbox: uncategorized, net (money in − money out)";

/** An income or expense category's kind, a transfer category, or the Inbox (one net amount). */
export type CellKind = CategoryKind | "inbox";

/** One month x one of our categories (or our Inbox, or an unmapped QuickBooks account). */
export type Cell = {
  month: MonthKey;
  column: QboColumn;
  /**
   * Our category id, INBOX_KEY, or "qbo:<income|expense>:<account>" for an unmapped account (by
   * direction, so a same-named account in Income and in Expenses stays two cells).
   */
  key: string;
  label: string;
  kind: CellKind;
  qbo: number;
  ours: number;
  /** ours - QuickBooks. */
  diff: number;
  /** QuickBooks accounts that feed this cell, signed the way the cell counts them. */
  feeds: CellFeed[];
  /** Our ledger lines in this cell (filled for mismatched cells only). */
  lines: OurLine[];
  note: string | null;
};

export type MonthTotals = {
  month: MonthKey;
  column: QboColumn;
  /**
   * Both sides add up the month's cells the same way, by the cell's kind: our category's kind, or
   * the QuickBooks section for an unmapped account. So a QuickBooks income account mapped to one of
   * our expense categories is a negative expense on both sides. QuickBooks money mapped to one of our
   * transfer categories counts in its QuickBooks section (ours leaves it out). `inbox` is the Inbox
   * cell (net, money in − money out), outside income and expenses; net = income − expenses + inbox.
   *
   * For QuickBooks, `net` is the file's own Net Income row (`netReported`), falling back to the net
   * recomputed from its accounts only when the file has none (which is a blocking problem by itself).
   */
  qbo: { income: number; expenses: number; inbox: number; net: number; netReported: number | null; netComputed: number };
  /** `net` is our P&L's net, transfers left out and uncategorized money in. */
  ours: { income: number; expenses: number; inbox: number; net: number };
  /**
   * The Inbox without netting. QuickBooks: each Inbox-mapped account's month amount, signs ignored,
   * added up. Ours: Inbox money in plus money out. When the books agree, every QuickBooks placeholder
   * dollar is one of our Inbox rows, so QuickBooks' can't be more than ours. If it is (beyond the
   * tolerance), netting may be hiding money, e.g. the same $500 in Uncategorized Income and in
   * Uncategorized Expense with nothing in our Inbox: the month is a "mismatch".
   */
  inboxGross: { qbo: number; ours: number };
  /**
   * Income, expenses or net differ by more than the tolerance, or the Inbox gross check fails.
   * - "ok": none of that.
   * - "cells": totals off, and this month's mismatched cells show where.
   * - "mismatch": off with no mismatched cell to show for it (e.g. small cell differences adding up,
   *   or the file's Net Income row disagreeing with its accounts), or the Inbox gross check failed
   *   and this month's Inbox cell doesn't show it. Counts as a mismatch.
   */
  status: "ok" | "cells" | "mismatch";
  /**
   * The first of the net, income and expense differences (ours − QuickBooks) over the tolerance; or,
   * when the month is a "mismatch" only because of the Inbox gross check, ours − QuickBooks of the
   * Inbox gross; else 0.
   */
  diff: number;
};

/** QuickBooks' Inbox gross is more than ours by more than the tolerance (see MonthTotals.inboxGross). */
function inboxGrossShort(m: Pick<MonthTotals, "inboxGross">, tolerance: number): boolean {
  return m.inboxGross.qbo - m.inboxGross.ours > tolerance;
}

type Buckets = { income: number; expenses: number; inbox: number; net: number };

/**
 * Every dollar on each side must land in exactly one of income, expenses and the Inbox: income −
 * expenses + Inbox must be the side's net (for QuickBooks, recomputed from its accounts). Throws
 * otherwise, because then something was dropped or counted twice and nothing can be trusted.
 */
export function checkMonthAddsUp(label: string, qbo: Buckets, ours: Buckets): void {
  for (const [side, b] of [["the QuickBooks side", qbo], ["our side", ours]] as const) {
    if (b.income - b.expenses + b.inbox !== b.net) {
      throw new Error(
        `qbo:compare bug: ${label}: ${side} doesn't add up (income ${formatCents(b.income)} − expenses ${formatCents(b.expenses)} + Inbox ${formatCents(b.inbox)} isn't the net ${formatCents(b.net)}), so nothing can be trusted.`,
      );
    }
  }
}

export type InboxMonth = { month: MonthKey; column: QboColumn; inCents: number; inCount: number; outCents: number; outCount: number };

export type CompareResult = {
  columns: QboColumn[];
  toleranceCents: number;
  months: MonthTotals[];
  cells: Cell[];
  /** Cells that differ by more than the tolerance. */
  mismatches: Cell[];
  /** Cells that differ, but by no more than the tolerance. Always reported, never hidden. */
  withinTolerance: Cell[];
  /** Months whose totals are off with no mismatched cell to explain it (status "mismatch"). */
  monthMismatches: MonthTotals[];
  /** The QuickBooks file disagrees with itself or can't be trusted. Each one blocks MATCH. */
  problems: QboProblem[];
  /** |diff| summed over mismatched cells and month mismatches. */
  totalAbsDiff: number;
  /** True only when nothing differs beyond the tolerance and the file has no problems. */
  match: boolean;
  inbox: InboxMonth[];
  mappings: AccountMapping[];
  /** Mapped accounts with money in range whose target is a transfer category (left out of our P&L). */
  toTransfers: AccountMapping[];
  /** QuickBooks accounts with money in range that map to nothing of ours. */
  unmapped: AccountMapping[];
  /** Our income/expense categories with money in range that no QuickBooks account maps to. */
  unmatchedCategories: { category: OurCategory; cents: number }[];
  warnings: string[];
};

export function compareBooks(input: {
  pnl: QboPnl;
  categories: OurCategory[];
  lines: OurLine[];
  savedMap?: Record<string, unknown> | null;
  overrides?: Map<string, MapTarget>;
  toleranceCents?: number;
}): CompareResult {
  const { pnl, categories, lines } = input;
  const tolerance = input.toleranceCents ?? 0;
  const byId = new Map(categories.map((c) => [c.id, c]));
  const mappings = mapAccounts(pnl.accounts, categories, input.savedMap, input.overrides);
  const metricTxs = toMetricTxs(lines);
  const warnings = [...pnl.warnings];
  const names = new Set(pnl.accounts.flatMap((a) => candidates(a.path).map((c) => mapKey(c.name))));
  for (const key of input.overrides?.keys() ?? []) {
    if (!names.has(key)) warnings.push(`--map entry "${key}" doesn't match any QuickBooks account in the file.`);
  }

  const cells: Cell[] = [];
  const months: MonthTotals[] = [];
  const inbox: InboxMonth[] = [];
  const ourCategoryTotals = new Map<string, number>();
  const netIncomeRow = pnl.checks.find((c) => c.name === "Net Income");

  for (const column of pnl.columns) {
    const { month } = column;
    const ours = computePnl(metricTxs, categories, column.from, column.to);
    const cellMap = new Map<string, Cell>();
    const cell = (key: string, label: string, kind: CellKind): Cell => {
      let c = cellMap.get(key);
      if (!c) {
        c = { month, column, key, label, kind, qbo: 0, ours: 0, diff: 0, feeds: [], lines: [], note: null };
        cellMap.set(key, c);
      }
      return c;
    };

    const inboxGross = { qbo: 0, ours: 0 };
    for (const line of [...ours.income, ...ours.expenses]) {
      if (line.categoryId === UNCATEGORIZED_IN || line.categoryId === UNCATEGORIZED_OUT) {
        // computePnl reports both directions as positive amounts; the Inbox cell is net.
        cell(INBOX_KEY, INBOX_LABEL, "inbox").ours += line.categoryId === UNCATEGORIZED_IN ? line.cents : -line.cents;
        inboxGross.ours += line.cents;
        continue;
      }
      const cat = byId.get(line.categoryId)!;
      cell(cat.id, cat.name, cat.kind).ours += line.cents;
      ourCategoryTotals.set(cat.id, (ourCategoryTotals.get(cat.id) ?? 0) + Math.abs(line.cents));
    }

    let netComputed = 0;
    for (const m of mappings) {
      const cents = m.account.cents[month] ?? 0;
      const dir = sectionDirection(m.account.section);
      netComputed += dir === "income" ? cents : -cents;
      if (!cents) continue;

      let c: Cell;
      let signed = cents;
      if (!m.target) {
        c = cell(`qbo:${dir}:${m.fullName}`, `QuickBooks "${m.fullName}" (not mapped)`, dir);
        c.note = `Not mapped to any of our categories. Add it to --map.`;
      } else if (m.target.type === "inbox") {
        c = cell(INBOX_KEY, INBOX_LABEL, "inbox");
        if (dir === "expense") signed = -cents;
        inboxGross.qbo += Math.abs(cents);
      } else {
        const cat = byId.get(m.target.categoryId)!;
        c = cell(cat.id, cat.name, cat.kind);
        if (cat.kind === "transfer") {
          c.note = `${cat.name} is a transfer category, which our P&L leaves out.`;
        } else if (cat.kind !== dir) {
          // A QuickBooks income account mapped to one of our expense categories (or the reverse):
          // money that QuickBooks counts as income reduces our expense category.
          signed = -cents;
        }
      }
      c.qbo += signed;
      c.feeds.push({ account: m.fullName, section: m.account.section, cents: signed });
    }

    // Month totals count both sides the same way, by the cell's kind (see MonthTotals).
    const qbo = { income: 0, expenses: 0, inbox: 0 };
    const our = { income: 0, expenses: 0, inbox: 0 };
    const bucket = { income: "income", expense: "expenses", inbox: "inbox" } as const;
    for (const c of cellMap.values()) {
      c.diff = c.ours - c.qbo;
      cells.push(c);
      if (c.kind === "transfer") {
        // Our P&L leaves transfers out, so ours is 0 here. QuickBooks counts the money in its section.
        for (const f of c.feeds) qbo[sectionDirection(f.section) === "income" ? "income" : "expenses"] += f.cents;
        continue;
      }
      qbo[bucket[c.kind]] += c.qbo;
      our[bucket[c.kind]] += c.ours;
    }
    checkMonthAddsUp(column.label, { ...qbo, net: netComputed }, { ...our, net: ours.net });
    const reported = netIncomeRow ? netIncomeRow.cents[month] ?? 0 : null;
    months.push({
      month,
      column,
      qbo: { ...qbo, net: reported ?? netComputed, netReported: reported, netComputed },
      ours: { ...our, net: ours.net },
      inboxGross,
      status: "ok",
      diff: 0,
    });

    const inRange = lines.filter((l) => l.date >= column.from && l.date <= column.to);
    const uncategorized = inRange.filter((l) => l.categoryId === null);
    const ins = uncategorized.filter((l) => l.amountCents >= 0);
    const outs = uncategorized.filter((l) => l.amountCents < 0);
    inbox.push({
      month,
      column,
      inCents: ins.reduce((s, l) => s + l.amountCents, 0),
      inCount: ins.length,
      outCents: outs.reduce((s, l) => s - l.amountCents, 0),
      outCount: outs.length,
    });
  }

  const kindOrder: Record<CellKind, number> = { income: 0, expense: 1, inbox: 2, transfer: 3 };
  const byMonthThenSize = (a: Cell, b: Cell) =>
    a.month.localeCompare(b.month) || kindOrder[a.kind] - kindOrder[b.kind] || Math.abs(b.diff) - Math.abs(a.diff) || a.label.localeCompare(b.label);
  const mismatches = cells.filter((c) => Math.abs(c.diff) > tolerance).sort(byMonthThenSize);
  const withinTolerance = cells.filter((c) => c.diff !== 0 && Math.abs(c.diff) <= tolerance).sort(byMonthThenSize);
  for (const c of [...mismatches, ...withinTolerance]) c.lines = linesInCell(lines, c);

  // Month totals get the same tolerance, so small cell differences can't add up unseen, and the net
  // is checked against the file's own Net Income row, so money the parser lost can't hide.
  for (const m of months) {
    const diffs = [m.ours.net - m.qbo.net, m.ours.income - m.qbo.income, m.ours.expenses - m.qbo.expenses];
    const over = diffs.find((d) => Math.abs(d) > tolerance);
    const cellsOff = mismatches.filter((c) => c.month === m.month);
    if (over !== undefined) {
      m.diff = over;
      m.status = cellsOff.length ? "cells" : "mismatch";
    }
    // A gross shortfall is its own month mismatch unless this month's Inbox cell already shows it
    // (counting both would add the same money twice).
    if (inboxGrossShort(m, tolerance) && m.status !== "mismatch" && !cellsOff.some((c) => c.kind === "inbox")) {
      m.diff = m.inboxGross.ours - m.inboxGross.qbo;
      m.status = "mismatch";
    }
  }
  const monthMismatches = months.filter((m) => m.status === "mismatch");
  const problems = [...pnl.problems];

  const hasMoney = (m: AccountMapping) => pnl.columns.some((col) => (m.account.cents[col.month] ?? 0) !== 0);
  const targeted = new Set(mappings.flatMap((m) => (m.target?.type === "category" ? [m.target.categoryId] : [])));
  const unmatchedCategories = categories
    .filter((c) => c.kind !== "transfer" && !targeted.has(c.id) && (ourCategoryTotals.get(c.id) ?? 0) !== 0)
    .map((category) => ({
      category,
      cents: cells.filter((x) => x.key === category.id).reduce((s, x) => s + x.ours, 0),
    }));

  return {
    columns: pnl.columns,
    toleranceCents: tolerance,
    months,
    cells,
    mismatches,
    withinTolerance,
    monthMismatches,
    problems,
    totalAbsDiff: mismatches.reduce((s, c) => s + Math.abs(c.diff), 0) + monthMismatches.reduce((s, m) => s + Math.abs(m.diff), 0),
    match: !mismatches.length && !monthMismatches.length && !problems.length,
    inbox,
    mappings,
    toTransfers: mappings.filter((m) => m.target?.type === "category" && byId.get(m.target.categoryId)?.kind === "transfer" && hasMoney(m)),
    unmapped: mappings.filter((m) => !m.target && hasMoney(m)),
    unmatchedCategories,
    warnings,
  };
}

/** Our ledger lines that make up a cell (for a transfer category: the lines it holds, for context). */
function linesInCell(lines: OurLine[], c: Cell): OurLine[] {
  const { from, to } = c.column;
  return lines
    .filter((l) => l.date >= from && l.date <= to)
    .filter((l) => (c.key === INBOX_KEY ? l.categoryId === null : l.categoryId === c.key))
    .sort((a, b) => a.date.localeCompare(b.date) || a.tx.description.localeCompare(b.tx.description));
}

// ---------------------------------------------------------------------------------------------
// Markdown report

const money = (c: number) => formatCents(c);
const signed = (c: number) => (c === 0 ? "0" : formatCents(c, { signed: true }));
/** Text safe inside a Markdown table cell. */
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const MAX_LINES_PER_CELL = 50;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The last line of the report. MATCH only when every cell and every month total agree within the
 * tolerance and the QuickBooks file has no problems; it names the months it covers.
 */
export function mismatchSummary(
  r: Pick<CompareResult, "columns" | "mismatches" | "withinTolerance" | "monthMismatches" | "problems" | "totalAbsDiff" | "toleranceCents" | "match">,
): string {
  const within = r.withinTolerance.length
    ? `; ${plural(r.withinTolerance.length, "cell")} within the ${money(r.toleranceCents)} tolerance (sum ${money(r.withinTolerance.reduce((s, c) => s + Math.abs(c.diff), 0))})`
    : "";
  if (r.match) {
    const first = r.columns[0];
    const last = r.columns[r.columns.length - 1];
    return `MATCH: ${first.label} to ${last.label} (${plural(r.columns.length, "month")})${within}`;
  }
  const n = r.mismatches.length + r.monthMismatches.length + r.problems.length;
  const parts = [
    r.mismatches.length ? plural(r.mismatches.length, "cell") : "",
    r.monthMismatches.length ? plural(r.monthMismatches.length, "month total") : "",
    r.problems.length ? plural(r.problems.length, "problem") + " in the QuickBooks file" : "",
  ].filter(Boolean);
  const breakdown = r.monthMismatches.length || r.problems.length ? ` (${parts.join(", ")})` : "";
  return `${plural(n, "mismatch", "mismatches")}${breakdown}, total abs diff ${money(r.totalAbsDiff)}${within}`;
}

/**
 * A partial first or last month compares only the dates in the file's column, on both sides (our
 * books are read for exactly those dates). Said right above the verdict, so a MATCH for "January"
 * that only checked part of it can't be mistaken for the whole month.
 */
export function partialMonthWarning(columns: QboColumn[]): string | null {
  const partial = columns.filter((c) => c.partial);
  if (!partial.length) return null;
  const parts = partial.map((c) => `${c.month} only from ${c.from} to ${c.to} ("${c.label}")`);
  const rest = partial.length === 1 ? "the rest of that month was" : "the rest of those months was";
  return `WARNING: partial month. Compared ${parts.join(" and ")}; ${rest} not checked.`;
}

/**
 * True when part of the user or password in a DATABASE_URL would be read as the host. An unencoded
 * "/", "?" or "#" in the user or password ends the authority early, so the real "@" lands in the
 * path, query or fragment, or there is an "@" but no user. node-postgres parses the URL the same way,
 * so printing the host, or connecting to it (its DNS error names the host), would leak that part.
 * A string with an "@" that doesn't parse as a URL at all counts too: where its credentials end
 * can't be told.
 */
export function databaseUrlMisread(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.includes("@");
  }
  return (url.includes("@") && !u.username) || `${u.pathname}${u.search}${u.hash}`.includes("@");
}

/**
 * Which database a DATABASE_URL points at, safe to print: host and database name only, never the
 * user or password, plus the Neon endpoint id (production and dev branches have the same host
 * shape, and the endpoint tells them apart). "pglite:<dir>" is the local embedded database.
 */
export function describeDatabase(url: string | undefined): string {
  if (!url) return "unknown (DATABASE_URL is not set)";
  if (url.startsWith("pglite:")) return `local PGlite (${url.slice("pglite:".length) || "in memory"}), not production`;
  if (databaseUrlMisread(url)) return "unknown (DATABASE_URL isn't a URL)";
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.replace(/^\//, "")) || "(default database)";
    const where = `${u.hostname}${u.port ? `:${u.port}` : ""}/${name}`;
    const endpoint = u.hostname.endsWith(".neon.tech") ? /^(ep-[a-z0-9-]+?)(?:-pooler)?\./i.exec(u.hostname) : null;
    return endpoint ? `${where} (Neon endpoint ${endpoint[1]})` : where;
  } catch {
    return "unknown (DATABASE_URL isn't a URL)";
  }
}

export function formatReport(
  r: CompareResult,
  meta: { file: string; basis: QboPnl["basis"]; readOnly: boolean; database: string },
): string {
  const out: string[] = [];
  const first = r.columns[0];
  const last = r.columns[r.columns.length - 1];
  const basis = meta.basis ? `${meta.basis[0].toUpperCase()}${meta.basis.slice(1)} basis` : "basis not stated";
  out.push("# QuickBooks vs our books: Profit and Loss by Month", "");
  out.push(`- QuickBooks file: ${meta.file} (${basis})`);
  out.push(`- Our books: ${meta.database}`);
  out.push(`- Months: ${first.label} to ${last.label} (${r.columns.length})`);
  out.push(`- Tolerance: ${money(r.toleranceCents)} per cell and per month total`);
  out.push("- Diff = ours − QuickBooks. Income and expenses are both positive, as in QuickBooks. Transfers are left out.");
  if (meta.readOnly) out.push("- Read only: our books were read in a READ ONLY database transaction.");
  out.push("");

  if (r.problems.length) {
    out.push(`## Problems in the QuickBooks file (${r.problems.length})`, "");
    out.push("The file doesn't add up by its own totals, or can't be trusted as a whole. Each one blocks a MATCH.", "");
    for (const p of r.problems) out.push(`- ${p.message}`);
    out.push("");
  }

  if (r.warnings.length) {
    out.push("## Warnings", "");
    for (const w of r.warnings) out.push(`- ${w}`);
    out.push("");
  }

  out.push("## By month", "");
  out.push(
    "- Income and Expenses add up each side's money by our category, the same way on both sides: a QuickBooks income account mapped to one of our expense categories counts as a negative expense.",
    "- Inbox net is our uncategorized money (money in − money out) against the QuickBooks accounts mapped to the Inbox (Uncategorized Income/Expense, Ask My Accountant). It is one net amount because those accounts net refunds inside one account. It is not in Income or Expenses.",
    "- Net Income QB is the file's own Net Income row. Net = Income − Expenses + Inbox net.",
    "",
  );
  out.push("| Month | Income QB | Income ours | Diff | Expenses QB | Expenses ours | Diff | Inbox net QB | Inbox net ours | Diff | Net Income QB | Net ours | Diff | Totals |");
  out.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|");
  const status = { ok: "ok", cells: "off: see cells", mismatch: "MISMATCH" } as const;
  for (const m of r.months) {
    const d = (a: number, b: number) => signed(b - a);
    const netQb = m.qbo.netReported === null ? "not in file" : money(m.qbo.netReported);
    out.push(
      `| ${md(m.column.label)} | ${money(m.qbo.income)} | ${money(m.ours.income)} | ${d(m.qbo.income, m.ours.income)} | ${money(m.qbo.expenses)} | ${money(m.ours.expenses)} | ${d(m.qbo.expenses, m.ours.expenses)} | ${money(m.qbo.inbox)} | ${money(m.ours.inbox)} | ${d(m.qbo.inbox, m.ours.inbox)} | ${netQb} | ${money(m.ours.net)} | ${d(m.qbo.net, m.ours.net)} | ${status[m.status]} |`,
    );
  }
  out.push("");
  if (r.monthMismatches.length) {
    out.push(
      "A MISMATCH month is off by more than the tolerance with no mismatched cell to show for it: small cell differences adding up, a Net Income row that disagrees with the file's accounts (see Problems), or QuickBooks Inbox money our Inbox can't hold (below).",
      "",
    );
  }
  // Shortfalls within the tolerance are listed too: the tolerance allows them, it doesn't hide them.
  const grossShort = r.months.filter((m) => m.inboxGross.qbo > m.inboxGross.ours);
  if (grossShort.length) {
    out.push("Inbox gross check: if the books agree, every dollar QuickBooks has in its accounts mapped to the Inbox is one of our Inbox rows.", "");
    for (const m of grossShort) {
      const feeds = r.cells.find((c) => c.month === m.month && c.key === INBOX_KEY)?.feeds ?? [];
      const accounts = feeds.map((f) => `${f.account} ${money(f.cents)}`).join(", ");
      const within = inboxGrossShort(m, r.toleranceCents) ? "" : ` (within the ${money(r.toleranceCents)} tolerance)`;
      out.push(
        `- ${m.column.label}: QuickBooks has ${money(m.inboxGross.qbo)} in accounts mapped to the Inbox (${accounts}; signs ignored), but our Inbox has only ${money(m.inboxGross.ours)} of money in and out. Netting them could hide that difference${within}.`,
      );
    }
    out.push("");
  }

  out.push(`## Mismatched cells (${r.mismatches.length})`, "");
  if (!r.mismatches.length) out.push("Every month × category cell matches.", "");
  for (const c of r.mismatches) {
    out.push(`### ${c.column.label} · ${c.label} (${c.kind})`, "");
    out.push(`QuickBooks ${money(c.qbo)} · ours ${money(c.ours)} · diff ${signed(c.diff)}`, "");
    if (c.note) out.push(`- ${c.note}`);
    const feeds = c.feeds.map((f) => `${f.account} ${money(f.cents)}`).join(", ");
    out.push(`- QuickBooks accounts: ${feeds || "none (QuickBooks has nothing here)"}`);
    if (!c.lines.length) {
      out.push("- Our transactions: none", "");
      continue;
    }
    out.push(`- Our transactions (${c.lines.length}):`, "");
    out.push("| Date | Amount | Description | Source | Open |");
    out.push("|---|--:|---|---|---|");
    for (const l of c.lines.slice(0, MAX_LINES_PER_CELL)) {
      const split = l.split ? ` (split ${l.index}/${l.count}${l.memo ? `: ${l.memo}` : ""})` : "";
      out.push(`| ${l.date} | ${signed(l.amountCents)} | ${md(l.tx.description + split)} | ${l.tx.source} | /transactions/${l.tx.id} |`);
    }
    if (c.lines.length > MAX_LINES_PER_CELL) out.push("", `…and ${c.lines.length - MAX_LINES_PER_CELL} more.`);
    out.push("");
  }

  if (r.withinTolerance.length) {
    out.push(`## Cells within the ${money(r.toleranceCents)} tolerance (${r.withinTolerance.length})`, "");
    out.push("These differ, but by no more than the tolerance per cell. Month totals are still checked against the tolerance.", "");
    for (const c of r.withinTolerance) {
      out.push(`- ${c.column.label} · ${c.label}: QuickBooks ${money(c.qbo)} · ours ${money(c.ours)} · diff ${signed(c.diff)}`);
    }
    out.push("");
  }

  out.push("## Inbox (uncategorized) by month", "");
  out.push("| Month | Money in | Rows in | Money out | Rows out |");
  out.push("|---|--:|--:|--:|--:|");
  for (const m of r.inbox) {
    out.push(`| ${md(m.column.label)} | ${money(m.inCents)} | ${m.inCount} | ${money(m.outCents)} | ${m.outCount} |`);
  }
  out.push("");

  out.push("## Account mapping", "");
  const list = (title: string, items: string[]) => {
    out.push(`${title}: ${items.length ? "" : "none"}`);
    for (const i of items) out.push(`- ${i}`);
    out.push("");
  };
  list(
    "QuickBooks accounts not mapped to anything of ours (add them to --map)",
    r.unmapped.map((m) => `${m.fullName} (${SECTION_LABEL[m.account.section]})`),
  );
  list(
    "Our categories no QuickBooks account maps to",
    r.unmatchedCategories.map((u) => `${u.category.name} (${u.category.kind}, ${money(u.cents)} in range)`),
  );
  if (r.toTransfers.length) {
    list(
      "QuickBooks P&L accounts mapped to one of our transfer categories (left out of our P&L)",
      r.toTransfers.map((m) => m.fullName),
    );
  }
  out.push("| QuickBooks account | Section | Ours | How |");
  out.push("|---|---|---|---|");
  for (const m of r.mappings) {
    const target = m.targetLabel ?? "not mapped";
    const how = m.via ? `${m.via}${m.rolledUpTo ? ` (via parent "${m.rolledUpTo}")` : ""}` : "";
    out.push(`| ${md(m.fullName)} | ${SECTION_LABEL[m.account.section]} | ${md(target)} | ${how} |`);
  }
  out.push("");
  const partial = partialMonthWarning(r.columns);
  if (partial) out.push(partial);
  out.push(mismatchSummary(r));
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// Command-line arguments

export type CompareArgs = {
  file: string;
  from?: MonthKey;
  to?: MonthKey;
  toleranceCents: number;
  mapFile?: string;
  outFile?: string;
};

export const USAGE =
  "Usage: npm run qbo:compare -- <pnl-by-month.csv> [--from YYYY-MM] [--to YYYY-MM] [--tolerance-cents N] [--map map.json] [--out report.md]";

export function parseCompareArgs(argv: string[]): CompareArgs {
  const args: Partial<CompareArgs> & { toleranceCents: number } = { toleranceCents: 0 };
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) throw new QboCompareInputError(`${flag} needs a value. ${USAGE}`);
      // An empty value (`--out=`, `--map ""`, an unset shell variable) must not quietly drop the
      // option: a stale report.md or a missing --map would then pass for this run's result.
      if (!v.trim()) throw new QboCompareInputError(`${flag} was given an empty value. Pass a file name, or leave ${flag} out.`);
      return v;
    };
    const month = () => {
      const v = value();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw new QboCompareInputError(`${flag} must be a month like 2026-09, not "${v}".`);
      return v;
    };
    switch (flag) {
      case "--from":
        args.from = month();
        break;
      case "--to":
        args.to = month();
        break;
      case "--tolerance-cents": {
        const v = value();
        if (!/^\d+$/.test(v)) throw new QboCompareInputError(`--tolerance-cents must be a whole number of cents, not "${v}".`);
        args.toleranceCents = Number(v);
        break;
      }
      case "--map":
        args.mapFile = value();
        break;
      case "--out":
        args.outFile = value();
        break;
      default:
        if (a.startsWith("--")) throw new QboCompareInputError(`Unknown option ${a}. ${USAGE}`);
        files.push(a);
    }
  }
  if (files.length !== 1) throw new QboCompareInputError(USAGE);
  if (args.from && args.to && args.from > args.to) throw new QboCompareInputError(`--from ${args.from} is after --to ${args.to}.`);
  return { ...args, file: files[0] };
}
