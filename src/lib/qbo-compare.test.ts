import { describe, expect, it } from "vitest";
import { expandLedgerLines, type LedgerSplit } from "./ledger";
import {
  compareBooks,
  describeDatabase,
  formatReport,
  mapAccounts,
  mismatchSummary,
  parseCompareArgs,
  QboCompareInputError,
  resolveOverrides,
  type OurCategory,
  type OurTx,
} from "./qbo-compare";
import { UNCATEGORIZED_IN, UNCATEGORIZED_OUT } from "./metrics";
import { parseQboPnl } from "./qbo-pnl";

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

  it("matches a saved choice by leaf name, follows a 'new' choice by name, and skips a deleted category", () => {
    const saved = {
      electric: { type: "new", name: "supplies", kind: "expense" },
      "bank charges": { type: "existing", categoryId: "gone" },
      junk: "not a choice",
    };
    const ms = mapAccounts(p.accounts, cats, saved);
    expect(find(ms, "Utilities:Electric")).toMatchObject({ target: { categoryId: "c-supplies" }, via: "saved import mapping" });
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
      [{ income: 10000, expenses: 4000, net: 6000, netReported: 6000, netComputed: 6000 }, { income: 10000, expenses: 4000, net: 6000 }, "ok"],
      [{ income: 10000, expenses: 3000, net: 7000, netReported: 7000, netComputed: 7000 }, { income: 10000, expenses: 3000, net: 7000 }, "ok"],
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
    expect(r.mismatches.map((c) => [c.month, c.key, c.qbo, c.ours])).toEqual([["2026-02", UNCATEGORIZED_OUT, 0, 900]]);
    expect(r.cells.find((c) => c.month === "2026-01" && c.key === UNCATEGORIZED_IN)).toMatchObject({ qbo: 500, ours: 500 });
    expect(r.inbox.map(({ month, inCents, inCount, outCents, outCount }) => ({ month, inCents, inCount, outCents, outCount }))).toEqual([
      { month: "2026-01", inCents: 500, inCount: 1, outCents: 200, outCount: 1 },
      { month: "2026-02", inCents: 0, inCount: 0, outCents: 900, outCount: 1 },
    ]);
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

  it("flips the sign when a QuickBooks income account maps to one of our expense categories", () => {
    const p = pnl(["Income", "Supply Refunds,5.00,,5.00", "Total Income,5.00,0.00,5.00", "Net Income,5.00,0.00,5.00"]);
    const r = compareBooks({ pnl: p, categories: cats, lines: lines([tx("2026-01-10", 500, "c-supplies")]), overrides: resolveOverrides({ "Supply Refunds": "Supplies" }, cats) });
    expect(r.mismatches).toEqual([]);
    expect(r.cells[0]).toMatchObject({ key: "c-supplies", qbo: -500, ours: -500 });
    expect(r.months[0].qbo).toMatchObject({ income: 500, expenses: 0, net: 500 });
    expect(r.months[0].ours).toEqual({ income: 0, expenses: -500, net: 500 });
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
      ["qbo:Mystery Account", `QuickBooks "Mystery Account" (not mapped)`, 700, 0, "Not mapped to any of our categories. Add it to --map."],
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
    expect(report).toContain("| Feb 2026 | $100.00 | $100.00 | 0 | $30.00 | $30.00 | 0 | $29.00 | $70.00 | +$41.00 | MISMATCH |");
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

describe("describeDatabase", () => {
  it("names the host and database, never the user or password", () => {
    const d = describeDatabase("postgresql://quitbooks_owner:s3cret-pw@ep-snowy-queen-123-pooler.us-east-1.aws.neon.tech/quitbooks?sslmode=require");
    expect(d).toBe("ep-snowy-queen-123-pooler.us-east-1.aws.neon.tech/quitbooks");
    expect(d).not.toMatch(/s3cret|quitbooks_owner/);
    expect(describeDatabase("postgres://u:p@localhost:5433/books")).toBe("localhost:5433/books");
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
    expect(ok).toContain("| Jan 2026 | $100.00 | $100.00 | 0 | $40.00 | $40.00 | 0 | $60.00 | $60.00 | 0 | ok |");

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
  ])("refuses %j", (argv, message) => {
    expect(() => parseCompareArgs(argv as string[])).toThrow(message);
  });
});
