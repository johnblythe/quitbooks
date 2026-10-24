import { describe, expect, it } from "vitest";
import {
  computePnl,
  currentBalance,
  expectedRentForMonth,
  expensesByCategory,
  monthlySummaries,
  occupancyForMonth,
  rentStatusForMonth,
  runwayMonths,
  type MetricCategory,
  type MetricStylist,
  type MetricTx,
} from "./metrics";

const cats: MetricCategory[] = [
  { id: "rent-in", name: "Booth Rent", kind: "income" },
  { id: "util", name: "Utilities", kind: "expense" },
  { id: "supplies", name: "Supplies", kind: "expense" },
  { id: "draw", name: "Owner Draw", kind: "transfer" },
];

const tx = (date: string, amountCents: number, categoryId: string | null, stylistId: string | null = null): MetricTx => ({
  date,
  amountCents,
  categoryId,
  stylistId,
});

const txs: MetricTx[] = [
  tx("2026-09-05", 25000, "rent-in", "jane"),
  tx("2026-09-10", -10000, "util"),
  tx("2026-10-01", 25000, "rent-in", "jane"),
  tx("2026-10-08", 25000, "rent-in", "jane"),
  tx("2026-10-02", -18000, "util"),
  tx("2026-10-03", -5000, "supplies"),
  tx("2026-10-04", 1000, "supplies"), // refund
  tx("2026-10-05", -50000, "draw"),
  tx("2026-10-06", -700, null),
  tx("2026-10-07", 300, null),
];

describe("computePnl", () => {
  it("totals income and expenses, skips transfers, nets refunds, keeps uncategorized", () => {
    const p = computePnl(txs, cats, "2026-10-01", "2026-10-31");
    expect(p.totalIncome).toBe(50300);
    expect(p.totalExpenses).toBe(18000 + 4000 + 700);
    expect(p.net).toBe(50300 - 22700);
    expect(p.uncategorizedCount).toBe(2);
    expect(p.expenses.find((l) => l.categoryId === "supplies")?.cents).toBe(4000);
    expect(p.expenses.some((l) => l.name === "Owner Draw")).toBe(false);
  });
});

describe("monthlySummaries + expensesByCategory", () => {
  it("summarizes by month", () => {
    const m = monthlySummaries(txs, cats, ["2026-09", "2026-10"]);
    expect(m[0]).toEqual({ month: "2026-09", income: 25000, expenses: 10000, profit: 15000 });
    expect(m[1].profit).toBe(50300 - 22700);
  });

  it("breaks expenses out by category and month", () => {
    const rows = expensesByCategory(txs, cats, ["2026-09", "2026-10"]);
    const util = rows.find((r) => r.categoryId === "util")!;
    expect(util.byMonth).toEqual({ "2026-09": 10000, "2026-10": 18000 });
    expect(util.total).toBe(28000);
  });
});

const jane: MetricStylist = {
  id: "jane",
  name: "Jane",
  rentCents: 25000,
  rentCadence: "weekly",
  startDate: "2026-09-01", // a Tuesday
  endDate: null,
};

describe("expectedRentForMonth", () => {
  it("counts weekly due dates in the month", () => {
    // Due Oct 6, 13, 20, 27 → 4 payments
    expect(expectedRentForMonth(jane, "2026-10")).toBe(100000);
    // Due Sep 1, 8, 15, 22, 29 → 5 payments
    expect(expectedRentForMonth(jane, "2026-09")).toBe(125000);
  });

  it("handles biweekly, monthly, and inactive months", () => {
    expect(expectedRentForMonth({ ...jane, rentCadence: "biweekly" }, "2026-09")).toBe(75000); // 1, 15, 29
    expect(expectedRentForMonth({ ...jane, rentCadence: "monthly", rentCents: 90000 }, "2026-10")).toBe(90000);
    expect(expectedRentForMonth(jane, "2026-08")).toBe(0);
    expect(expectedRentForMonth({ ...jane, endDate: "2026-10-14" }, "2026-10")).toBe(50000); // 6, 13
  });
});

describe("rentStatusForMonth", () => {
  it("compares collected to expected", () => {
    const [s] = rentStatusForMonth([jane], txs, "rent-in", "2026-10");
    expect(s).toMatchObject({ expected: 100000, collected: 50000, balance: -50000, status: "behind" });
  });
});

describe("occupancy, balance, runway", () => {
  it("computes occupancy", () => {
    expect(occupancyForMonth([jane, { ...jane, id: "x", endDate: "2026-08-31" }], 4, "2026-10")).toEqual({
      filled: 1,
      total: 4,
      ratio: 0.25,
    });
  });

  it("computes balance from an opening balance", () => {
    const b = currentBalance({ cents: 100000, asOf: "2026-10-01" }, txs);
    const octSum = txs.filter((t) => t.date >= "2026-10-01").reduce((s, t) => s + t.amountCents, 0);
    expect(b).toBe(100000 + octSum);
  });

  it("computes runway from average monthly expenses", () => {
    expect(
      runwayMonths(60000, [
        { month: "a", income: 0, expenses: 20000, profit: 0 },
        { month: "b", income: 0, expenses: 40000, profit: 0 },
      ]),
    ).toBe(2);
    expect(runwayMonths(60000, [])).toBeNull();
  });
});
