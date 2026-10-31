import { describe, expect, it } from "vitest";
import { expandLedgerLines, inOutTotals, toMetricTxs, type LedgerSplit, type LedgerTx } from "./ledger";
import {
  computePnl,
  currentBalance,
  expensesByCategory,
  monthlySummaries,
  rentStatusForMonth,
  type MetricCategory,
  type MetricStylist,
} from "./metrics";

const cats: MetricCategory[] = [
  { id: "booth", name: "Booth Rent", kind: "income" },
  { id: "sales", name: "Product Sales", kind: "income" },
  { id: "fees", name: "Bank & Payment Fees", kind: "expense" },
  { id: "supplies", name: "Supplies", kind: "expense" },
  { id: "draw", name: "Owner Draw", kind: "transfer" },
];

const tx = (id: string, date: string, amountCents: number, categoryId: string | null, stylistId: string | null = null): LedgerTx => ({
  id,
  date,
  amountCents,
  categoryId,
  stylistId,
  isSplit: false,
});
const parent = (id: string, date: string, amountCents: number): LedgerTx => ({ ...tx(id, date, amountCents, null), isSplit: true });
const split = (
  transactionId: string,
  position: number,
  categoryId: string,
  amountCents: number,
  stylistId: string | null = null,
  memo: string | null = null,
): LedgerSplit => ({ transactionId, position, categoryId, stylistId, amountCents, memo });

// October: a $500 deposit covering Jane's and Kim's rent, a Square deposit net of fees, and a
// Costco run that was partly the owner's.
const txs: LedgerTx[] = [
  parent("dep", "2026-10-03", 50000),
  parent("sq", "2026-10-05", 10000),
  parent("costco", "2026-10-09", -6000),
  tx("rent-jane", "2026-10-10", 25000, "booth", "jane"),
  tx("util", "2026-10-12", -4000, "supplies"),
  tx("loose", "2026-10-14", -700, null),
  tx("sep", "2026-09-20", -3000, "supplies"),
];
const splits: LedgerSplit[] = [
  // Deliberately out of order: position decides.
  split("dep", 1, "booth", 25000, "kim"),
  split("dep", 0, "booth", 25000, "jane"),
  split("sq", 0, "sales", 10300, null, "Square sales"),
  split("sq", 1, "fees", -300, null, "Square fee"),
  split("costco", 0, "supplies", -4500),
  split("costco", 1, "draw", -1500, null, "Personal"),
];

describe("expandLedgerLines", () => {
  const lines = expandLedgerLines(txs, splits);

  it("turns each split parent into its lines, in position order, carrying the parent's date", () => {
    const dep = lines.filter((l) => l.tx.id === "dep");
    expect(dep.map((l) => [l.date, l.categoryId, l.stylistId, l.amountCents, l.index, l.count])).toEqual([
      ["2026-10-03", "booth", "jane", 25000, 1, 2],
      ["2026-10-03", "booth", "kim", 25000, 2, 2],
    ]);
    expect(lines.find((l) => l.tx.id === "sq" && l.index === 2)?.memo).toBe("Square fee");
  });

  it("keeps unsplit transactions as one line and the original order", () => {
    expect(lines.map((l) => l.tx.id)).toEqual(["dep", "dep", "sq", "sq", "costco", "costco", "rent-jane", "util", "loose", "sep"]);
    const jane = lines.find((l) => l.tx.id === "rent-jane")!;
    expect(jane).toMatchObject({ split: null, index: 1, count: 1, categoryId: "booth", stylistId: "jane", memo: null });
  });

  it("lines of a split sum to the parent, so the total is unchanged", () => {
    const sum = (xs: { amountCents: number }[]) => xs.reduce((s, x) => s + x.amountCents, 0);
    expect(sum(lines)).toBe(sum(txs));
    for (const p of txs.filter((t) => t.isSplit)) {
      expect(sum(lines.filter((l) => l.tx.id === p.id))).toBe(p.amountCents);
    }
  });

  it("leaves a split parent with no lines as one uncategorized line instead of dropping it", () => {
    const orphan = expandLedgerLines([parent("x", "2026-10-01", 1234)], []);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toMatchObject({ amountCents: 1234, categoryId: null, split: null });
  });

  it("ignores lines whose parent isn't flagged split, or isn't in the list", () => {
    const out = expandLedgerLines([tx("a", "2026-10-01", 500, "sales")], [split("a", 0, "fees", 500), split("zzz", 0, "fees", 1)]);
    expect(out).toHaveLength(1);
    expect(out[0].categoryId).toBe("sales");
  });
});

