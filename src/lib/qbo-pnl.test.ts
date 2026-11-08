import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCellAmount, parseColumnLabel, parseQboPnl, QboPnlParseError, sectionDirection, selectMonths, type QboPnl } from "./qbo-pnl";

const sample = readFileSync("fixtures/qbo-pnl-by-month.sample.csv", "utf8");

/** A small report: preamble, header, then the body lines given, then the cash-basis footer. */
function report(body: string[], header = ",Jan 2026,Feb 2026,Total"): string {
  return ["Salon LLC", "Profit and Loss", '"January - February, 2026"', "", header, ...body, "", '"Cash Basis Saturday, November 7, 2026 10:00 AM GMT-05:00"'].join("\n");
}

const accounts = (p: QboPnl) => p.accounts.map((a) => ({ path: a.path, section: a.section, cents: a.cents }));
const byName = (p: QboPnl, name: string) => p.accounts.find((a) => a.path.join(":") === name);

describe("parseColumnLabel", () => {
  it.each([
    ["Jan 2026", "2026-01", "2026-01-01", "2026-01-31", false],
    ["January 2026", "2026-01", "2026-01-01", "2026-01-31", false],
    ["Jan. 2026", "2026-01", "2026-01-01", "2026-01-31", false],
    ["Sept 2026", "2026-09", "2026-09-01", "2026-09-30", false],
    ["Feb 2024", "2024-02", "2024-02-01", "2024-02-29", false],
    ["Oct 1-15, 2026", "2026-10", "2026-10-01", "2026-10-15", true],
    ["October 16–31, 2026", "2026-10", "2026-10-16", "2026-10-31", true],
    ["Oct 1 - Oct 31, 2026", "2026-10", "2026-10-01", "2026-10-31", false],
    ["Nov 1, 2026", "2026-11", "2026-11-01", "2026-11-01", true],
    // What Excel writes for "Jan 2026" when the file is opened and re-saved.
    ["Jan-26", "2026-01", "2026-01-01", "2026-01-31", false],
    ["Jan 26", "2026-01", "2026-01-01", "2026-01-31", false],
    ["Sep-26", "2026-09", "2026-09-01", "2026-09-30", false],
    ["January-2026", "2026-01", "2026-01-01", "2026-01-31", false],
  ])("reads %s", (label, month, from, to, partial) => {
    expect(parseColumnLabel(label)).toEqual({ column: { label, month, from, to, partial } });
  });

  it("explains labels that are month-shaped but unusable", () => {
    expect(parseColumnLabel("Sep 28 - Oct 3, 2026")).toEqual({ error: expect.stringContaining("spans two months") });
    expect(parseColumnLabel("Feb 1-30, 2026")).toEqual({ error: expect.stringContaining("isn't a real date range") });
  });

  // A two-digit year only in Excel's own "mmm-yy" form: a 3-letter month. "November 17" (from an
  // unquoted date stamp) is not November 2017.
  it.each(["Total", "Q1 2026", "2026", "Week 1", "Jan 1, 2026 - Feb 1, 2026", "", "Jan-6", "Jan-202", "Foo-26", "November 17", "Sept-26", "January-26"])("ignores %s", (label) => {
    expect(parseColumnLabel(label)).toBeNull();
  });
});

describe("parseCellAmount", () => {
  it.each([
    ["-", 0],
    [" - ", 0],
    ["  –  ", 0],
    ["—", 0],
    ["$ -", 0],
    [" $ -   ", 0],
    ["$ (1,234.56)", -123456],
    ["(1,234.56)", -123456],
    ["$1,234.56", 123456],
    ["-5.00", -500],
    ["5.00-", -500],
    ["- 5.00", -500],
  ])("reads %j as %i", (text, cents) => {
    expect(parseCellAmount(text)).toBe(cents);
  });

  it.each(["--", "- -", "-x", "x-", "$", "-$-", "(-)", "n/a"])("refuses %j: a dash is zero only when the cell is just the dash", (text) => {
    expect(parseCellAmount(text)).toBeNull();
  });
});

