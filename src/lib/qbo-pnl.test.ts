import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseColumnLabel, parseQboPnl, QboPnlParseError, sectionDirection, selectMonths, type QboPnl } from "./qbo-pnl";

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
  ])("reads %s", (label, month, from, to, partial) => {
    expect(parseColumnLabel(label)).toEqual({ column: { label, month, from, to, partial } });
  });

  it("explains labels that are month-shaped but unusable", () => {
    expect(parseColumnLabel("Sep 28 - Oct 3, 2026")).toEqual({ error: expect.stringContaining("spans two months") });
    expect(parseColumnLabel("Feb 1-30, 2026")).toEqual({ error: expect.stringContaining("isn't a real date range") });
  });

  it.each(["Total", "Q1 2026", "2026", "Week 1", "Jan 1, 2026 - Feb 1, 2026", ""])("ignores %s", (label) => {
    expect(parseColumnLabel(label)).toBeNull();
  });
});

describe("parseQboPnl: the committed sample", () => {
  it("reads every account, section and summary row, with nothing left over", () => {
    const p = parseQboPnl(sample);
    expect(p.warnings).toEqual([]);
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
    expect(p.warnings).toEqual([]);
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
    expect(p.warnings).toEqual([]);
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
    expect(p.warnings).toEqual([]);
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
    expect(p.warnings).toEqual([]);
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
    expect(p.warnings).toEqual([]);
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
    expect(p.warnings).toEqual([]);
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
    expect(p.warnings).toEqual([]);
    expect(p.sections).toEqual(["income"]);
    expect(byName(p, "Other Income:Gift Cards")).toMatchObject({ section: "income" });
  });

  it("copes with an unquoted footer, a BOM and Windows line endings", () => {
    const text = "\uFEFF" + report(["Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00", "Net Income,10.00,10.00,20.00"])
      .replace('"Cash Basis Saturday, November 7, 2026 10:00 AM GMT-05:00"', "Cash Basis Saturday, November 7, 2026 10:00 AM")
      .replace(/\n/g, "\r\n");
    const p = parseQboPnl(text);
    expect(p.basis).toBe("cash");
    expect(p.warnings).toEqual([]);
    expect(p.accounts).toHaveLength(1);
  });
});

describe("parseQboPnl: cross-checks become warnings", () => {
  it("flags a section whose accounts don't add up to its Total row", () => {
    const p = parseQboPnl(report(["Income", "Sales,10.00,10.00,20.00", "Total Income,12.00,10.00,22.00", "Net Income,10.00,10.00,20.00"]));
    expect(p.warnings).toEqual([`Line 8: "Total Income" for Jan 2026 says $12.00, but the accounts above it add up to $10.00.`]);
  });

  it("flags a Total column that isn't the sum of the months, and otherwise ignores it", () => {
    const p = parseQboPnl(report(["Income", "Sales,10.00,10.00,99.00", "Total Income,10.00,10.00,20.00", "Net Income,10.00,10.00,20.00"]));
    expect(p.warnings).toEqual([`Line 7: "Sales" Total column says $99.00, but its months add up to $20.00.`]);
    expect(p.accounts[0].cents).toEqual({ "2026-01": 1000, "2026-02": 1000 });
  });

  it("flags summary rows that disagree with the accounts", () => {
    const p = parseQboPnl(
      report(["Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00", "Gross Profit,10.00,10.00,20.00", "Net Income,10.00,9.00,19.00"]),
    );
    expect(p.warnings).toEqual([`Line 10: "Net Income" for Feb 2026 says $9.00, but the accounts add up to $10.00.`]);
  });

  it("warns when there's no Net Income row, no cash-basis marker, or the report is accrual", () => {
    const body = ["Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00"];
    expect(parseQboPnl(report(body)).warnings).toEqual([expect.stringContaining('No "Net Income" row')]);
    const accrual = report([...body, "Net Income,10.00,10.00,20.00"]).replace("Cash Basis", "Accrual Basis");
    expect(parseQboPnl(accrual).warnings).toEqual([expect.stringContaining("Accrual basis")]);
    const none = report([...body, "Net Income,10.00,10.00,20.00"]).replace(/"Cash Basis.*"/, "");
    expect(parseQboPnl(none).warnings).toEqual([expect.stringContaining('Couldn\'t find "Cash Basis"')]);
  });

  it("guesses a section's end when its Total row is missing, and says so", () => {
    const p = parseQboPnl(
      report(["Income", "Sales,10.00,10.00,20.00", "Expenses", "Rent,5.00,5.00,10.00", "Total Expenses,5.00,5.00,10.00", "Net Income,5.00,5.00,10.00"]),
    );
    expect(p.warnings).toEqual([`"Income" (line 6) has no Total row, so where it ends was guessed.`]);
    expect(p.accounts.map((a) => [a.name, a.section])).toEqual([["Sales", "income"], ["Rent", "expenses"]]);
  });

  it("warns about amounts outside any section and Total rows that close nothing", () => {
    const p = parseQboPnl(
      report(["Stray,1.00,1.00,2.00", "Income", "Sales,10.00,10.00,20.00", "Total Income,10.00,10.00,20.00", "Total Widgets,3.00,3.00,6.00", "Net Income,10.00,10.00,20.00"]),
    );
    expect(p.warnings).toEqual([
      expect.stringContaining(`Line 6: "Stray" has amounts but isn't under Income`),
      expect.stringContaining(`Line 10: "Total Widgets" doesn't close any section`),
    ]);
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

  it("has months out of order", () => {
    expect(() => parseQboPnl(report([], ",Feb 2026,Jan 2026,Total"))).toThrow(/oldest to newest/);
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
    expect(feb.warnings).toEqual([]);
    expect(selectMonths(p).months).toEqual(p.months);
  });

  it("warns about asked-for months the file doesn't have, and refuses an empty range", () => {
    expect(selectMonths(p, "2024-11", "2025-01").warnings).toEqual([expect.stringContaining("starts at Jan 2025")]);
    expect(selectMonths(p, "2025-03", "2025-06").warnings).toEqual([expect.stringContaining("ends at Mar 2025")]);
    expect(() => selectMonths(p, "2026-01")).toThrow(/none of those months/);
    expect(() => selectMonths(p, "2025-03", "2025-01")).toThrow(/after/);
  });
});
