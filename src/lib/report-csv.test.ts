import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { expandLedgerLines } from "./ledger";
import { computePnl } from "./metrics";
import { DETAIL_HEADER, detailCsv, detailRows, summaryCsv, type DetailSplit, type DetailTx } from "./report-csv";

const base = { note: null, categoryName: null, categoryKind: null, stylistName: null, stylistId: null, categoryId: null };

const txs: DetailTx[] = [
  { ...base, id: "dep", date: "2026-10-03", amountCents: 50000, description: "ZELLE FROM JANE DOE", isSplit: true, note: "Jane paid for Kim" },
  { ...base, id: "sq", date: "2026-10-05", amountCents: 10000, description: "SQUARE INC DEPOSIT", isSplit: true },
  {
    ...base,
    id: "util",
    date: "2026-10-12",
    amountCents: -4000,
    description: "=HYPERLINK(evil)",
    isSplit: false,
    categoryId: "supplies",
    categoryName: "Supplies",
    categoryKind: "expense",
  },
  { ...base, id: "loose", date: "2026-10-14", amountCents: -700, description: "MYSTERY", isSplit: false },
];
const sp = (
  transactionId: string,
  position: number,
  categoryId: string,
  categoryName: string,
  categoryKind: DetailSplit["categoryKind"],
  amountCents: number,
  stylist: [string, string] | null = null,
  memo: string | null = null,
): DetailSplit => ({
  transactionId,
  position,
  categoryId,
  categoryName,
  categoryKind,
  amountCents,
  stylistId: stylist?.[0] ?? null,
  stylistName: stylist?.[1] ?? null,
  memo,
});
const splits: DetailSplit[] = [
  sp("dep", 0, "booth", "Booth Rent", "income", 25000, ["jane", "Jane Doe"]),
  sp("dep", 1, "booth", "Booth Rent", "income", 25000, ["kim", "Kim Lee"], "Kim's week"),
  sp("sq", 0, "sales", "Product Sales", "income", 10300),
  sp("sq", 1, "fees", "Bank & Payment Fees", "expense", -300, null, "-fee"),
];

describe("detailed CSV", () => {
  const rows = detailRows(expandLedgerLines(txs, splits));

  it("writes one row per split line with the parent's date, description and note", () => {
    expect(rows.slice(0, 4)).toEqual([
      ["2026-10-03", "ZELLE FROM JANE DOE", "250.00", "Booth Rent", "income", "Jane Doe", "Jane paid for Kim", "", "1 of 2"],
      ["2026-10-03", "ZELLE FROM JANE DOE", "250.00", "Booth Rent", "income", "Kim Lee", "Jane paid for Kim", "Kim's week", "2 of 2"],
      ["2026-10-05", "SQUARE INC DEPOSIT", "103.00", "Product Sales", "income", "", "", "", "1 of 2"],
      ["2026-10-05", "SQUARE INC DEPOSIT", "-3.00", "Bank & Payment Fees", "expense", "", "", "'-fee", "2 of 2"],
    ]);
  });

  it("keeps unsplit rows as before (formula-safe text, Uncategorized fallback, no split marker)", () => {
    expect(rows[4]).toEqual(["2026-10-12", "'=HYPERLINK(evil)", "-40.00", "Supplies", "expense", "", "", "", ""]);
    expect(rows[5]).toEqual(["2026-10-14", "MYSTERY", "-7.00", "Uncategorized", "expense", "", "", "", ""]);
  });

  it("amounts still add up to the bank", () => {
    const total = rows.reduce((s, r) => s + Math.round(Number(r[2]) * 100), 0);
    expect(total).toBe(txs.reduce((s, t) => s + t.amountCents, 0));
  });

  it("opens with a Cash basis title row, then the header", () => {
    const parsed = Papa.parse<string[]>(detailCsv(expandLedgerLines(txs, splits), "2026-10-01", "2026-10-31")).data;
    expect(parsed[0]).toEqual(["L Marie Studio LLC", "Transactions (Cash basis)", "2026-10-01 to 2026-10-31"]);
    expect(parsed[1]).toEqual(DETAIL_HEADER);
    expect(parsed).toHaveLength(2 + rows.length);
  });
});

describe("summary CSV", () => {
  it("opens with a Cash basis title row and includes split lines in their categories", () => {
    const lines = expandLedgerLines(txs, splits);
    const pnl = computePnl(
      lines,
      [
        { id: "booth", name: "Booth Rent", kind: "income" },
        { id: "sales", name: "Product Sales", kind: "income" },
        { id: "fees", name: "Bank & Payment Fees", kind: "expense" },
        { id: "supplies", name: "Supplies", kind: "expense" },
      ],
      "2026-10-01",
      "2026-10-31",
    );
    const parsed = Papa.parse<string[]>(summaryCsv(pnl, "2026-10-01", "2026-10-31")).data;
    expect(parsed[0]).toEqual(["L Marie Studio LLC", "Profit & loss (Cash basis)", "2026-10-01 to 2026-10-31"]);
    expect(parsed[1]).toEqual(["Section", "Category", "Amount"]);
    expect(parsed).toContainEqual(["Income", "Booth Rent", "500.00"]);
    expect(parsed).toContainEqual(["Expenses", "Bank & Payment Fees", "3.00"]);
    // Income 500 + 103; expenses 3 + 40 + 7 uncategorized.
    expect(parsed).toContainEqual(["Net", "Net profit (loss)", "553.00"]);
  });
});
