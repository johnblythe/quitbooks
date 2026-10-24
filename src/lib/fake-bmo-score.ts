/**
 * Scores the importer + categorizer against a fake-BMO truth file. This is a baseline: it runs the
 * real `parseBankCsv` (auto-detected mapping) and the real `categorize`, and reports where they
 * disagree with the truth. It never changes how either behaves.
 */
import { categorize, type MatchableRule, type MatchableStylist } from "./categorize";
import { parseBankCsv, type RowError } from "./csv";
import type { FakeTruth } from "./fake-bmo";

type BaselineRule = { pattern: string; category: string; direction: "any" | "in" | "out" };

/**
 * The seed script doesn't create any rules, so this is the rule set the owners would plausibly have
 * built up after a few weeks of using the Inbox: recurring vendors only, with no direction set.
 * One-offs (the equipment purchase, bank interest, the odd deposit) deliberately have no rule.
 */
export const BASELINE_RULES: readonly BaselineRule[] = [
  { pattern: "SALLY BEAUTY", category: "Supplies", direction: "any" },
  { pattern: "SALONCENTRIC", category: "Supplies", direction: "any" },
  { pattern: "COSMOPROF", category: "Supplies", direction: "any" },
  { pattern: "AMAZON", category: "Supplies", direction: "any" },
  { pattern: "COSTCO", category: "Supplies", direction: "any" },
  { pattern: "MERIDIAN PROPERTY", category: "Rent & Lease", direction: "any" },
  { pattern: "AES INDIANA", category: "Utilities", direction: "any" },
  { pattern: "CITIZENS ENERGY", category: "Utilities", direction: "any" },
  { pattern: "COMCAST", category: "Utilities", direction: "any" },
  { pattern: "HISCOX", category: "Insurance", direction: "any" },
  { pattern: "METRO LINEN", category: "Cleaning & Laundry", direction: "any" },
  { pattern: "BRIGHT SIDE CLEANING", category: "Cleaning & Laundry", direction: "any" },
  { pattern: "VAGARO", category: "Software & Subscriptions", direction: "any" },
  { pattern: "GOOGLE", category: "Software & Subscriptions", direction: "any" },
  { pattern: "CANVA", category: "Software & Subscriptions", direction: "any" },
  { pattern: "INTUIT", category: "Software & Subscriptions", direction: "any" },
  { pattern: "FACEBK", category: "Marketing & Advertising", direction: "any" },
  { pattern: "MAINTENANCE FEE", category: "Bank & Payment Fees", direction: "any" },
  { pattern: "IRS USATAXPYMT", category: "Taxes", direction: "any" },
  { pattern: "TRANSFER TO", category: "Owner Draw", direction: "out" },
  { pattern: "TRANSFER FROM", category: "Owner Contribution", direction: "in" },
  { pattern: "VENMO", category: "Booth Rent", direction: "in" },
];

export type ScoredRow = {
  line: number;
  date: string;
  amountCents: number;
  description: string;
  gotCategory: string | null;
  gotStylist: string | null;
  expectedCategory: string;
  expectedStylist: string | null;
  trap?: string;
};

export type ScoreReport = {
  truthRows: number;
  parsedRows: number;
  parseErrors: RowError[];
  /** Parsed rows whose date/amount don't line up with the truth row at the same position. */
  misaligned: number;
  correct: number;
  wrong: ScoredRow[];
  uncategorized: ScoredRow[];
  /** Counts by trap tag: [correct, wrong, uncategorized]. */
  byTrap: Record<string, { correct: number; wrong: number; uncategorized: number }>;
};

