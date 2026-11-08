import { describe, expect, it } from "vitest";
import { expandLedgerLines, type LedgerSplit } from "./ledger";
import {
  checkMonthAddsUp,
  compareBooks,
  databaseUrlMisread,
  describeDatabase,
  formatReport,
  INBOX_KEY,
  mapAccounts,
  mismatchSummary,
  parseCompareArgs,
  partialMonthWarning,
  QboCompareInputError,
  resolveOverrides,
  type OurCategory,
  type OurTx,
} from "./qbo-compare";
import { UNCATEGORIZED_IN, UNCATEGORIZED_OUT } from "./metrics";
import { parseQboPnl, selectMonths } from "./qbo-pnl";

const cats: OurCategory[] = [
  { id: "c-rent", name: "Booth Rent", kind: "income", archived: false },
  { id: "c-sales", name: "Product Sales", kind: "income", archived: false },
  { id: "c-util", name: "Utilities", kind: "expense", archived: false },
  { id: "c-supplies", name: "Supplies", kind: "expense", archived: false },
  { id: "c-fees", name: "Bank & Payment Fees", kind: "expense", archived: false },
  { id: "c-old", name: "Old Fees", kind: "expense", archived: true },
  { id: "c-draw", name: "Owner Draw", kind: "transfer", archived: false },
];

function pnl(body: string[], header = ",Jan 2026,Feb 2026,Total") {
  return parseQboPnl(["Salon LLC", "Profit and Loss", "", header, ...body, "", "Cash Basis"].join("\n"));
}

let n = 0;
function tx(date: string, amountCents: number, categoryId: string | null, description = `tx ${++n}`): OurTx {
  return { id: `t${++n}`, date, amountCents, categoryId, stylistId: null, isSplit: false, description, source: "csv" };
}
const lines = (txs: OurTx[], splits: LedgerSplit[] = []) => expandLedgerLines(txs, splits);

const simple = pnl([
  "Income",
  "Booth Rent,100.00,100.00,200.00",
  "Total Income,100.00,100.00,200.00",
  "Expenses",
  "Utilities,40.00,30.00,70.00",
  "Total Expenses,40.00,30.00,70.00",
  "Net Income,60.00,70.00,130.00",
]);
const simpleBooks = () => [
  tx("2026-01-05", 10000, "c-rent"),
  tx("2026-01-20", -4000, "c-util"),
  tx("2026-02-05", 10000, "c-rent"),
  tx("2026-02-20", -3000, "c-util"),
];

describe("mapAccounts", () => {
  const p = pnl([
    "Expenses",
    "Utilities",
    "Electric,1.00,,1.00",
    "Water,1.00,,1.00",
    "Total Utilities,2.00,0.00,2.00",
    "Bank Charges,1.00,,1.00",
    "Uncategorized Expense,1.00,,1.00",
    "Mystery,1.00,,1.00",
    "Total Expenses,5.00,0.00,5.00",
    "Net Income,-5.00,0.00,-5.00",
  ]);
  const find = (ms: ReturnType<typeof mapAccounts>, name: string) => ms.find((m) => m.fullName === name)!;

  it("uses the same name, rolls a sub-account up to its parent, sends placeholders to the Inbox", () => {
    const ms = mapAccounts(p.accounts, cats, null);
    expect(find(ms, "Utilities:Electric")).toMatchObject({ target: { type: "category", categoryId: "c-util" }, via: "same name", rolledUpTo: "Utilities" });
    expect(find(ms, "Uncategorized Expense")).toMatchObject({ target: { type: "inbox" }, via: "QuickBooks placeholder", targetLabel: "Inbox (uncategorized)" });
    expect(find(ms, "Bank Charges")).toMatchObject({ target: null, via: null });
    expect(find(ms, "Mystery").target).toBeNull();
  });

  it("prefers the saved import mapping over the same name, and --map over both", () => {
    const saved = {
      "utilities:electric": { type: "existing", categoryId: "c-supplies" },
      "bank charges": { type: "existing", categoryId: "c-fees" },
      mystery: { type: "inbox" },
    };
    const ms = mapAccounts(p.accounts, cats, saved, resolveOverrides({ "Bank Charges": "Utilities" }, cats));
    expect(find(ms, "Utilities:Electric")).toMatchObject({ target: { categoryId: "c-supplies" }, via: "saved import mapping", rolledUpTo: null });
    expect(find(ms, "Utilities:Water")).toMatchObject({ target: { categoryId: "c-util" }, via: "same name" });
    expect(find(ms, "Bank Charges")).toMatchObject({ target: { categoryId: "c-util" }, via: "--map" });
    expect(find(ms, "Mystery")).toMatchObject({ target: { type: "inbox" }, via: "saved import mapping" });
  });

  it("matches a saved choice by leaf name, and skips a deleted category and shapes the import never saves", () => {
    const saved = {
      electric: { type: "existing", categoryId: "c-supplies" },
      // The import saves a "Create new" pick as the category it created, never as { type: "new" }.
      water: { type: "new", name: "supplies", kind: "expense" },
      "bank charges": { type: "existing", categoryId: "gone" },
      junk: "not a choice",
    };
    const ms = mapAccounts(p.accounts, cats, saved);
    expect(find(ms, "Utilities:Electric")).toMatchObject({ target: { categoryId: "c-supplies" }, via: "saved import mapping" });
    expect(find(ms, "Utilities:Water")).toMatchObject({ target: { categoryId: "c-util" }, via: "same name", rolledUpTo: "Utilities" });
    expect(find(ms, "Bank Charges").target).toBeNull();
  });

  it("matches a hidden category by name only when no visible one has it", () => {
    const q = pnl(["Expenses", "Old Fees,1.00,,1.00", "Total Expenses,1.00,0.00,1.00", "Net Income,-1.00,0.00,-1.00"]);
    expect(mapAccounts(q.accounts, cats, null)[0].target).toEqual({ type: "category", categoryId: "c-old" });
    const twin = [...cats, { id: "c-new-fees", name: "old fees", kind: "expense" as const, archived: false }];
    expect(mapAccounts(q.accounts, twin, null)[0].target).toEqual({ type: "category", categoryId: "c-new-fees" });
  });
});

