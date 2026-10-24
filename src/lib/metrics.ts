/**
 * Business-health calculations. Pure functions over plain data so the dashboard,
 * reports and tests all share one implementation.
 */
import { monthEnd, monthOf, monthStart, type IsoDate, type MonthKey } from "./dates";

export type MetricTx = {
  date: IsoDate;
  amountCents: number;
  categoryId: string | null;
  stylistId: string | null;
};

export type MetricCategory = { id: string; name: string; kind: "income" | "expense" | "transfer" };

export type MetricStylist = {
  id: string;
  name: string;
  rentCents: number;
  rentCadence: "weekly" | "biweekly" | "monthly";
  startDate: IsoDate;
  endDate: IsoDate | null;
};

export const UNCATEGORIZED_IN = "__uncategorized_in";
export const UNCATEGORIZED_OUT = "__uncategorized_out";

export type PnlLine = { categoryId: string; name: string; cents: number };
export type Pnl = {
  income: PnlLine[];
  expenses: PnlLine[];
  totalIncome: number;
  totalExpenses: number; // positive number
  net: number;
  uncategorizedCount: number;
};

function inRange(date: IsoDate, from: IsoDate, to: IsoDate) {
  return date >= from && date <= to;
}

/**
 * Profit & loss for a date range (inclusive).
 * - Transfer categories (owner draws/contributions, moving money between accounts) are excluded.
 * - Uncategorized money is still counted, as "Uncategorized", so totals tie out to the bank.
 * - Income lines are positive; expense lines are reported as positive amounts.
 *   A refund in an expense category reduces that category.
 */
export function computePnl(
  txs: MetricTx[],
  categories: MetricCategory[],
  from: IsoDate,
  to: IsoDate,
): Pnl {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const income = new Map<string, PnlLine>();
  const expenses = new Map<string, PnlLine>();
  let uncategorizedCount = 0;

  for (const tx of txs) {
    if (!inRange(tx.date, from, to)) continue;
    const cat = tx.categoryId ? byId.get(tx.categoryId) : undefined;
    if (cat?.kind === "transfer") continue;

    if (!cat) {
      uncategorizedCount++;
      const target = tx.amountCents >= 0 ? income : expenses;
      const id = tx.amountCents >= 0 ? UNCATEGORIZED_IN : UNCATEGORIZED_OUT;
      const line = target.get(id) ?? { categoryId: id, name: "Uncategorized", cents: 0 };
      line.cents += Math.abs(tx.amountCents);
      target.set(id, line);
      continue;
    }

    const target = cat.kind === "income" ? income : expenses;
    const line = target.get(cat.id) ?? { categoryId: cat.id, name: cat.name, cents: 0 };
    // Income: amount as-is. Expense: money out is negative, so flip it.
    line.cents += cat.kind === "income" ? tx.amountCents : -tx.amountCents;
    target.set(cat.id, line);
  }

  const sort = (a: PnlLine, b: PnlLine) => b.cents - a.cents;
  const incomeLines = [...income.values()].sort(sort);
  const expenseLines = [...expenses.values()].sort(sort);
  const totalIncome = incomeLines.reduce((s, l) => s + l.cents, 0);
  const totalExpenses = expenseLines.reduce((s, l) => s + l.cents, 0);
  return {
    income: incomeLines,
    expenses: expenseLines,
    totalIncome,
    totalExpenses,
    net: totalIncome - totalExpenses,
    uncategorizedCount,
  };
}

export type MonthSummary = { month: MonthKey; income: number; expenses: number; profit: number };

export function monthlySummaries(
  txs: MetricTx[],
  categories: MetricCategory[],
  months: MonthKey[],
): MonthSummary[] {
  return months.map((month) => {
    const p = computePnl(txs, categories, monthStart(month), monthEnd(month));
    return { month, income: p.totalIncome, expenses: p.totalExpenses, profit: p.net };
  });
}

