/**
 * Compares our cash-basis P&L with a QuickBooks "Profit and Loss by Month" export, month by month
 * and category by category, and writes the result as Markdown. Pure: the database side is in
 * qbo-compare-db.ts and the CLI in scripts/qbo-compare.ts.
 *
 * Our numbers come from `computePnl` over ledger lines (splits expanded), so this measures exactly
 * what the app's P&L shows: transfers left out, uncategorized money counted as "Uncategorized".
 * The comparison is at OUR category level: several QuickBooks accounts may feed one category.
 */
import type { MonthKey } from "./dates";
import { categoryKey, isPlaceholderCategory, type CategoryKind } from "./import-categories";
import { toMetricTxs, type LedgerLine, type LedgerSplit, type LedgerTx } from "./ledger";
import { computePnl, UNCATEGORIZED_IN, UNCATEGORIZED_OUT } from "./metrics";
import { formatCents } from "./money";
import { SECTION_LABEL, sectionDirection, type QboAccount, type QboColumn, type QboPnl, type QboSection } from "./qbo-pnl";

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

/** Saved import choices may be any of the FileCategoryChoice shapes; only these matter here. */
type SavedChoice = { type: "existing"; categoryId: string } | { type: "inbox" } | { type: "new"; name: string };

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

/** The saved import mapping, keyed like `mapKey`. Unknown shapes are ignored. */
function savedIndex(saved: Record<string, unknown> | null | undefined): Map<string, SavedChoice> {
  const out = new Map<string, SavedChoice>();
  for (const [key, v] of Object.entries(saved ?? {})) {
    if (!v || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    if (c.type === "inbox") out.set(mapKey(key), { type: "inbox" });
    else if (c.type === "existing" && typeof c.categoryId === "string") out.set(mapKey(key), { type: "existing", categoryId: c.categoryId });
    else if (c.type === "new" && typeof c.name === "string") out.set(mapKey(key), { type: "new", name: c.name });
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
    if (s.type === "existing") return ids.has(s.categoryId) ? { type: "category", categoryId: s.categoryId } : null;
    const created = categoryByName(categories, s.name);
    return created ? { type: "category", categoryId: created.id } : null;
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

/** One month x one of our categories (or our Inbox, or an unmapped QuickBooks account). */
export type Cell = {
  month: MonthKey;
  column: QboColumn;
  /** Our category id, UNCATEGORIZED_IN / UNCATEGORIZED_OUT, or "qbo:<account>" for an unmapped account. */
  key: string;
  label: string;
  kind: CategoryKind;
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
  qbo: { income: number; expenses: number; net: number };
  ours: { income: number; expenses: number; net: number };
};

export type InboxMonth = { month: MonthKey; column: QboColumn; inCents: number; inCount: number; outCents: number; outCount: number };

export type CompareResult = {
  columns: QboColumn[];
  toleranceCents: number;
  months: MonthTotals[];
  cells: Cell[];
  mismatches: Cell[];
  totalAbsDiff: number;
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

const UNCAT_LABEL: Record<string, string> = {
  [UNCATEGORIZED_IN]: "Inbox: uncategorized money in",
  [UNCATEGORIZED_OUT]: "Inbox: uncategorized money out",
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

  for (const column of pnl.columns) {
    const { month } = column;
    const ours = computePnl(metricTxs, categories, column.from, column.to);
    const cellMap = new Map<string, Cell>();
    const cell = (key: string, label: string, kind: CategoryKind): Cell => {
      let c = cellMap.get(key);
      if (!c) {
        c = { month, column, key, label, kind, qbo: 0, ours: 0, diff: 0, feeds: [], lines: [], note: null };
        cellMap.set(key, c);
      }
      return c;
    };

    for (const line of [...ours.income, ...ours.expenses]) {
      const cat = byId.get(line.categoryId);
      const kind: CategoryKind = cat?.kind ?? (line.categoryId === UNCATEGORIZED_IN ? "income" : "expense");
      cell(line.categoryId, cat?.name ?? UNCAT_LABEL[line.categoryId] ?? line.name, kind).ours += line.cents;
      if (cat) ourCategoryTotals.set(cat.id, (ourCategoryTotals.get(cat.id) ?? 0) + Math.abs(line.cents));
    }

    let qboIncome = 0;
    let qboExpenses = 0;
    for (const m of mappings) {
      const cents = m.account.cents[month] ?? 0;
      const dir = sectionDirection(m.account.section);
      if (dir === "income") qboIncome += cents;
      else qboExpenses += cents;
      if (!cents) continue;

      let c: Cell;
      let signed = cents;
      if (!m.target) {
        c = cell(`qbo:${m.fullName}`, `QuickBooks "${m.fullName}" (not mapped)`, dir);
        c.note = `Not mapped to any of our categories. Add it to --map.`;
      } else if (m.target.type === "inbox") {
        const key = dir === "income" ? UNCATEGORIZED_IN : UNCATEGORIZED_OUT;
        c = cell(key, UNCAT_LABEL[key], dir);
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

    for (const c of cellMap.values()) {
      c.diff = c.ours - c.qbo;
      cells.push(c);
    }
    months.push({
      month,
      column,
      qbo: { income: qboIncome, expenses: qboExpenses, net: qboIncome - qboExpenses },
      ours: { income: ours.totalIncome, expenses: ours.totalExpenses, net: ours.net },
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

  const mismatches = cells.filter((c) => Math.abs(c.diff) > tolerance);
  for (const c of mismatches) c.lines = linesInCell(lines, c);
  const kindOrder: Record<CategoryKind, number> = { income: 0, expense: 1, transfer: 2 };
  mismatches.sort(
    (a, b) => a.month.localeCompare(b.month) || kindOrder[a.kind] - kindOrder[b.kind] || Math.abs(b.diff) - Math.abs(a.diff) || a.label.localeCompare(b.label),
  );

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
    totalAbsDiff: mismatches.reduce((s, c) => s + Math.abs(c.diff), 0),
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
    .filter((l) => {
      if (c.key === UNCATEGORIZED_IN) return l.categoryId === null && l.amountCents >= 0;
      if (c.key === UNCATEGORIZED_OUT) return l.categoryId === null && l.amountCents < 0;
      return l.categoryId === c.key;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.tx.description.localeCompare(b.tx.description));
}

// ---------------------------------------------------------------------------------------------
// Markdown report

const money = (c: number) => formatCents(c);
const signed = (c: number) => (c === 0 ? "0" : formatCents(c, { signed: true }));
/** Text safe inside a Markdown table cell. */
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const MAX_LINES_PER_CELL = 50;

export function mismatchSummary(r: Pick<CompareResult, "mismatches" | "totalAbsDiff">): string {
  if (!r.mismatches.length) return "MATCH";
  const n = r.mismatches.length;
  return `${n} ${n === 1 ? "mismatch" : "mismatches"}, total abs diff ${money(r.totalAbsDiff)}`;
}

export function formatReport(r: CompareResult, meta: { file: string; basis: QboPnl["basis"]; readOnly: boolean }): string {
  const out: string[] = [];
  const first = r.columns[0];
  const last = r.columns[r.columns.length - 1];
  const basis = meta.basis ? `${meta.basis[0].toUpperCase()}${meta.basis.slice(1)} basis` : "basis not stated";
  out.push("# QuickBooks vs our books: Profit and Loss by Month", "");
  out.push(`- QuickBooks file: ${meta.file} (${basis})`);
  out.push(`- Months: ${first.label} to ${last.label} (${r.columns.length})`);
  out.push(`- Tolerance: ${money(r.toleranceCents)} per cell`);
  out.push("- Diff = ours − QuickBooks. Income and expenses are both positive, as in QuickBooks. Transfers are left out.");
  if (meta.readOnly) out.push("- Read only: our books were read in a READ ONLY database transaction.");
  out.push("");

  if (r.warnings.length) {
    out.push("## Warnings", "");
    for (const w of r.warnings) out.push(`- ${w}`);
    out.push("");
  }

  out.push("## By month", "");
  out.push("| Month | Income QB | Income ours | Diff | Expenses QB | Expenses ours | Diff | Net QB | Net ours | Diff |");
  out.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const m of r.months) {
    const d = (a: number, b: number) => signed(b - a);
    out.push(
      `| ${md(m.column.label)} | ${money(m.qbo.income)} | ${money(m.ours.income)} | ${d(m.qbo.income, m.ours.income)} | ${money(m.qbo.expenses)} | ${money(m.ours.expenses)} | ${d(m.qbo.expenses, m.ours.expenses)} | ${money(m.qbo.net)} | ${money(m.ours.net)} | ${d(m.qbo.net, m.ours.net)} |`,
    );
  }
  out.push("");

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