describe("resolveOverrides", () => {
  it("maps names case-insensitively, with Inbox for uncategorized", () => {
    const o = resolveOverrides({ "Ask My Accountant": "inbox", "Bank Charges": "bank & payment fees" }, cats);
    expect(o.get("ask my accountant")).toEqual({ type: "inbox" });
    expect(o.get("bank charges")).toEqual({ type: "category", categoryId: "c-fees" });
  });

  it("refuses anything that isn't an object of category names", () => {
    expect(() => resolveOverrides(["x"], cats)).toThrow(QboCompareInputError);
    expect(() => resolveOverrides({ A: 3 }, cats)).toThrow(/must map to a category name/);
    expect(() => resolveOverrides({ A: "Nope" }, cats)).toThrow(/"A" maps to "Nope", which isn't one of our categories/);
  });
});

describe("compareBooks", () => {
  it("matches when every month x category agrees", () => {
    const r = compareBooks({ pnl: simple, categories: cats, lines: lines(simpleBooks()) });
    expect(r.mismatches).toEqual([]);
    expect(r.months.map((m) => [m.qbo, m.ours, m.status])).toEqual([
      [{ income: 10000, expenses: 4000, inbox: 0, net: 6000, netReported: 6000, netComputed: 6000 }, { income: 10000, expenses: 4000, inbox: 0, net: 6000 }, "ok"],
      [{ income: 10000, expenses: 3000, inbox: 0, net: 7000, netReported: 7000, netComputed: 7000 }, { income: 10000, expenses: 3000, inbox: 0, net: 7000 }, "ok"],
    ]);
    expect(mismatchSummary(r)).toBe("MATCH: Jan 2026 to Feb 2026 (2 months)");
    expect(r.match).toBe(true);
  });

  it("adds several QuickBooks accounts into one of our categories", () => {
    const p = pnl([
      "Expenses",
      "Electric,30.00,,30.00",
      "Water,10.00,,10.00",
      "Total Expenses,40.00,0.00,40.00",
      "Net Income,-40.00,0.00,-40.00",
    ]);
    const r = compareBooks({ pnl: p, categories: cats, lines: lines([tx("2026-01-20", -4000, "c-util")]), overrides: resolveOverrides({ Electric: "Utilities", Water: "Utilities" }, cats) });
    expect(r.mismatches).toEqual([]);
    const cell = r.cells.find((c) => c.key === "c-util")!;
    expect(cell.feeds.map((f) => [f.account, f.cents])).toEqual([["Electric", 3000], ["Water", 1000]]);
  });

  it("finds the cell that differs and lists our transactions in it", () => {
    const books = simpleBooks();
    books[3] = tx("2026-02-20", -3100, "c-util", "Duke Energy");
    const r = compareBooks({ pnl: simple, categories: cats, lines: lines(books) });
    expect(r.mismatches.map((c) => [c.month, c.label, c.qbo, c.ours, c.diff])).toEqual([["2026-02", "Utilities", 3000, 3100, 100]]);
    expect(r.mismatches[0].lines.map((l) => l.tx.description)).toEqual(["Duke Energy"]);
    expect(mismatchSummary(r)).toBe("1 mismatch, total abs diff $1.00");
  });

  it("ignores differences within the tolerance", () => {
    const books = simpleBooks();
    books[3] = tx("2026-02-20", -3001, "c-util");
    expect(compareBooks({ pnl: simple, categories: cats, lines: lines(books), toleranceCents: 1 }).mismatches).toEqual([]);
    expect(compareBooks({ pnl: simple, categories: cats, lines: lines(books), toleranceCents: 0 }).mismatches).toHaveLength(1);
  });

  it("compares Inbox money against the QuickBooks placeholders, and shows the Inbox per month", () => {
    const p = pnl([
      "Income",
      "Uncategorized Income,5.00,,5.00",
      "Total Income,5.00,0.00,5.00",
      "Expenses",
      "Uncategorized Expense,2.00,,2.00",
      "Total Expenses,2.00,0.00,2.00",
      "Net Income,3.00,0.00,3.00",
    ]);
    const r = compareBooks({ pnl: p, categories: cats, lines: lines([tx("2026-01-03", 500, null), tx("2026-01-04", -200, null), tx("2026-02-04", -900, null)]) });
    expect(r.mismatches.map((c) => [c.month, c.key, c.kind, c.qbo, c.ours])).toEqual([["2026-02", INBOX_KEY, "inbox", 0, -900]]);
    const jan = r.cells.find((c) => c.month === "2026-01" && c.key === INBOX_KEY)!;
    expect(jan).toMatchObject({ qbo: 300, ours: 300, diff: 0 });
    expect(jan.feeds.map((f) => [f.account, f.cents])).toEqual([["Uncategorized Income", 500], ["Uncategorized Expense", -200]]);
    expect(r.cells.some((c) => c.key === UNCATEGORIZED_IN || c.key === UNCATEGORIZED_OUT)).toBe(false);
    expect(r.months.map((m) => [m.qbo.inbox, m.ours.inbox, m.qbo.income, m.ours.income, m.qbo.expenses, m.ours.expenses])).toEqual([
      [300, 300, 0, 0, 0, 0],
      [0, -900, 0, 0, 0, 0],
    ]);
    expect(r.inbox.map(({ month, inCents, inCount, outCents, outCount }) => ({ month, inCents, inCount, outCents, outCount }))).toEqual([
      { month: "2026-01", inCents: 500, inCount: 1, outCents: 200, outCount: 1 },
      { month: "2026-02", inCents: 0, inCount: 0, outCents: 900, outCount: 1 },
    ]);
  });

  describe("the Inbox against QuickBooks placeholders, as one net amount", () => {
    // QuickBooks nets a $50 purchase and a $20 refund inside Uncategorized Expense: $30.
    const refund = pnl([
      "Income",
      "Booth Rent,100.00,,100.00",
      "Total Income,100.00,0.00,100.00",
      "Expenses",
      "Uncategorized Expense,30.00,,30.00",
      "Total Expenses,30.00,0.00,30.00",
      "Net Income,70.00,0.00,70.00",
    ]);
    const books = (rent: number, out: number, back: number) => lines([tx("2026-01-05", rent, "c-rent"), tx("2026-01-10", out, null), tx("2026-01-12", back, null)]);

    it("matches a refund inside a placeholder account, instead of two ghost mismatches (money in and money out)", () => {
      const r = compareBooks({ pnl: refund, categories: cats, lines: books(10000, -5000, 2000) });
      expect(r.mismatches).toEqual([]);
      expect(r.withinTolerance).toEqual([]);
      expect(r.cells.find((c) => c.key === INBOX_KEY)).toMatchObject({ qbo: -3000, ours: -3000, diff: 0 });
      expect(r.months[0]).toMatchObject({ status: "ok", qbo: { income: 10000, expenses: 0, inbox: -3000, net: 7000 }, ours: { income: 10000, expenses: 0, inbox: -3000, net: 7000 } });
      expect(r.inbox[0]).toMatchObject({ inCents: 2000, inCount: 1, outCents: 5000, outCount: 1 });
      expect(r.match).toBe(true);
    });

    it("still flags a real Inbox difference, in the Inbox cell and the month's net", () => {
      const r = compareBooks({ pnl: refund, categories: cats, lines: books(10000, -5000, 1000) });
      expect(r.mismatches.map((c) => [c.key, c.qbo, c.ours, c.diff])).toEqual([[INBOX_KEY, -3000, -4000, -1000]]);
      expect(r.mismatches[0].lines.map((l) => l.amountCents)).toEqual([-5000, 1000]);
      expect(r.months[0]).toMatchObject({ status: "cells", diff: -1000 });
      expect(r.match).toBe(false);
      expect(mismatchSummary(r)).toBe("1 mismatch, total abs diff $10.00");
    });

    it("keeps the Inbox in the month's net, so differences under the tolerance can't add up there either", () => {
      // $4 more Booth Rent and $4 more net in the Inbox: each cell is within $5, the month's net is $8 off.
      const r = compareBooks({ pnl: refund, categories: cats, lines: books(10400, -5000, 2400), toleranceCents: 500 });
      expect(r.mismatches).toEqual([]);
      expect(r.withinTolerance.map((c) => [c.key, c.diff])).toEqual([["c-rent", 400], [INBOX_KEY, 400]]);
      expect(r.months[0]).toMatchObject({ status: "mismatch", diff: 800 });
      expect(r.match).toBe(false);
    });

    // QuickBooks left a bounced $500 in both Uncategorized Income and Uncategorized Expense: they net to 0.
    const bounced = pnl([
      "Income",
      "Booth Rent,100.00,,100.00",
      "Uncategorized Income,500.00,,500.00",
      "Total Income,600.00,0.00,600.00",
      "Expenses",
      "Utilities,40.00,,40.00",
      "Uncategorized Expense,500.00,,500.00",
      "Total Expenses,540.00,0.00,540.00",
      "Net Income,60.00,0.00,60.00",
    ]);
    const sorted = [tx("2026-01-05", 10000, "c-rent"), tx("2026-01-20", -4000, "c-util")];

    it("can't net away QuickBooks Inbox money that our Inbox doesn't hold (gross check)", () => {
      // Our books have neither $500, or sorted both to a transfer category: the nets agree (0 = 0).
      for (const extra of [[], [tx("2026-01-10", 50000, "c-draw"), tx("2026-01-11", -50000, "c-draw")]]) {
        const r = compareBooks({ pnl: bounced, categories: cats, lines: lines([...sorted, ...extra]) });
        expect(r.mismatches).toEqual([]);
        expect(r.months[0]).toMatchObject({ status: "mismatch", diff: -100000, inboxGross: { qbo: 100000, ours: 0 } });
        expect(r.match).toBe(false);
        expect(mismatchSummary(r)).toBe("1 mismatch (1 month total), total abs diff $1,000.00");
        expect(formatReport(r, { file: "p.csv", basis: "cash", readOnly: true, database: "test db" })).toContain(
          "- Jan 2026: QuickBooks has $1,000.00 in accounts mapped to the Inbox (Uncategorized Income $500.00, Uncategorized Expense -$500.00; signs ignored), but our Inbox has only $0.00 of money in and out. Netting them could hide that difference.",
        );
      }
    });

    it("counts the gross check as a month mismatch even when the month also has mismatched cells", () => {
      const r = compareBooks({ pnl: bounced, categories: cats, lines: lines([tx("2026-01-05", 10100, "c-rent"), tx("2026-01-20", -4000, "c-util")]) });
      expect(r.mismatches.map((c) => [c.key, c.diff])).toEqual([["c-rent", 100]]);
      expect(r.months[0]).toMatchObject({ status: "mismatch", diff: 100 });
      expect(r.monthMismatches).toHaveLength(1);
      expect(mismatchSummary(r)).toBe("2 mismatches (1 cell, 1 month total), total abs diff $2.00");
    });

    it("matches the same file when both rows are in our Inbox, and allows the tolerance", () => {
      const both = [...sorted, tx("2026-01-10", 50000, null), tx("2026-01-11", -50000, null)];
      const r = compareBooks({ pnl: bounced, categories: cats, lines: lines(both) });
      expect(r.months[0]).toMatchObject({ status: "ok", inboxGross: { qbo: 100000, ours: 100000 } });
      expect(r.match).toBe(true);
      // $5 short of QuickBooks' gross: within a $5 tolerance, and not within $4.99.
      const short = [...sorted, tx("2026-01-10", 49750, null), tx("2026-01-11", -49750, null)];
      expect(compareBooks({ pnl: bounced, categories: cats, lines: lines(short), toleranceCents: 500 }).match).toBe(true);
      expect(compareBooks({ pnl: bounced, categories: cats, lines: lines(short), toleranceCents: 499 }).months[0].status).toBe("mismatch");
    });
  });

  it("keeps unmapped same-name accounts in Income and Expenses apart", () => {
    const p = pnl([
      "Income",
      "Booth Rent,100.00,,100.00",
      "Misc,10.00,,10.00",
      "Total Income,110.00,0.00,110.00",
      "Expenses",
      "Misc,4.00,,4.00",
      "Total Expenses,4.00,0.00,4.00",
      "Net Income,106.00,0.00,106.00",
    ]);
    const r = compareBooks({ pnl: p, categories: cats, lines: lines([tx("2026-01-05", 10000, "c-rent")]) });
    expect(r.mismatches.map((c) => [c.key, c.kind, c.qbo, c.ours])).toEqual([
      ["qbo:income:Misc", "income", 1000, 0],
      ["qbo:expense:Misc", "expense", 400, 0],
    ]);
    expect(r.months[0].qbo).toMatchObject({ income: 11000, expenses: 400, net: 10600 });
    expect(r.match).toBe(false);
  });

  it("expands splits: each line counts in its own category", () => {
    const p = pnl([
      "Income",
      "Product Sales,103.00,,103.00",
      "Total Income,103.00,0.00,103.00",
      "Expenses",
      "Bank Charges,3.00,,3.00",
      "Total Expenses,3.00,0.00,3.00",
      "Net Income,100.00,0.00,100.00",
    ]);
    const deposit: OurTx = { ...tx("2026-01-10", 10000, null, "Square deposit"), isSplit: true };
    const splits: LedgerSplit[] = [
      { transactionId: deposit.id, position: 0, categoryId: "c-sales", stylistId: null, amountCents: 10300, memo: "Sales" },
      { transactionId: deposit.id, position: 1, categoryId: "c-fees", stylistId: null, amountCents: -300, memo: "Fees" },
    ];
    const ok = compareBooks({ pnl: p, categories: cats, lines: lines([deposit], splits), overrides: resolveOverrides({ "Bank Charges": "Bank & Payment Fees" }, cats) });
    expect(ok.mismatches).toEqual([]);
    expect(ok.inbox[0]).toMatchObject({ inCount: 0, outCount: 0 });

    splits[1] = { ...splits[1], amountCents: -400 };
    splits[0] = { ...splits[0], amountCents: 10400 };
    const off = compareBooks({ pnl: p, categories: cats, lines: lines([deposit], splits), overrides: resolveOverrides({ "Bank Charges": "Bank & Payment Fees" }, cats) });
    expect(off.mismatches.map((c) => [c.label, c.diff])).toEqual([["Product Sales", 100], ["Bank & Payment Fees", 100]]);
    const report = formatReport(off, { file: "p.csv", basis: "cash", readOnly: true, database: "test db" });
    expect(report).toContain("| 2026-01-10 | +$104.00 | Square deposit (split 1/2: Sales) | csv | /transactions/");
    expect(report).toContain("| 2026-01-10 | -$4.00 | Square deposit (split 2/2: Fees) | csv | /transactions/");
  });

  describe("a QuickBooks account mapped to one of our categories of the other direction", () => {
    const p = pnl([
      "Income",
      "Supply Refunds,5.00,,5.00",
      "Total Income,5.00,0.00,5.00",
      "Expenses",
      "Card Fees,3.00,,3.00",
      "Total Expenses,3.00,0.00,3.00",
      "Net Income,2.00,0.00,2.00",
    ]);
    // A supplies refund is money in on an expense category; card fees taken out of sales, money out on an income one.
    const overrides = resolveOverrides({ "Supply Refunds": "Supplies", "Card Fees": "Product Sales" }, cats);
    const books = (refund: number) => lines([tx("2026-01-10", refund, "c-supplies"), tx("2026-01-11", -300, "c-sales")]);

    it("flips the sign, and counts it the same way in the month totals on both sides, so it can MATCH", () => {
      const r = compareBooks({ pnl: p, categories: cats, lines: books(500), overrides });
      expect(r.mismatches).toEqual([]);
      expect(r.cells.map((c) => [c.key, c.qbo, c.ours])).toEqual([["c-sales", -300, -300], ["c-supplies", -500, -500]]);
      expect(r.months[0].qbo).toMatchObject({ income: -300, expenses: -500, inbox: 0, net: 200, netComputed: 200 });
      expect(r.months[0].ours).toEqual({ income: -300, expenses: -500, inbox: 0, net: 200 });
      expect(r.months.map((m) => m.status)).toEqual(["ok", "ok"]);
      expect(r.match).toBe(true);
    });

    it("still mismatches when the money differs", () => {
      const r = compareBooks({ pnl: p, categories: cats, lines: books(400), overrides });
      expect(r.mismatches.map((c) => [c.key, c.qbo, c.ours, c.diff])).toEqual([["c-supplies", -500, -400, 100]]);
      expect(r.months[0]).toMatchObject({ status: "cells", diff: -100 });
      expect(r.match).toBe(false);
    });
  });

  it("checks month income and expenses on their own, not only the net", () => {
    const p = pnl([
      "Income",
      "Booth Rent,100.00,,100.00",
      "Product Sales,50.00,,50.00",
      "Total Income,150.00,0.00,150.00",
      "Expenses",
      "Utilities,40.00,,40.00",
      "Supplies,20.00,,20.00",
      "Total Expenses,60.00,0.00,60.00",
      "Net Income,90.00,0.00,90.00",
    ]);
    // Every cell is $4 high (within $5); income and expenses are each $8 high, so the net agrees.
    const books = [tx("2026-01-05", 10400, "c-rent"), tx("2026-01-06", 5400, "c-sales"), tx("2026-01-07", -4400, "c-util"), tx("2026-01-08", -2400, "c-supplies")];
    const r = compareBooks({ pnl: p, categories: cats, lines: lines(books), toleranceCents: 500 });
    expect(r.mismatches).toEqual([]);
    expect(r.withinTolerance).toHaveLength(4);
    expect(r.months[0].ours.net - r.months[0].qbo.net).toBe(0);
    expect(r.months[0]).toMatchObject({ status: "mismatch", diff: 800 });
    expect(r.match).toBe(false);
  });

  it("flags QuickBooks P&L money mapped to one of our transfer categories", () => {
    const p = pnl(["Expenses", "Draws,50.00,,50.00", "Total Expenses,50.00,0.00,50.00", "Net Income,-50.00,0.00,-50.00"]);
    const r = compareBooks({ pnl: p, categories: cats, lines: lines([tx("2026-01-10", -5000, "c-draw", "Owner took money")]), overrides: resolveOverrides({ Draws: "Owner Draw" }, cats) });
    expect(r.mismatches.map((c) => [c.label, c.qbo, c.ours, c.note])).toEqual([["Owner Draw", 5000, 0, "Owner Draw is a transfer category, which our P&L leaves out."]]);
    expect(r.mismatches[0].lines.map((l) => l.tx.description)).toEqual(["Owner took money"]);
    expect(r.toTransfers.map((m) => m.fullName)).toEqual(["Draws"]);
  });

  it("lists unmapped QuickBooks accounts and our categories nothing maps to, as mismatches", () => {
    const p = pnl(["Expenses", "Mystery Account,7.00,,7.00", "Total Expenses,7.00,0.00,7.00", "Net Income,-7.00,0.00,-7.00"]);
    const r = compareBooks({ pnl: p, categories: cats, lines: lines([tx("2026-01-10", -700, "c-supplies")]) });
    expect(r.unmapped.map((m) => m.fullName)).toEqual(["Mystery Account"]);
    expect(r.unmatchedCategories.map((u) => [u.category.name, u.cents])).toEqual([["Supplies", 700]]);
    expect(r.mismatches.map((c) => [c.key, c.label, c.qbo, c.ours, c.note])).toEqual([
      ["qbo:expense:Mystery Account", `QuickBooks "Mystery Account" (not mapped)`, 700, 0, "Not mapped to any of our categories. Add it to --map."],
      ["c-supplies", "Supplies", 0, 700, null],
    ]);
    const report = formatReport(r, { file: "p.csv", basis: "cash", readOnly: true, database: "test db" });
    expect(report).toContain("QuickBooks accounts not mapped to anything of ours (add them to --map): \n- Mystery Account (Expenses)");
    expect(report).toContain("Our categories no QuickBooks account maps to: \n- Supplies (expense, $7.00 in range)");
  });

  it("compares a partial month over only its days", () => {
    const p = pnl(
      ["Expenses", "Utilities,10.00,4.00,14.00", "Total Expenses,10.00,4.00,14.00", "Net Income,-10.00,-4.00,-14.00"],
      ',Sep 2026,"Oct 1-15, 2026",Total',
    );
    const books = [tx("2026-09-30", -1000, "c-util"), tx("2026-10-15", -400, "c-util"), tx("2026-10-16", -9999, "c-util"), tx("2026-10-20", -50, null)];
    const r = compareBooks({ pnl: p, categories: cats, lines: lines(books) });
    expect(r.mismatches).toEqual([]);
    expect(r.inbox[1]).toMatchObject({ month: "2026-10", outCents: 0 });
  });

  it("says right above the verdict that a partial month was only partly compared, even when asked for the whole month", () => {
    const p = selectMonths(
      pnl(["Expenses", "Utilities,4.00,10.00,14.00", "Total Expenses,4.00,10.00,14.00", "Net Income,-4.00,-10.00,-14.00"], ',"Jan 15-31, 2026",Feb 2026,Total'),
      "2026-01",
      "2026-02",
    );
    // The $99.99 on Jan 5 is outside the column, on our side too.
    const books = [tx("2026-01-05", -9999, "c-util"), tx("2026-01-20", -400, "c-util"), tx("2026-02-03", -1000, "c-util")];
    const r = compareBooks({ pnl: p, categories: cats, lines: lines(books) });
    expect(r.match).toBe(true);
    const tail = formatReport(r, { file: "p.csv", basis: "cash", readOnly: true, database: "test db" }).trimEnd().split("\n").slice(-2);
    expect(tail).toEqual([
      `WARNING: partial month. Compared 2026-01 only from 2026-01-15 to 2026-01-31 ("Jan 15-31, 2026"); the rest of that month was not checked.`,
      "MATCH: Jan 15-31, 2026 to Feb 2026 (2 months)",
    ]);
    expect(partialMonthWarning(simple.columns)).toBeNull();
    const both = pnl(["Expenses", "Utilities,4.00,1.00,5.00", "Total Expenses,4.00,1.00,5.00", "Net Income,-4.00,-1.00,-5.00"], ',"Jan 15-31, 2026","Feb 1-7, 2026",Total');
    expect(partialMonthWarning(both.columns)).toBe(
      `WARNING: partial month. Compared 2026-01 only from 2026-01-15 to 2026-01-31 ("Jan 15-31, 2026") and 2026-02 only from 2026-02-01 to 2026-02-07 ("Feb 1-7, 2026"); the rest of those months was not checked.`,
    );
  });

  it("warns about --map entries that match no QuickBooks account", () => {
    const r = compareBooks({ pnl: simple, categories: cats, lines: lines(simpleBooks()), overrides: resolveOverrides({ "Not There": "Utilities" }, cats) });
    expect(r.warnings).toEqual([`--map entry "not there" doesn't match any QuickBooks account in the file.`]);
  });
});

describe("the verdict says MATCH only when every dollar was compared", () => {
  it("blocks on the file's own Net Income row disagreeing, even when every cell agrees", () => {
    const tampered = pnl([
      "Income",
      "Booth Rent,100.00,100.00,200.00",
      "Total Income,100.00,100.00,200.00",
      "Expenses",
      "Utilities,40.00,30.00,70.00",
      "Total Expenses,40.00,30.00,70.00",
      "Net Income,60.00,29.00,89.00",
    ]);
    const r = compareBooks({ pnl: tampered, categories: cats, lines: lines(simpleBooks()) });
    expect(r.mismatches).toEqual([]);
    expect(r.problems.map((p) => p.message)).toEqual([`Line 11: "Net Income" for Feb 2026 says $29.00, but the accounts add up to $70.00.`]);
    expect(r.months.map((m) => [m.status, m.qbo.net, m.qbo.netComputed, m.ours.net, m.diff])).toEqual([
      ["ok", 6000, 6000, 6000, 0],
      ["mismatch", 2900, 7000, 7000, 4100],
    ]);
    expect(r.match).toBe(false);
    expect(mismatchSummary(r)).toBe("2 mismatches (1 month total, 1 problem in the QuickBooks file), total abs diff $41.00");
    const report = formatReport(r, { file: "p.csv", basis: "cash", readOnly: true, database: "test db" });
    expect(report).toContain("## Problems in the QuickBooks file (1)");
    expect(report).toContain("| Feb 2026 | $100.00 | $100.00 | 0 | $30.00 | $30.00 | 0 | $0.00 | $0.00 | 0 | $29.00 | $70.00 | +$41.00 | MISMATCH |");
  });

  it("checks a summary row spelled 'Net Income (Loss)' like Net Income, so a wrong amount there still blocks", () => {
    const body = ["Income", "Booth Rent,100.00,100.00,200.00", "Total Income,100.00,100.00,200.00", "Expenses", "Utilities,40.00,30.00,70.00", "Total Expenses,40.00,30.00,70.00"];
    const ok = compareBooks({ pnl: pnl([...body, "Net Income (Loss),60.00,70.00,130.00"]), categories: cats, lines: lines(simpleBooks()) });
    expect(ok.match).toBe(true);
    const bad = compareBooks({ pnl: pnl([...body, "Net Income (Loss),60.00,29.00,89.00"]), categories: cats, lines: lines(simpleBooks()) });
    expect(bad.mismatches).toEqual([]);
    expect(bad.problems.map((p) => p.message)).toEqual([`Line 11: "Net Income" for Feb 2026 says $29.00, but the accounts add up to $70.00.`]);
    expect(bad.months.map((m) => m.status)).toEqual(["ok", "mismatch"]);
    expect(bad.match).toBe(false);
  });

  it("reads a file re-saved in Excel (Jan-26 headers, dash zeros), and still finds a wrong amount in it", () => {
    const excel = pnl(
      [
        "Income,,,",
        'Booth Rent," 100.00 "," 100.00 "," 200.00 "',
        'Total Income," 100.00 "," 100.00 "," 200.00 "',
        "Expenses,,,",
        'Utilities," 40.00 "," 30.00 "," 70.00 "',
        "Bank Charges, - , $ - , - ",
        'Total Expenses," 40.00 "," 30.00 "," 70.00 "',
        'Net Income," 60.00 "," 70.00 "," 130.00 "',
      ],
      ",Jan-26,Feb-26,Total",
    );
    expect(excel.months).toEqual(["2026-01", "2026-02"]);
    expect(compareBooks({ pnl: excel, categories: cats, lines: lines(simpleBooks()) }).match).toBe(true);
    // QuickBooks' $30 Feb utilities changed to $31 (and its totals with it, so the file adds up).
    const wrong = parseQboPnl(
      ["", ",Jan-26,Feb-26,Total", "Expenses,,,", 'Utilities," 40.00 "," 31.00 "," 71.00 "', 'Bank Charges, - , - , - ', 'Total Expenses," 40.00 "," 31.00 "," 71.00 "', 'Net Income,"(40.00)","(31.00)","(71.00)"', "Cash Basis"].join("\n"),
    );
    const r = compareBooks({ pnl: wrong, categories: cats, lines: lines([tx("2026-01-20", -4000, "c-util"), tx("2026-02-20", -3000, "c-util")]) });
    expect(r.problems).toEqual([]);
    expect(r.mismatches.map((c) => [c.month, c.label, c.qbo, c.ours, c.diff])).toEqual([["2026-02", "Utilities", 3100, 3000, -100]]);
    expect(r.match).toBe(false);
  });

  it("can't MATCH a file with no Net Income row", () => {
    const cut = pnl(["Income", "Booth Rent,100.00,100.00,200.00", "Total Income,100.00,100.00,200.00", "Expenses", "Utilities,40.00,30.00,70.00", "Total Expenses,40.00,30.00,70.00"]);
    const r = compareBooks({ pnl: cut, categories: cats, lines: lines(simpleBooks()) });
    expect(r.mismatches).toEqual([]);
    expect(r.match).toBe(false);
    expect(mismatchSummary(r)).toBe("1 mismatch (1 problem in the QuickBooks file), total abs diff $0.00");
    expect(formatReport(r, { file: "p.csv", basis: "cash", readOnly: true, database: "test db" })).toContain("| not in file | $60.00 |");
  });

  it("doesn't let differences under the tolerance add up unseen", () => {
    const p = pnl(
      [
        "Income",
        "Booth Rent,100.00,100.00,100.00,300.00",
        "Total Income,100.00,100.00,100.00,300.00",
        "Expenses",
        "Utilities,50.00,50.00,50.00,150.00",
        "Total Expenses,50.00,50.00,50.00,150.00",
        "Net Income,50.00,50.00,50.00,150.00",
      ],
      ",Jan 2026,Feb 2026,Mar 2026,Total",
    );
    const books = ["01", "02", "03"].flatMap((m) => [tx(`2026-${m}-05`, 10500, "c-rent"), tx(`2026-${m}-06`, -4500, "c-util")]);
    const r = compareBooks({ pnl: p, categories: cats, lines: lines(books), toleranceCents: 500 });
    expect(r.mismatches).toEqual([]);
    expect(r.withinTolerance).toHaveLength(6);
    expect(r.months.map((m) => [m.status, m.diff])).toEqual([["mismatch", 1000], ["mismatch", 1000], ["mismatch", 1000]]);
    expect(r.match).toBe(false);
    expect(mismatchSummary(r)).toBe("3 mismatches (3 month totals), total abs diff $30.00; 6 cells within the $5.00 tolerance (sum $30.00)");
    expect(formatReport(r, { file: "p.csv", basis: "cash", readOnly: true, database: "test db" })).toContain("## Cells within the $5.00 tolerance (6)");
  });

  it("allows exactly the tolerance, and no more, per cell and per month", () => {
    const at = (cents: number) => {
      const books = simpleBooks();
      books[0] = tx("2026-01-05", cents, "c-rent");
      return compareBooks({ pnl: simple, categories: cats, lines: lines(books), toleranceCents: 500 });
    };
    const five = at(10500);
    expect(five.match).toBe(true);
    expect(mismatchSummary(five)).toBe("MATCH: Jan 2026 to Feb 2026 (2 months); 1 cell within the $5.00 tolerance (sum $5.00)");
    const six = at(10600);
    expect(six.match).toBe(false);
    expect(six.mismatches.map((c) => [c.label, c.diff])).toEqual([["Booth Rent", 600]]);
    expect(six.months[0].status).toBe("cells");
    expect(mismatchSummary(six)).toBe("1 mismatch, total abs diff $6.00");
  });

  it("doesn't count a month twice when its mismatched cells already show the difference", () => {
    const books = simpleBooks();
    books[3] = tx("2026-02-20", -3100, "c-util");
    const r = compareBooks({ pnl: simple, categories: cats, lines: lines(books) });
    expect(r.months.map((m) => m.status)).toEqual(["ok", "cells"]);
    expect(r.monthMismatches).toEqual([]);
    expect(mismatchSummary(r)).toBe("1 mismatch, total abs diff $1.00");
  });
});

describe("checkMonthAddsUp: every dollar lands in exactly one of income, expenses and the Inbox", () => {
  const ok = { income: 10000, expenses: 4000, inbox: -1000, net: 5000 };

  it("passes when both sides add up to their net", () => {
    expect(() => checkMonthAddsUp("Jan 2026", ok, ok)).not.toThrow();
  });

  it("throws when the QuickBooks side doesn't add up", () => {
    expect(() => checkMonthAddsUp("Jan 2026", { ...ok, net: 5001 }, ok)).toThrow(
      "qbo:compare bug: Jan 2026: the QuickBooks side doesn't add up (income $100.00 − expenses $40.00 + Inbox -$10.00 isn't the net $50.01), so nothing can be trusted.",
    );
  });

  it("throws when our side doesn't add up", () => {
    expect(() => checkMonthAddsUp("Jan 2026", ok, { ...ok, inbox: 0 })).toThrow(/qbo:compare bug: Jan 2026: our side doesn't add up/);
  });
});

describe("describeDatabase", () => {
  it("names the host and database, never the user or password", () => {
    const d = describeDatabase("postgresql://quitbooks_owner:s3cret-pw@ep-snowy-queen-123-pooler.us-east-1.aws.neon.tech/quitbooks?sslmode=require");
    expect(d).toBe("ep-snowy-queen-123-pooler.us-east-1.aws.neon.tech/quitbooks (Neon endpoint ep-snowy-queen-123)");
    expect(d).not.toMatch(/s3cret|quitbooks_owner/);
    expect(describeDatabase("postgres://u:p@localhost:5433/books")).toBe("localhost:5433/books");
  });

  it("names the Neon endpoint, so production and dev branches can be told apart", () => {
    const at = (host: string) => describeDatabase(`postgresql://quitbooks_owner:pw@${host}/quitbooks?sslmode=require`);
    expect(at("ep-cool-dew-a1b2c3-pooler.us-east-1.aws.neon.tech")).toBe("ep-cool-dew-a1b2c3-pooler.us-east-1.aws.neon.tech/quitbooks (Neon endpoint ep-cool-dew-a1b2c3)");
    expect(at("ep-cool-dew-a1b2c3.us-east-1.aws.neon.tech")).toBe("ep-cool-dew-a1b2c3.us-east-1.aws.neon.tech/quitbooks (Neon endpoint ep-cool-dew-a1b2c3)");
    expect(at("ep-old-sun-9z8y7x-pooler.us-east-1.aws.neon.tech")).not.toBe(at("ep-cool-dew-a1b2c3-pooler.us-east-1.aws.neon.tech"));
    expect(at("db.example.com")).toBe("db.example.com/quitbooks");
  });

  it("refuses to describe a URL whose user or password was misread as the host", () => {
    // An unencoded "/", "?" or "#" in a password that starts with digits.
    for (const url of ["postgresql://quitbooks_owner:1234/s3cret@host/db", "postgresql://quitbooks_owner:12?34@host/db", "postgresql://quitbooks_owner:12#34@host/db"]) {
      const d = describeDatabase(url);
      expect(d).toBe("unknown (DATABASE_URL isn't a URL)");
      expect(d).not.toMatch(/s3cret|quitbooks_owner|1234/);
    }
  });

  it.each([
    // An unencoded "@" in the password or user, then "?" or "#": the parser keeps a user, and the
    // real "@" ends up in the query or fragment.
    ["postgresql://quitbooks_owner:Tr0ub@dor?2026@ep-cool-dew-a1b2c3-pooler.us-east-1.aws.neon.tech/quitbooks?sslmode=require", ["Tr0ub", "dor", "2026"]],
    ["postgresql://quitbooks_owner:k9@x#Lm2@ep-cool-dew-a1b2c3.us-east-1.aws.neon.tech/quitbooks", ["k9", "x", "Lm2"]],
    ["postgres://USRx:PWa@PWb/PWc?@HOSTA.example.com/db", ["USRx", "PWa", "PWb", "PWc"]],
    ["postgresql://admin@myserver:12?ab@myserver.postgres.database.azure.com/db", ["admin", "myserver", "ab"]],
    ["postgresql://user:sec@ret?x@ep-cool-1.us-east-2.aws.neon.tech/db", ["sec", "ret"]],
    ["postgresql://user:a@b#c@host.example.com/db", ["b/", "b#"]],
    // Doesn't parse at all ("pa" isn't a port), but has credentials in it.
    ["postgresql://quitbooks_owner:pa/ss@host.example.com/db", ["quitbooks_owner", "pa/ss"]],
  ])("never prints a fragment of the user or password: %s", (url, fragments) => {
    expect(databaseUrlMisread(url)).toBe(true);
    const d = describeDatabase(url);
    expect(d).toBe("unknown (DATABASE_URL isn't a URL)");
    for (const f of fragments) expect(d).not.toContain(f);
  });

  it("treats an '@' with no user as misread too, since it can't be told apart from one", () => {
    expect(databaseUrlMisread("postgresql://@ep-cool-dew-a1b2c3.us-east-1.aws.neon.tech/quitbooks")).toBe(true);
    expect(databaseUrlMisread("postgresql://:pw@db.example.com/quitbooks")).toBe(true);
  });

  it("doesn't call a well-formed URL misread", () => {
    for (const url of [
      "postgresql://quitbooks_owner:s3cret-pw@ep-snowy-queen-123-pooler.us-east-1.aws.neon.tech/quitbooks?sslmode=require&channel_binding=require",
      "postgres://u:p%40ss%3Fw%23rd@localhost:5433/books",
      "postgresql://localhost/books",
    ]) {
      expect(databaseUrlMisread(url)).toBe(false);
    }
  });

  it("says when it's the local PGlite, unset or unreadable", () => {
    expect(describeDatabase("pglite:./.pglite")).toBe("local PGlite (./.pglite), not production");
    expect(describeDatabase(undefined)).toBe("unknown (DATABASE_URL is not set)");
    expect(describeDatabase("not a url :: secret")).toBe("unknown (DATABASE_URL isn't a URL)");
  });
});

describe("formatReport", () => {
  it("ends with MATCH or the mismatch count, and escapes table cells", () => {
    const ok = formatReport(compareBooks({ pnl: simple, categories: cats, lines: lines(simpleBooks()) }), { file: "p.csv", basis: "cash", readOnly: true, database: "test db" });
    expect(ok.trimEnd().split("\n").at(-1)).toBe("MATCH: Jan 2026 to Feb 2026 (2 months)");
    expect(ok).toContain("- Read only: our books were read in a READ ONLY database transaction.");
    expect(ok).toContain("| Jan 2026 | $100.00 | $100.00 | 0 | $40.00 | $40.00 | 0 | $0.00 | $0.00 | 0 | $60.00 | $60.00 | 0 | ok |");
    expect(ok).not.toContain("WARNING: partial month");

    const books = simpleBooks();
    books[1] = tx("2026-01-20", -4500, "c-util", "Duke | Energy");
    const bad = formatReport(compareBooks({ pnl: simple, categories: cats, lines: lines(books) }), { file: "p.csv", basis: "cash", readOnly: true, database: "test db" });
    expect(bad).toContain("Duke \\| Energy");
    expect(bad).toContain("### Jan 2026 · Utilities (expense)");
    expect(bad).toContain("QuickBooks $40.00 · ours $45.00 · diff +$5.00");
    expect(bad).toContain("- QuickBooks accounts: Utilities $40.00");
    expect(bad.trimEnd().split("\n").at(-1)).toBe("1 mismatch, total abs diff $5.00");
  });

  it("caps a long cell's transaction list", () => {
    const many = Array.from({ length: 60 }, (_, i) => tx("2026-01-02", -100, "c-supplies", `buy ${i}`));
    const r = compareBooks({ pnl: simple, categories: cats, lines: lines([...simpleBooks(), ...many]) });
    expect(formatReport(r, { file: "p.csv", basis: "cash", readOnly: true, database: "test db" })).toContain("…and 10 more.");
  });
});

describe("parseCompareArgs", () => {
  it("takes the file and the options, in either --flag value or --flag=value form", () => {
    expect(parseCompareArgs(["pnl.csv"])).toEqual({ file: "pnl.csv", toleranceCents: 0 });
    expect(parseCompareArgs(["--from", "2026-01", "pnl.csv", "--to=2026-09", "--tolerance-cents", "5", "--map", "m.json", "--out", "r.md"])).toEqual({
      file: "pnl.csv",
      from: "2026-01",
      to: "2026-09",
      toleranceCents: 5,
      mapFile: "m.json",
      outFile: "r.md",
    });
  });

  it.each([
    [[], /Usage/],
    [["a.csv", "b.csv"], /Usage/],
    [["a.csv", "--from"], /--from needs a value/],
    [["a.csv", "--from", "--to", "2026-01"], /--from needs a value/],
    [["a.csv", "--from", "2026-1"], /must be a month like 2026-09/],
    [["a.csv", "--tolerance-cents", "0.5"], /whole number of cents/],
    [["a.csv", "--from", "2026-05", "--to", "2026-01"], /is after/],
    [["a.csv", "--frmo", "2026-01"], /Unknown option --frmo/],
    [["a.csv", "--out="], /--out was given an empty value/],
    [["a.csv", "--out", ""], /--out was given an empty value/],
    [["a.csv", "--map="], /--map was given an empty value/],
    [["a.csv", "--map", ""], /--map was given an empty value/],
    [["a.csv", "--map", "   "], /--map was given an empty value/],
    [["a.csv", "--from="], /--from was given an empty value/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseCompareArgs(argv as string[])).toThrow(message);
  });
});