describe("metrics over ledger lines (split parents expanded)", () => {
  const m = toMetricTxs(expandLedgerLines(txs, splits));

  it("P&L counts each line in its own category and leaves the transfer line out", () => {
    const p = computePnl(m, cats, "2026-10-01", "2026-10-31");
    const by = (list: { categoryId: string; cents: number }[], id: string) => list.find((l) => l.categoryId === id)?.cents;
    expect(by(p.income, "booth")).toBe(75000);
    expect(by(p.income, "sales")).toBe(10300);
    expect(by(p.expenses, "fees")).toBe(300);
    expect(by(p.expenses, "supplies")).toBe(4500 + 4000);
    expect(p.expenses.some((l) => l.categoryId === "draw")).toBe(false);
    expect(p.uncategorizedCount).toBe(1); // only the loose -$7, never a split parent
    expect(p.totalIncome).toBe(85300);
    expect(p.totalExpenses).toBe(300 + 8500 + 700);
    expect(p.net).toBe(85300 - 9500);
  });

  it("monthly profit uses the lines", () => {
    const [sep, oct] = monthlySummaries(m, cats, ["2026-09", "2026-10"]);
    expect(sep).toEqual({ month: "2026-09", income: 0, expenses: 3000, profit: -3000 });
    expect(oct.profit).toBe(85300 - 9500);
  });

  it("booth rent collected is credited per stylist from split lines", () => {
    const stylists: MetricStylist[] = [
      { id: "jane", name: "Jane", rentCents: 50000, rentCadence: "monthly", startDate: "2026-01-01", endDate: null },
      { id: "kim", name: "Kim", rentCents: 25000, rentCadence: "monthly", startDate: "2026-01-01", endDate: null },
    ];
    const rent = rentStatusForMonth(stylists, m, "booth", "2026-10");
    expect(rent.find((r) => r.stylistId === "jane")).toMatchObject({ collected: 50000, status: "paid" });
    expect(rent.find((r) => r.stylistId === "kim")).toMatchObject({ collected: 25000, status: "paid" });
  });

  it("expenses by category see the fee and supplies lines", () => {
    const rows = expensesByCategory(m, cats, ["2026-09", "2026-10"]);
    expect(rows.find((r) => r.categoryId === "supplies")?.byMonth).toEqual({ "2026-09": 3000, "2026-10": 8500 });
    expect(rows.find((r) => r.categoryId === "fees")?.byMonth["2026-10"]).toBe(300);
    expect(rows.some((r) => r.categoryId === "draw")).toBe(false);
  });

  it("the cash balance is the same with or without expansion", () => {
    const opening = { cents: 100000, asOf: "2026-09-01" };
    const unexpanded = txs.map((t) => ({ date: t.date, amountCents: t.amountCents, categoryId: t.categoryId, stylistId: t.stylistId }));
    expect(currentBalance(opening, m)).toBe(currentBalance(opening, unexpanded));
  });
});

describe("inOutTotals", () => {
  it("leaves transfer lines out and counts a net deposit's fee as money out", () => {
    const kinds = new Map(cats.map((c) => [c.id, c.kind]));
    const lines = expandLedgerLines(txs, splits).filter((l) => l.date >= "2026-10-01");
    const totals = inOutTotals(lines.map((l) => ({ amountCents: l.amountCents, kind: l.categoryId ? (kinds.get(l.categoryId) ?? null) : null })));
    expect(totals.moneyIn).toBe(50000 + 10300 + 25000);
    expect(totals.moneyOut).toBe(300 + 4500 + 4000 + 700);
  });
});