/** Expense totals per category per month, for the "expenses over time" view. */
export function expensesByCategory(
  txs: MetricTx[],
  categories: MetricCategory[],
  months: MonthKey[],
): { categoryId: string; name: string; byMonth: Record<MonthKey, number>; total: number }[] {
  const rows = new Map<string, { categoryId: string; name: string; byMonth: Record<MonthKey, number>; total: number }>();
  for (const month of months) {
    const p = computePnl(txs, categories, monthStart(month), monthEnd(month));
    for (const line of p.expenses) {
      const row = rows.get(line.categoryId) ?? {
        categoryId: line.categoryId,
        name: line.name,
        byMonth: Object.fromEntries(months.map((m) => [m, 0])),
        total: 0,
      };
      row.byMonth[month] += line.cents;
      row.total += line.cents;
      rows.set(line.categoryId, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function isStylistActiveInMonth(s: MetricStylist, month: MonthKey): boolean {
  return s.startDate <= monthEnd(month) && (!s.endDate || s.endDate >= monthStart(month));
}

/**
 * Rent expected from a stylist in a month.
 * - Monthly: one payment per active month.
 * - Weekly / biweekly: count the due dates (start date + every 7 or 14 days)
 *   that fall in the month and within their active dates.
 */
export function expectedRentForMonth(s: MetricStylist, month: MonthKey): number {
  if (!isStylistActiveInMonth(s, month)) return 0;
  if (s.rentCadence === "monthly") return s.rentCents;

  const step = s.rentCadence === "weekly" ? 7 : 14;
  const from = monthStart(month);
  const to = monthEnd(month);
  const end = s.endDate && s.endDate < to ? s.endDate : to;

  // Jump close to the month start instead of looping from the very first week.
  const [sy, sm, sd] = s.startDate.split("-").map(Number);
  const [fy, fm, fd] = from.split("-").map(Number);
  const daysBetween = Math.floor((Date.UTC(fy, fm - 1, fd) - Date.UTC(sy, sm - 1, sd)) / 86_400_000);
  let due = daysBetween > 0 ? addDays(s.startDate, Math.floor(daysBetween / step) * step) : s.startDate;

  let count = 0;
  while (due <= end) {
    if (due >= from) count++;
    due = addDays(due, step);
  }
  return count * s.rentCents;
}

export type RentStatus = {
  stylistId: string;
  name: string;
  expected: number;
  collected: number;
  balance: number; // collected - expected; negative = behind
  status: "paid" | "behind" | "ahead" | "not_due";
};

/** Expected vs. collected booth rent for every stylist active in the month. */
export function rentStatusForMonth(
  stylists: MetricStylist[],
  txs: MetricTx[],
  boothRentCategoryId: string | null,
  month: MonthKey,
): RentStatus[] {
  const collectedBy = new Map<string, number>();
  for (const tx of txs) {
    if (!tx.stylistId || monthOf(tx.date) !== month) continue;
    if (boothRentCategoryId && tx.categoryId !== boothRentCategoryId) continue;
    collectedBy.set(tx.stylistId, (collectedBy.get(tx.stylistId) ?? 0) + tx.amountCents);
  }

  return stylists
    .filter((s) => isStylistActiveInMonth(s, month) || collectedBy.has(s.id))
    .map((s) => {
      const expected = expectedRentForMonth(s, month);
      const collected = collectedBy.get(s.id) ?? 0;
      const balance = collected - expected;
      const status: RentStatus["status"] =
        expected === 0 ? "not_due" : balance < 0 ? "behind" : balance > 0 ? "ahead" : "paid";
      return { stylistId: s.id, name: s.name, expected, collected, balance, status };
    })
    .sort((a, b) => a.balance - b.balance || a.name.localeCompare(b.name));
}

export function occupancyForMonth(stylists: MetricStylist[], totalChairs: number, month: MonthKey) {
  const filled = stylists.filter((s) => isStylistActiveInMonth(s, month)).length;
  return {
    filled,
    total: totalChairs,
    ratio: totalChairs > 0 ? Math.min(filled / totalChairs, 1) : null,
  };
}

/**
 * Current balance = opening balance (as of the start of `asOf`) plus every transaction on or after it.
 * Transfers are included here: they really do move money in and out of the account.
 */
export function currentBalance(opening: { cents: number; asOf: IsoDate }, txs: MetricTx[]): number {
  return txs.reduce((sum, tx) => (tx.date >= opening.asOf ? sum + tx.amountCents : sum), opening.cents);
}

/**
 * Months of runway: how long the current balance covers average monthly expenses if income stopped.
 * Uses the average of the given complete months. Null when there's no expense history.
 */
export function runwayMonths(balanceCents: number, recentMonths: MonthSummary[]): number | null {
  const withSpend = recentMonths.filter((m) => m.expenses > 0);
  if (!withSpend.length) return null;
  const avg = withSpend.reduce((s, m) => s + m.expenses, 0) / withSpend.length;
  if (avg <= 0) return null;
  return Math.max(balanceCents, 0) / avg;
}
