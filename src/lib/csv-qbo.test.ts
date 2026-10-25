/**
 * QuickBooks "Transaction Detail by Account" export, read from fixtures/qbo-transaction-detail.sample.csv.
 * NOTE: the fixture is SYNTHETIC. It was written from memory of QBO's report layout, not copied from a
 * real export, so these tests prove the parser is tolerant, not that it matches QBO byte for byte.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectMapping, joinDescription, mappingFits, parseBankCsv } from "./csv";
import { summarizeFileCategories } from "./import-categories";

const sample = readFileSync("fixtures/qbo-transaction-detail.sample.csv", "utf8");
const HEADERS = ["Date", "Transaction Type", "Num", "Name", "Memo/Description", "Split", "Amount", "Balance"];

describe("detectMapping on a QuickBooks header", () => {
  it("finds Name, Memo/Description, Split (as the category) and Amount", () => {
    expect(detectMapping(HEADERS)).toMatchObject({
      dateColumn: "Date",
      descriptionColumn: "Name",
      memoColumn: "Memo/Description",
      categoryColumn: "Split",
      amountMode: "single",
      amountColumn: "Amount",
    });
  });
  it("finds a plain Category column too, but not an unrelated Account column", () => {
    expect(detectMapping(["Date", "Description", "Category", "Amount"])?.categoryColumn).toBe("Category");
    expect(detectMapping(["Date", "Description", "Account", "Amount"])?.categoryColumn).toBeUndefined();
  });
  it("leaves plain bank headers without a category column", () => {
    expect(detectMapping(["Posting Date", "Description", "Amount", "Balance"])?.categoryColumn).toBeUndefined();
  });
});

describe("parsing the QuickBooks sample", () => {
  const parsed = parseBankCsv(sample);

  it("skips the preamble, section row, beginning balance, totals and footer silently", () => {
    // section heading, Beginning Balance, "Total for ...", "Cash Basis ..." footer
    expect(parsed.skippedLines).toBe(4);
    expect(parsed.rows).toHaveLength(31);
  });

  it("still reports a real parse error: a bad date on a row that has an amount", () => {
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].message).toMatch(/Unrecognized date "13\/45\/2025"/);
  });

  it("keeps signs as the bank shows them and reads thousands separators", () => {
    const rent = parsed.rows.find((r) => r.description.startsWith("Landlord LLC — January rent"))!;
    expect(rent.amountCents).toBe(-180000);
    expect(parsed.rows.find((r) => r.description === "Zelle booth rent Jane Doe")!.amountCents).toBe(35000);
  });

  it("builds the description from Name + Memo, dropping duplicates", () => {
    const descriptions = new Set(parsed.rows.map((r) => r.description));
    expect(descriptions.has("Landlord LLC — January rent")).toBe(true); // both parts
    expect(descriptions.has("Duke Energy")).toBe(true); // memo repeats the name
    expect(descriptions.has("Zelle booth rent Jane Doe")).toBe(true); // memo already contains the name
    expect(descriptions.has("Zelle from a stranger")).toBe(true); // no name, memo only
  });

  it("captures the category (Split) for each row", () => {
    const groups = summarizeFileCategories(parsed.rows);
    const by = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(by["booth rent"].count).toBe(7);
    expect(by["-split-"].count).toBe(1);
    // "Rent Expense" and "rent expense" are one value
    expect(by["rent expense"].count).toBe(3);
    expect(by["rent expense"].netCents).toBe(-540000);
    // the row with a blank category isn't a group
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(30);
  });

  it("gives repeated same-day, same-payee, same-amount rows distinct dedupe hashes", () => {
    const sally = parsed.rows.filter((r) => r.date === "2025-02-14");
    expect(sally).toHaveLength(2);
    expect(sally[0].dedupeHash).not.toBe(sally[1].dedupeHash);
  });

  it("is stable on re-parse (same hashes)", () => {
    expect(parseBankCsv(sample).rows.map((r) => r.dedupeHash)).toEqual(parsed.rows.map((r) => r.dedupeHash));
  });
});

describe("report furniture detection", () => {
  const header = "Date,Name,Memo/Description,Split,Amount";
  it("skips TOTAL and Accrual Basis lines in any case, and rows with neither date nor amount", () => {
    const csv = [
      header,
      "Operating,,,,",
      "10/01/2026,Sally,Color,Supplies,-10.00",
      "TOTAL,,,,-10.00",
      "total for Operating,,,,-10.00",
      "Accrual Basis Saturday,,,,",
    ].join("\n");
    const p = parseBankCsv(csv);
    expect(p.rows).toHaveLength(1);
    expect(p.skippedLines).toBe(4);
    expect(p.errors).toEqual([]);
  });

  it("counts nothing as skipped, and reports errors, for an ordinary bank CSV", () => {
    const p = parseBankCsv("Date,Description,Amount\n10/01/2026,SALLY,-10.00\nnot a date,X,5.00\n");
    expect(p.skippedLines).toBe(0);
    expect(p.errors).toHaveLength(1);
  });

  it("works with debit/credit columns", () => {
    const p = parseBankCsv("Date,Name,Debit,Credit,Split\nSection,,,,\n10/01/2026,A,5.00,,Supplies\nTotal for X,,5.00,,\n");
    expect(p.rows).toHaveLength(1);
    expect(p.skippedLines).toBe(2);
  });
});

describe("joinDescription", () => {
  it.each([
    ["Jane", "rent", "Jane — rent"],
    ["Jane", "jane", "Jane"],
    ["Jane", "Zelle from JANE DOE", "Zelle from JANE DOE"],
    ["", "memo only", "memo only"],
    ["name only", "", "name only"],
    ["", "", "(no description)"],
  ])("%j + %j", (name, memo, expected) => expect(joinDescription(name, memo)).toBe(expected));
});

describe("mappingFits", () => {
  it("requires every named column to exist in the file", () => {
    const m = detectMapping(HEADERS)!;
    expect(mappingFits(m, HEADERS)).toBe(true);
    expect(mappingFits(m, ["Date", "Description", "Amount"])).toBe(false);
  });
});
