/**
 * The P&L CSV exports, built from plain data so the route handler stays thin and tests can check
 * the exact rows. Both files open with a title row that says "Cash basis": the app only records
 * cash in and out of the bank, which is what QuickBooks calls cash-basis accounting.
 */
import Papa from "papaparse";
import type { IsoDate } from "./dates";
import type { LedgerLine, LedgerSplit, LedgerTx } from "./ledger";
import type { Pnl } from "./metrics";

export const BUSINESS_NAME = "L Marie Studio LLC";
export const CASH_BASIS = "Cash basis";

type Kind = "income" | "expense" | "transfer";

export type DetailTx = LedgerTx & {
  description: string;
  note: string | null;
  categoryName: string | null;
  categoryKind: Kind | null;
  stylistName: string | null;
};

export type DetailSplit = LedgerSplit & {
  categoryName: string | null;
  categoryKind: Kind | null;
  stylistName: string | null;
};

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** Stops spreadsheet apps from treating bank text like "=HYPERLINK(...)" as a formula. */
export const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

function titleRow(report: string, from: IsoDate, to: IsoDate): string[] {
  return [BUSINESS_NAME, `${report} (${CASH_BASIS})`, `${from} to ${to}`];
}

export const DETAIL_HEADER = ["Date", "Description", "Amount", "Category", "Type", "Stylist", "Note", "Memo", "Split"];

/**
 * One row per ledger line: an unsplit transaction is one row; a split transaction is one row per
 * line, each carrying the parent's date, description and note plus the line's own category,
 * stylist, amount and memo, and "1 of 3"-style position.
 */
export function detailRows(lines: LedgerLine<DetailTx, DetailSplit>[]): string[][] {
  return lines.map((l) => {
    const src = l.split ?? l.tx;
    const categoryName = l.categoryId ? src.categoryName : null;
    return [
      l.date,
      safeText(l.tx.description),
      dollars(l.amountCents),
      safeText(categoryName ?? "Uncategorized"),
      (l.categoryId ? src.categoryKind : null) ?? (l.amountCents >= 0 ? "income" : "expense"),
      safeText((l.stylistId ? src.stylistName : null) ?? ""),
      safeText(l.tx.note ?? ""),
      safeText(l.memo ?? ""),
      l.split ? `${l.index} of ${l.count}` : "",
    ];
  });
}

export function detailCsv(lines: LedgerLine<DetailTx, DetailSplit>[], from: IsoDate, to: IsoDate): string {
  return Papa.unparse([titleRow("Transactions", from, to), DETAIL_HEADER, ...detailRows(lines)]);
}

export function summaryRows(pnl: Pnl): string[][] {
  return [
    ["Section", "Category", "Amount"],
    ...pnl.income.map((l) => ["Income", safeText(l.name), dollars(l.cents)]),
    ["Income", "Total income", dollars(pnl.totalIncome)],
    ...pnl.expenses.map((l) => ["Expenses", safeText(l.name), dollars(l.cents)]),
    ["Expenses", "Total expenses", dollars(pnl.totalExpenses)],
    ["Net", "Net profit (loss)", dollars(pnl.net)],
  ];
}

export function summaryCsv(pnl: Pnl, from: IsoDate, to: IsoDate): string {
  return Papa.unparse([titleRow("Profit & loss", from, to), ...summaryRows(pnl)]);
}