describe("parseQboPnl: the committed sample", () => {
  it("reads every account, section and summary row, with nothing left over", () => {
    const p = parseQboPnl(sample);
    expect([p.problems, p.warnings]).toEqual([[], []]);
    expect(p.basis).toBe("cash");
    expect(p.months).toEqual(["2025-01", "2025-02", "2025-03"]);
    expect(p.columns.map((c) => [c.label, c.from, c.to, c.partial])).toEqual([
      ["Jan 2025", "2025-01-01", "2025-01-31", false],
      ["Feb 2025", "2025-02-01", "2025-02-28", false],
      ["Mar 2025", "2025-03-01", "2025-03-31", false],
    ]);
    expect(p.sections).toEqual(["income", "cogs", "expenses", "otherExpenses"]);
    expect(p.checks.map((c) => c.name)).toEqual(["Gross Profit", "Net Operating Income", "Net Other Income", "Net Income"]);
    expect(p.accounts).toHaveLength(13);
    expect(byName(p, "Booth Rent")).toMatchObject({ section: "income", cents: { "2025-01": 140000, "2025-02": 70000, "2025-03": 35000 } });
    expect(byName(p, "Supplies")).toMatchObject({ section: "cogs", cents: { "2025-01": 21240, "2025-02": 45075, "2025-03": 0 } });
    expect(byName(p, "Ask My Accountant")).toMatchObject({ section: "otherExpenses", cents: { "2025-02": 12000 } });
    // Summary rows are cross-checks, never accounts.
    expect(p.accounts.some((a) => /total|gross|net /i.test(a.name))).toBe(false);
  });
});