export function scoreFakeBmo(csv: string, truth: FakeTruth): ScoreReport {
  const parsed = parseBankCsv(csv);
  const stylists: MatchableStylist[] = truth.roster.map((r) => ({
    id: r.name,
    name: r.name,
    matchText: r.matchText,
    startDate: r.startDate,
    endDate: r.endDate,
  }));
  const rules: MatchableRule[] = BASELINE_RULES.map((r, i) => ({
    id: `rule-${i}`,
    pattern: r.pattern,
    categoryId: r.category,
    direction: r.direction,
    priority: 100,
  }));

  const report: ScoreReport = {
    truthRows: truth.rows.length,
    parsedRows: parsed.rows.length,
    parseErrors: parsed.errors,
    misaligned: 0,
    correct: 0,
    wrong: [],
    uncategorized: [],
    byTrap: {},
  };
  const bump = (trap: string | undefined, key: "correct" | "wrong" | "uncategorized") => {
    if (!trap) return;
    for (const t of trap.split("+")) {
      const e = (report.byTrap[t] ??= { correct: 0, wrong: 0, uncategorized: 0 });
      e[key]++;
    }
  };

  parsed.rows.forEach((row, i) => {
    const expected = truth.rows[i];
    if (!expected || expected.date !== row.date || expected.amountCents !== row.amountCents) {
      report.misaligned++;
      return;
    }
    const got = categorize(row, { stylists, rules, boothRentCategoryId: "Booth Rent" });
    const scored: ScoredRow = {
      line: row.line,
      date: row.date,
      amountCents: row.amountCents,
      description: row.description,
      gotCategory: got.categoryId,
      gotStylist: got.stylistId,
      expectedCategory: expected.category,
      expectedStylist: expected.stylist,
      trap: expected.trap,
    };
    if (got.categoryId === null) {
      report.uncategorized.push(scored);
      bump(expected.trap, "uncategorized");
    } else if (got.categoryId === expected.category && got.stylistId === expected.stylist) {
      report.correct++;
      bump(expected.trap, "correct");
    } else {
      report.wrong.push(scored);
      bump(expected.trap, "wrong");
    }
  });
  return report;
}

const money = (c: number) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

export function formatScoreReport(r: ScoreReport): string {
  const out: string[] = [];
  const expectedTag = (s: ScoredRow) => `${s.expectedCategory}${s.expectedStylist ? ` / ${s.expectedStylist}` : ""}`;
  const gotTag = (s: ScoredRow) => `${s.gotCategory ?? "(none)"}${s.gotStylist ? ` / ${s.gotStylist}` : ""}`;
  out.push(`Rows in truth: ${r.truthRows}   parsed: ${r.parsedRows}   misaligned: ${r.misaligned}`);
  out.push(`Correct: ${r.correct}   Wrong: ${r.wrong.length}   Uncategorized: ${r.uncategorized.length}   Parse errors: ${r.parseErrors.length}`);
  if (r.parseErrors.length) {
    out.push("", "Parse errors:");
    for (const e of r.parseErrors) out.push(`  line ${e.line}: ${e.message}`);
  }
  if (r.wrong.length) {
    out.push("", "Wrong:");
    for (const w of r.wrong) {
      out.push(`  ${w.date} ${money(w.amountCents)} ${w.description}`);
      out.push(`      got ${gotTag(w)}  expected ${expectedTag(w)}${w.trap ? `  [trap: ${w.trap}]` : ""}`);
    }
  }
  if (r.uncategorized.length) {
    out.push("", "Uncategorized (would land in the Inbox):");
    for (const u of r.uncategorized) {
      out.push(`  ${u.date} ${money(u.amountCents)} ${u.description}  expected ${expectedTag(u)}${u.trap ? `  [trap: ${u.trap}]` : ""}`);
    }
  }
  const traps = Object.entries(r.byTrap).sort(([a], [b]) => a.localeCompare(b));
  if (traps.length) {
    out.push("", "By trap (correct / wrong / uncategorized):");
    for (const [t, c] of traps) out.push(`  ${t.padEnd(36)} ${c.correct} / ${c.wrong} / ${c.uncategorized}`);
  }
  return out.join("\n");
}