describe("parseQboPnl: layout tolerance", () => {
  it("finds the header after any preamble, whatever the first header cell says", () => {
    const p = parseQboPnl(report(["Income", "Sales,10.00,20.00,30.00", "Total Income,10.00,20.00,30.00", "Net Income,10.00,20.00,30.00"], "Distribution account,Jan 2026,Feb 2026,Total"));
    expect(p.months).toEqual(["2026-01", "2026-02"]);
    expect([p.problems, p.warnings]).toEqual([[], []]);
  });

  it("accepts full month names and a partial last month", () => {
    const p = parseQboPnl(
      report(["Income", "Sales,10.00,5.00,15.00", "Total for Income,10.00,5.00,15.00", "Net Income,10.00,5.00,15.00"], ",September 2026,Oct 1-15, 2026,Total".replace("Oct 1-15, 2026", '"Oct 1-15, 2026"')),
    );
    expect(p.columns.map((c) => [c.month, c.from, c.to, c.partial])).toEqual([
      ["2026-09", "2026-09-01", "2026-09-30", false],
      ["2026-10", "2026-10-01", "2026-10-15", true],
    ]);
  });

  it("reads 1,234.56, $1,234.56, (123.45), -123.45 and blanks", () => {
    const p = parseQboPnl(
      report(
        [
          "Expenses",
          'Rent,"1,234.56","$1,234.56","2,469.12"',
          "Refunds,(123.45),-123.45,-246.90",
          "Fees,,2.00,2.00",
          'Total Expenses,"1,111.11","1,113.11","2,224.22"',
          'Net Income,"-1,111.11","-1,113.11","-2,224.22"',
        ],
      ),
    );
    expect(accounts(p)).toEqual([
      { path: ["Rent"], section: "expenses", cents: { "2026-01": 123456, "2026-02": 123456 } },
      { path: ["Refunds"], section: "expenses", cents: { "2026-01": -12345, "2026-02": -12345 } },
      { path: ["Fees"], section: "expenses", cents: { "2026-01": 0, "2026-02": 200 } },
    ]);
    expect([p.problems, p.warnings]).toEqual([[], []]);
  });

  it("handles all five sections, 'Total X' and 'Total for X', and checks every summary row", () => {
    const p = parseQboPnl(
      report([
        "Income",
        "Sales,100.00,100.00,200.00",
        "Total Income,100.00,100.00,200.00",
        "Cost of Goods Sold",
        "Product Cost,10.00,10.00,20.00",
        "Total for Cost of Goods Sold,10.00,10.00,20.00",
        "Gross Profit,90.00,90.00,180.00",
        "Expenses",
        "Rent,50.00,50.00,100.00",
        "Total Expenses,50.00,50.00,100.00",
        "Net Operating Income,40.00,40.00,80.00",
        "Other Income",
        "Interest Earned,1.00,1.00,2.00",
        "Total Other Income,1.00,1.00,2.00",
        "Other Expenses",
        "Penalties,3.00,,3.00",
        "Total Other Expenses,3.00,0.00,3.00",
        "Net Other Income,-2.00,1.00,-1.00",
        "Net Income,38.00,41.00,79.00",
      ]),
    );
    expect([p.problems, p.warnings]).toEqual([[], []]);
    expect(p.sections).toEqual(["income", "cogs", "expenses", "otherIncome", "otherExpenses"]);
    expect(p.accounts.map((a) => [a.name, a.section, sectionDirection(a.section)])).toEqual([
      ["Sales", "income", "income"],
      ["Product Cost", "cogs", "expense"],
      ["Rent", "expenses", "expense"],
      ["Interest Earned", "otherIncome", "income"],
      ["Penalties", "otherExpenses", "expense"],
    ]);
  });

  it("nests sub-accounts closed by their own Total rows, including a parent's own postings", () => {
    const p = parseQboPnl(
      report([
        "Expenses",
        "Utilities,5.00,,5.00",
        "Electric,10.00,10.00,20.00",
        "Gas,2.00,3.00,5.00",
        "Total Utilities,17.00,13.00,30.00",
        "Car & Truck",
        "Fuel",
        "Diesel,1.00,1.00,2.00",
        "Total for Fuel,1.00,1.00,2.00",
        "Total for Car & Truck,1.00,1.00,2.00",
        "Rent,50.00,50.00,100.00",
        "Total Expenses,68.00,64.00,132.00",
        "Net Income,-68.00,-64.00,-132.00",
      ]),
    );
    expect([p.problems, p.warnings]).toEqual([[], []]);
    expect(p.accounts.map((a) => a.path)).toEqual([["Utilities"], ["Utilities", "Electric"], ["Utilities", "Gas"], ["Car & Truck", "Fuel", "Diesel"], ["Rent"]]);
    expect(byName(p, "Utilities:Electric")!.name).toBe("Electric");
  });

  it("nests by indentation when parents have no Total rows", () => {
    const p = parseQboPnl(
      report([
        "Expenses",
        "   Utilities",
        "      Electric,10.00,10.00,20.00",
        "      Gas,2.00,3.00,5.00",
        "   Rent,50.00,50.00,100.00",
        "Total Expenses,62.00,63.00,125.00",
        "Net Income,-62.00,-63.00,-125.00",
      ]),
    );
    expect([p.problems, p.warnings]).toEqual([[], []]);
    expect(p.accounts.map((a) => a.path)).toEqual([["Utilities", "Electric"], ["Utilities", "Gas"], ["Rent"]]);
  });

  it("reads Parent:Child names, and merges them with the same account written nested", () => {
    const p = parseQboPnl(
      report([
        "Expenses",
        "Utilities:Electric,10.00,10.00,20.00",
        "Utilities",
        "Electric,1.00,,1.00",
        "Total Utilities,1.00,0.00,1.00",
        "Total Expenses,11.00,10.00,21.00",
        "Net Income,-11.00,-10.00,-21.00",
      ]),
    );
    expect([p.problems, p.warnings]).toEqual([[], []]);
    expect(accounts(p)).toEqual([{ path: ["Utilities", "Electric"], section: "expenses", cents: { "2026-01": 1100, "2026-02": 1000 } }]);
  });

  it("keeps a parent account named like a section inside its section", () => {
    const p = parseQboPnl(
      report([
        "Income",
        "Sales,10.00,10.00,20.00",
        "Other Income",
        "Gift Cards,1.00,1.00,2.00",
        "Total Other Income,1.00,1.00,2.00",
        "Total Income,11.00,11.00,22.00",
        "Net Income,11.00,11.00,22.00",
      ]),
    );
    expect([p.problems, p.warnings]).toEqual([[], []]);
    expect(p.sections).toEqual(["income"]);
    expect(byName(p, "Other Income:Gift Cards")).toMatchObject({ section: "income" });
  });

  it("reads a file re-saved in Excel: Jan-26 headers, dash zeros, '$ (x)' negatives, padded cells", () => {
    const p = parseQboPnl(
      report(
        [
          "Expenses,,,",
          'Rent," 1,234.56 "," $ 1,234.56 "," 2,469.12 "',
          'Refunds," $ (123.45)", - ,"(123.45)"',
          "Fees, $ - , – , - ",
          'Total Expenses," 1,111.11 "," 1,234.56 "," 2,345.67 "',
          'Net Income,"(1,111.11)","(1,234.56)","(2,345.67)"',
        ],
        ",Jan-26,Feb-26,Total",
      ),
    );
    expect(accounts(p)).toEqual([
      { path: ["Rent"], section: "expenses", cents: { "2026-01": 123456, "2026-02": 123456 } },
      { path: ["Refunds"], section: "expenses", cents: { "2026-01": -12345, "2026-02": 0 } },
      { path: ["Fees"], section: "expenses", cents: { "2026-01": 0, "2026-02": 0 } },
    ]);
    expect([p.problems, p.warnings]).toEqual([[], []]);
  });

  it("still flags a wrong amount in an Excel-style file", () => {
    const p = parseQboPnl(report(["Expenses,,,", "Rent, 10.00 , - , 10.00 ", "Fees, - , - , 2.00 ", "Total Expenses, 10.00 , - , 10.00 ", "Net Income,(10.00), - ,(10.00)"], ",Jan-26,Feb-26,Total"));
    expect(p.problems).toEqual([{ message: `Line 8: "Fees" Total column says $2.00, but its months add up to $0.00.`, month: null }]);
  });

  it("drops a first column that is blank on every line", () => {
    const text = report(["Income", "Sales,10.00,20.00,30.00", "Total Income,10.00,20.00,30.00", "Net Income,10.00,20.00,30.00"])
      .split("\n")
      .map((l) => `,${l}`)
      .join("\n");
    const p = parseQboPnl(text);
    expect(accounts(p)).toEqual([{ path: ["Sales"], section: "income", cents: { "2026-01": 1000, "2026-02": 2000 } }]);
    expect([p.problems, p.warnings, p.basis]).toEqual([[], [], "cash"]);
  });

  it("skips the date stamp on a line of its own after Net Income, unquoted or not", () => {
    const body = ["Income", "Sales,10.00,20.00,30.00", "Total Income,10.00,20.00,30.00", "Net Income,10.00,20.00,30.00"];
    for (const stamp of ["Saturday, November 7, 2026 10:15 AM GMT-05:00", "November 7, 2026 10:15:02 PM EST", "Sat, Nov 7, 2026", '"Saturday, November 7, 2026 10:15 AM GMT-05:00"']) {
      const text = report(body).replace('"Cash Basis Saturday, November 7, 2026 10:00 AM GMT-05:00"', `Cash Basis\n${stamp}`);
      const p = parseQboPnl(text);
      expect([p.basis, p.problems, p.warnings, p.accounts.length]).toEqual(["cash", [], [], 1]);
    }
  });

  it("skips an unquoted date stamp in the preamble or the footer, even where it looks like a month", () => {
    const body = ["Income", "Sales,10.00,20.00,30.00", "Total Income,10.00,20.00,30.00", "Net Income,10.00,20.00,30.00"];
    // Unquoted, "November 17" and "Nov 17" land in column 2, under where the months go.
    for (const stamp of ["Saturday, November 17, 2026 10:15 AM GMT-05:00", "Sat, Nov 17, 2026 10:15 AM"]) {
      const preamble = ["Salon LLC", "Profit and Loss", stamp, "Cash Basis", "", ",Jan 2026,Feb 2026,Total", ...body].join("\n");
      const p = parseQboPnl(preamble);
      expect([p.months, p.basis, p.problems, p.accounts.length]).toEqual([["2026-01", "2026-02"], "cash", [], 1]);
      const footer = parseQboPnl(report(body).replace('"Cash Basis Saturday, November 7, 2026 10:00 AM GMT-05:00"', `Cash Basis\n${stamp}`));
      expect([footer.months, footer.basis, footer.problems, footer.accounts.length]).toEqual([["2026-01", "2026-02"], "cash", [], 1]);
    }
  });

  it("won't pass over a header with a bad column to a later one when amounts sit between them", () => {
    const text = [",Jan 2026,Q1 2026,Total", "Income", "Sales,1.00,1.00,2.00", ",Jan 2026,Feb 2026,Total", "Income", "Sales,1.00,1.00,2.00", "Total Income,1.00,1.00,2.00", "Net Income,1.00,1.00,2.00"].join("\n");
    expect(() => parseQboPnl(text)).toThrow(/Line 1, column 3: the header "Q1 2026" isn't a month/);
  });

  it("copes with an unquoted footer, a BOM and Windows line endings", () => {
    const text = "\uFEFF" + report(["Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00", "Net Income,10.00,10.00,20.00"])
      .replace('"Cash Basis Saturday, November 7, 2026 10:00 AM GMT-05:00"', "Cash Basis Saturday, November 7, 2026 10:00 AM")
      .replace(/\n/g, "\r\n");
    const p = parseQboPnl(text);
    expect(p.basis).toBe("cash");
    expect([p.problems, p.warnings]).toEqual([[], []]);
    expect(p.accounts).toHaveLength(1);
  });
});

describe("parseQboPnl: the file's own totals are blocking problems", () => {
  it("flags a section whose accounts don't add up to its Total row, for that month", () => {
    const p = parseQboPnl(report(["Income", "Sales,10.00,10.00,20.00", "Total Income,12.00,10.00,22.00", "Net Income,10.00,10.00,20.00"]));
    expect(p.problems).toEqual([
      { message: `Line 8: "Total Income" for Jan 2026 says $12.00, but the accounts above it add up to $10.00.`, month: "2026-01" },
    ]);
    expect(p.warnings).toEqual([]);
  });

  it("flags a Total column that isn't the sum of the months, and otherwise ignores it", () => {
    const p = parseQboPnl(report(["Income", "Sales,10.00,10.00,99.00", "Total Income,10.00,10.00,20.00", "Net Income,10.00,10.00,20.00"]));
    expect(p.problems).toEqual([{ message: `Line 7: "Sales" Total column says $99.00, but its months add up to $20.00.`, month: null }]);
    expect(p.accounts[0].cents).toEqual({ "2026-01": 1000, "2026-02": 1000 });
  });

  it("flags summary rows that disagree with the accounts", () => {
    const p = parseQboPnl(
      report(["Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00", "Gross Profit,10.00,10.00,20.00", "Net Income,10.00,9.00,19.00"]),
    );
    expect(p.problems).toEqual([{ message: `Line 10: "Net Income" for Feb 2026 says $9.00, but the accounts add up to $10.00.`, month: "2026-02" }]);
  });

  it("reads summary rows ending in (Loss) and cross-checks them the same way", () => {
    const body = (net: string) => [
      "Income",
      "Sales,100.00,100.00,200.00",
      "Total Income,100.00,100.00,200.00",
      "Cost of Goods Sold",
      "Product Cost,10.00,10.00,20.00",
      "Total Cost of Goods Sold,10.00,10.00,20.00",
      "Gross Profit (Loss),90.00,90.00,180.00",
      "Expenses",
      "Rent,50.00,50.00,100.00",
      "Total Expenses,50.00,50.00,100.00",
      "Net Operating Income (Loss),40.00,40.00,80.00",
      "Other Expenses",
      "Penalties,3.00,,3.00",
      "Total Other Expenses,3.00,0.00,3.00",
      "Net Other Income (Loss),-3.00,0.00,-3.00",
      `Net Income (Loss),${net}`,
    ];
    const ok = parseQboPnl(report(body("37.00,40.00,77.00")));
    expect([ok.problems, ok.warnings]).toEqual([[], []]);
    expect(ok.checks.map((c) => c.name)).toEqual(["Gross Profit", "Net Operating Income", "Net Other Income", "Net Income"]);
    expect(ok.accounts.map((a) => a.name)).toEqual(["Sales", "Product Cost", "Rent", "Penalties"]);
    const wrong = parseQboPnl(report(body("37.00,41.00,78.00")));
    expect(wrong.problems).toEqual([{ message: `Line 21: "Net Income" for Feb 2026 says $41.00, but the accounts add up to $40.00.`, month: "2026-02" }]);
  });

  it("blocks on a missing Net Income row or an Accrual report; only warns when the basis isn't stated", () => {
    const body = ["Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00"];
    expect(parseQboPnl(report(body)).problems).toEqual([{ message: expect.stringContaining('No "Net Income" row'), month: null }]);
    const accrual = report([...body, "Net Income,10.00,10.00,20.00"]).replace("Cash Basis", "Accrual Basis");
    expect(parseQboPnl(accrual).problems).toEqual([{ message: expect.stringContaining("Accrual basis"), month: null }]);
    const none = parseQboPnl(report([...body, "Net Income,10.00,10.00,20.00"]).replace(/"Cash Basis.*"/, ""));
    expect(none.problems).toEqual([]);
    expect(none.warnings).toEqual([expect.stringContaining('Couldn\'t find "Cash Basis"')]);
  });

  it("blocks when a section's end had to be guessed", () => {
    const p = parseQboPnl(
      report(["Income", "Sales,10.00,10.00,20.00", "Expenses", "Rent,5.00,5.00,10.00", "Total Expenses,5.00,5.00,10.00", "Net Income,5.00,5.00,10.00"]),
    );
    expect(p.problems).toEqual([{ message: `"Income" (line 6) has no Total row, so where it ends was guessed and its accounts can't be checked.`, month: null }]);
    expect(p.accounts.map((a) => [a.name, a.section])).toEqual([["Sales", "income"], ["Rent", "expenses"]]);
  });

  it("ignores a Total row with no amounts that closes nothing, and an empty footer-like row in a section", () => {
    const p = parseQboPnl(
      report(["Expenses", "Rent,5.00,5.00,10.00", "Total Nothing,,,", "Cash Basis Adjustment,,,", "Total Expenses,5.00,5.00,10.00", "Net Income,-5.00,-5.00,-10.00"]),
    );
    expect(p.problems).toEqual([]);
    expect(p.accounts.map((a) => a.name)).toEqual(["Rent"]);
  });
});

describe("parseQboPnl: money it can't place fails the run, with the line", () => {
  const expenses = (rows: string[], header?: string) =>
    report(["Expenses", ...rows, "Utilities,50.00,50.00,100.00", "Total Expenses,75.00,50.00,125.00", "Net Income,-75.00,-50.00,-125.00"], header);

  it("refuses an account whose name starts with Total but closes nothing (Total Wine & More)", () => {
    expect(() => parseQboPnl(expenses(["Total Wine & More,25.00,,25.00"]))).toThrow(
      `Line 7: "Total Wine & More" has amounts and starts with "Total", but doesn't close any section or parent account above it`,
    );
  });

  it("refuses an account that looks like the Cash Basis footer", () => {
    expect(() => parseQboPnl(expenses(["Cash Basis Adjustment,25.00,,25.00"]))).toThrow(/Line 7: "Cash Basis Adjustment" has amounts but looks like the "Cash Basis" footer/);
  });

  it("refuses a Cash Basis row with amounts outside any section, e.g. after Net Income", () => {
    const body = ["Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00", "Net Income,10.00,10.00,20.00"];
    expect(() => parseQboPnl(report([...body, "Cash Basis Adjustment,500.00,500.00,1000.00"]))).toThrow(
      /Line 10: "Cash Basis Adjustment" has amounts but looks like the "Cash Basis" footer/,
    );
    expect(() => parseQboPnl(report(["Cash Basis Adjustment,500.00,,500.00", ...body]))).toThrow(/Line 6: "Cash Basis Adjustment" has amounts/);
    // The real footer, unquoted across three months, still has no amounts in it.
    const three = report(["Income", "Sales,1.00,1.00,1.00,3.00", "Total Income,1.00,1.00,1.00,3.00", "Net Income,1.00,1.00,1.00,3.00"], ",Jan 2026,Feb 2026,Mar 2026,Total").replace(
      '"Cash Basis Saturday, November 7, 2026 10:00 AM GMT-05:00"',
      "Cash Basis Saturday, November 7, 2026 10:00 AM GMT-05:00",
    );
    expect(parseQboPnl(three)).toMatchObject({ basis: "cash", problems: [] });
  });

  it("refuses amounts outside any section", () => {
    expect(() =>
      parseQboPnl(report(["Stray,1.00,1.00,2.00", "Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00", "Net Income,10.00,10.00,20.00"])),
    ).toThrow(`Line 6: "Stray" has amounts but isn't under Income, Cost of Goods Sold, Expenses, Other Income or Other Expenses`);
  });

  it("refuses a summary-looking row it doesn't know, saying so", () => {
    expect(() =>
      parseQboPnl(report(["Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00", "Net Earnings,10.00,10.00,20.00", "Net Income,10.00,10.00,20.00"])),
    ).toThrow(`Line 9: "Net Earnings" has amounts and looks like a summary row, but isn't one this tool knows`);
  });

  it("refuses a date stamp line before Net Income, and other text after it", () => {
    const body = ["Income", "Sales,10.00,20.00,30.00", "Total Income,10.00,20.00,30.00"];
    expect(() => parseQboPnl(report([...body, "Saturday, November 7, 2026 10:15 AM", "Net Income,10.00,20.00,30.00"]))).toThrow(/Line 9: "November 7" under Jan 2026 isn't an amount/);
    expect(() => parseQboPnl(report([...body, "Net Income,10.00,20.00,30.00", "Stray, ten, 5.00"]))).toThrow(/Line 10: "ten" under Jan 2026 isn't an amount/);
    expect(() => parseQboPnl(report([...body, "Net Income,10.00,20.00,30.00", "Stray,5.00,,5.00"]))).toThrow(/Line 10: "Stray" has amounts but isn't under Income/);
    // Not a real day or weekday: not a date stamp.
    expect(() => parseQboPnl(report([...body, "Net Income,10.00,20.00,30.00", "Someday, November 7, 2026"]))).toThrow(/Line 10/);
    // Inside a section (even one opened after Net Income), a date-stamp line is never skipped.
    expect(() =>
      parseQboPnl(report([...body, "Net Income,10.00,20.00,30.00", "Expenses", "Saturday, November 7, 2026", "Total Expenses,0.00,0.00,0.00"])),
    ).toThrow(/Line 11: "November 7" under Jan 2026 isn't an amount/);
  });

  it("says what's wrong with text in a column that has no heading", () => {
    // Labels one column to the right of where the header puts them (a leading column that isn't blank everywhere).
    const text = ["Salon LLC", ",,Jan 2026,Feb 2026,Total", ",Income,,,", ",Sales,10.00,20.00,30.00"].join("\n");
    expect(() => parseQboPnl(text)).toThrow(`Line 3: "Income" in column 2 has no heading above it. Account names must be in the first column`);
  });

  it("refuses amounts with no account name", () => {
    expect(() => parseQboPnl(expenses([",25.00,,25.00"]))).toThrow("Line 7: this row has amounts but no account name.");
  });

  it("refuses an unquoted thousands separator instead of reading 1,800.00 as $1.00 and $800.00", () => {
    expect(() => parseQboPnl(expenses(["Rent,1,800.00,1,800.00,3600.00"]))).toThrow(/Line 7: "800.00" in column 5 isn't under a month heading.*must be quoted/);
    // Even when the split happens to fill exactly the month and Total columns, the Total column catches it.
    const fits = parseQboPnl(report(["Expenses", "Rent,1,800.00,1800.00", "Total Expenses,1.00,800.00,801.00", "Net Income,-1.00,-800.00,-801.00"]));
    expect(fits.problems).toEqual([{ message: `Line 7: "Rent" Total column says $1,800.00, but its months add up to $801.00.`, month: null }]);
  });

  it("refuses money under a blank header cell", () => {
    expect(() => parseQboPnl(expenses(["Rent,25.00,99.00,,25.00"], ",Jan 2026,,Feb 2026,Total"))).toThrow(/Line 7: "99.00" in column 3 isn't under a month heading/);
  });

  it("refuses a Total column that isn't an amount", () => {
    expect(() => parseQboPnl(expenses(["Rent,25.00,,lots"]))).toThrow(`Line 7: "lots" in the Total column isn't an amount.`);
  });
});

describe("parseQboPnl: unreadable files fail with a clear message", () => {
  it("has no month header row", () => {
    expect(() => parseQboPnl(readFileSync("fixtures/qbo-transaction-detail.sample.csv", "utf8"))).toThrow(/Couldn't find the header row with the month columns/);
  });

  it("has a column that isn't a month", () => {
    expect(() => parseQboPnl(report([], ",Jan 2026,Q1 2026,Total"))).toThrow(/column 3: the header "Q1 2026" isn't a month/);
  });

  it("has a column spanning two months", () => {
    expect(() => parseQboPnl(report([], ',Jan 2026,"Jan 28 - Feb 3, 2026",Total'))).toThrow(/spans two months/);
  });

  it("has months out of order, or the same month twice", () => {
    expect(() => parseQboPnl(report([], ",Feb 2026,Jan 2026,Total"))).toThrow(/oldest to newest/);
    expect(() => parseQboPnl(report([], ',Jan 2026,"Jan 1-15, 2026",Total'))).toThrow(/oldest to newest/);
  });

  it("skips a month, so the months between would never be compared", () => {
    expect(() => parseQboPnl(report([], ",Jan 2026,Mar 2026,Total"))).toThrow(`Line 5: the month columns skip from "Jan 2026" to "Mar 2026"`);
  });

  it("has a partial month anywhere but the first or last column", () => {
    expect(() => parseQboPnl(report([], ',Jan 2026,"Feb 1-14, 2026",Mar 2026,Total'))).toThrow(/"Feb 1-14, 2026" covers only part of its month, but isn't the first or last column/);
    expect(() => parseQboPnl(report([], ',"Jan 1-15, 2026",Feb 2026,Total'))).toThrow(/"Jan 1-15, 2026" covers only part/);
    expect(() => parseQboPnl(report([], ',Jan 2026,"Feb 2-28, 2026",Total'))).toThrow(/"Feb 2-28, 2026" covers only part/);
    // Starting late in the first month and ending early in the last are fine.
    const ok = report(["Income", "Sales,1.00,1.00,2.00", "Total Income,1.00,1.00,2.00", "Net Income,1.00,1.00,2.00"], ',"Jan 15-31, 2026","Feb 1-14, 2026",Total');
    expect(parseQboPnl(ok).columns.map((c) => [c.from, c.to])).toEqual([["2026-01-15", "2026-01-31"], ["2026-02-01", "2026-02-14"]]);
  });

  it("has an amount that isn't one", () => {
    expect(() => parseQboPnl(report(["Income", "Sales,ten,10.00,20.00"]))).toThrow(QboPnlParseError);
    expect(() => parseQboPnl(report(["Income", "Sales,ten,10.00,20.00"]))).toThrow(`Line 7: "ten" under Jan 2026 isn't an amount.`);
  });

  it("has no accounts", () => {
    expect(() => parseQboPnl(report(["Net Income,0.00,0.00,0.00"]))).toThrow(/No accounts found/);
  });
});

describe("selectMonths", () => {
  const p = parseQboPnl(sample);

  it("keeps only the months asked for", () => {
    const feb = selectMonths(p, "2025-02", "2025-02");
    expect(feb.months).toEqual(["2025-02"]);
    expect(byName(feb, "Booth Rent")!.cents).toEqual({ "2025-02": 70000 });
    expect(feb.problems).toEqual([]);
    expect(selectMonths(p).months).toEqual(p.months);
  });

  it("refuses months the file doesn't have, which could never be compared", () => {
    expect(() => selectMonths(p, "2024-11", "2025-01")).toThrow(/covers Jan 2025 to Mar 2025, but you asked for 2024-11 to 2025-01/);
    expect(() => selectMonths(p, "2025-03", "2025-06")).toThrow(/but you asked for 2025-03 to 2025-06/);
    expect(() => selectMonths(p, undefined, "2026-09")).toThrow(/but you asked for 2025-01 to 2026-09/);
    expect(() => selectMonths(p, "2025-03", "2025-01")).toThrow(/after/);
  });

  it("keeps the problems of the months kept, and the ones about the whole file", () => {
    const text = report(["Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,11.00,21.00", "Net Income,10.00,10.00,20.00"]).replace("Cash Basis", "Accrual Basis");
    const all = parseQboPnl(text);
    expect(all.problems.map((x) => x.month)).toEqual(["2026-02", null]);
    expect(selectMonths(all, "2026-01", "2026-01").problems.map((x) => x.month)).toEqual([null]);
  });
});
