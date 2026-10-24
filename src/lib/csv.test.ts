import { describe, expect, it } from "vitest";
import { detectMapping, parseBankCsv, type CsvMapping } from "./csv";
import { parseBankDate } from "./dates";

describe("parseBankDate", () => {
  it.each([
    ["2026-10-01", "2026-10-01"],
    ["10/01/2026", "2026-10-01"],
    ["1/5/2026", "2026-01-05"],
    ["01/05/26", "2026-01-05"],
    ["10-01-2026", "2026-10-01"],
    ["2026-10-01T00:00:00", "2026-10-01"],
  ])("parses %s", (input, expected) => {
    expect(parseBankDate(input)).toBe(expected);
  });

  it.each(["13/01/2026", "02/30/2026", "yesterday", ""])("rejects %s", (input) => {
    expect(parseBankDate(input)).toBeNull();
  });
});

describe("detectMapping", () => {
  it("detects a single signed amount column", () => {
    expect(detectMapping(["Posting Date", "Description", "Amount", "Balance"])).toEqual({
      dateColumn: "Posting Date",
      descriptionColumn: "Description",
      amountMode: "single",
      amountColumn: "Amount",
      memoColumn: undefined,
    });
  });

  it("detects split debit/credit columns", () => {
    const m = detectMapping(["Date", "Description", "Withdrawals", "Deposits"]);
    expect(m).toMatchObject({ amountMode: "split", debitColumn: "Withdrawals", creditColumn: "Deposits" });
  });

  it("returns null without the required columns", () => {
    expect(detectMapping(["Foo", "Bar"])).toBeNull();
  });
});

describe("parseBankCsv", () => {
  it("parses a signed-amount export", () => {
    const csv = [
      "Posting Date,Description,Amount",
      '10/01/2026,"ZELLE FROM JANE DOE",250.00',
      "10/02/2026,INDY POWER & LIGHT,-182.40",
    ].join("\n");
    const r = parseBankCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.date, x.amountCents, x.description])).toEqual([
      ["2026-10-01", 25000, "ZELLE FROM JANE DOE"],
      ["2026-10-02", -18240, "INDY POWER & LIGHT"],
    ]);
  });

  it("parses split debit/credit columns regardless of sign convention", () => {
    const csv = [
      "Date,Description,Debit,Credit",
      "2026-10-01,Rent payment,1500.00,",
      "2026-10-02,Zelle from Sam,,200",
      "2026-10-03,Supplies,-45.10,",
    ].join("\n");
    const r = parseBankCsv(csv);
    expect(r.rows.map((x) => x.amountCents)).toEqual([-150000, 20000, -4510]);
  });

  it("skips preamble lines before the header", () => {
    const csv = ["Account: BMO Business Checking ****1234", "", "Date,Description,Amount", "10/05/2026,Test,10"].join(
      "\n",
    );
    const r = parseBankCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].line).toBe(4);
  });

  it("doesn't mistake a preamble line containing 'date' and a comma for the header", () => {
    const csv = [
      "Account Name: EXAMPLE SALON",
      "Activity date range: 10/01/2026 to 10/31/2026, all transactions",
      "Last updated 10/24/2026, 3:00 PM",
      "",
      "Posted Date,Description,Amount,Balance",
      "10/05/2026,Test,10,110.00",
    ].join("\n");
    const r = parseBankCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].line).toBe(6);
    expect(r.mapping?.dateColumn).toBe("Posted Date");
  });

  it("produces stable hashes, and distinguishes repeated identical rows", () => {
    const csv = ["Date,Description,Amount", "10/01/2026,Coffee,-5", "10/01/2026,Coffee,-5", "10/02/2026,Coffee,-5"].join(
      "\n",
    );
    const a = parseBankCsv(csv);
    const b = parseBankCsv(csv);
    expect(a.rows.map((r) => r.dedupeHash)).toEqual(b.rows.map((r) => r.dedupeHash));
    expect(new Set(a.rows.map((r) => r.dedupeHash)).size).toBe(3);

    // An overlapping later export containing just the 10/02 row matches the earlier hash.
    const later = parseBankCsv(["Date,Description,Amount", "10/02/2026,Coffee,-5"].join("\n"));
    expect(later.rows[0].dedupeHash).toBe(a.rows[2].dedupeHash);
  });

  describe("hash stability across mapping changes", () => {
    const csv = [
      "Date,Description,Memo,Amount",
      "10/01/2026,ZELLE PAYMENT,JANE DOE,250.00",
      "10/01/2026,ZELLE PAYMENT,JOHN ROE,250.00",
      "10/02/2026,SALLY BEAUTY,,45.00",
    ].join("\n");
    const base: CsvMapping = {
      dateColumn: "Date",
      descriptionColumn: "Description",
      amountMode: "single",
      amountColumn: "Amount",
    };

    it("is unchanged by toggling the memo column", () => {
      const without = parseBankCsv(csv, base);
      const withMemo = parseBankCsv(csv, { ...base, memoColumn: "Memo" });
      expect(withMemo.rows.map((r) => r.description)).not.toEqual(without.rows.map((r) => r.description));
      expect(withMemo.rows.map((r) => r.dedupeHash)).toEqual(without.rows.map((r) => r.dedupeHash));
      // Two rows share date/amount/description column, so they are told apart by occurrence index.
      expect(new Set(without.rows.map((r) => r.dedupeHash)).size).toBe(3);
    });

    it("is unchanged by toggling invertSign (while the stored sign flips)", () => {
      const normal = parseBankCsv(csv, base);
      const inverted = parseBankCsv(csv, { ...base, invertSign: true });
      expect(inverted.rows.map((r) => r.amountCents)).toEqual(normal.rows.map((r) => -r.amountCents));
      expect(inverted.rows.map((r) => r.dedupeHash)).toEqual(normal.rows.map((r) => r.dedupeHash));
    });

    it("ignores whitespace and case in the description column, and date/amount formats", () => {
      const a = parseBankCsv(["Date,Description,Amount", "10/01/2026,Sally  Beauty,-$45.00"].join("\n"));
      const b = parseBankCsv(["Date,Description,Amount", "2026-10-01, SALLY BEAUTY ,(45)"].join("\n"));
      expect(a.rows[0].dedupeHash).toBe(b.rows[0].dedupeHash);
    });

    it("changes when the description column or amount really differs", () => {
      const a = parseBankCsv(["Date,Description,Amount", "10/01/2026,SALLY,-45"].join("\n"));
      const b = parseBankCsv(["Date,Description,Amount", "10/01/2026,SALLY,-46"].join("\n"));
      const c = parseBankCsv(["Date,Description,Amount", "10/01/2026,SALLY B,-45"].join("\n"));
      expect(new Set([a, b, c].map((r) => r.rows[0].dedupeHash)).size).toBe(3);
    });
  });

  it("reports an out-of-range amount as a row error", () => {
    const r = parseBankCsv(["Date,Description,Amount", "10/01/2026,ACCT 12345678901,12345678901"].join("\n"));
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  it("reports bad rows instead of throwing", () => {
    const csv = ["Date,Description,Amount", "notadate,X,5", "10/01/2026,Y,", "10/01/2026,Z,0", "10/01/2026,OK,1"].join(
      "\n",
    );
    const r = parseBankCsv(csv);
    expect(r.rows.map((x) => x.description)).toEqual(["OK"]);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });

  it("appends a memo column to the description", () => {
    const csv = ["Date,Description,Memo,Amount", "10/01/2026,ZELLE PAYMENT,JANE DOE,250"].join("\n");
    const r = parseBankCsv(csv);
    expect(r.rows[0].description).toBe("ZELLE PAYMENT — JANE DOE");
  });

  it("supports inverted sign banks via mapping", () => {
    const csv = ["Date,Description,Amount", "10/01/2026,Supplies,45"].join("\n");
    const r = parseBankCsv(csv, {
      dateColumn: "Date",
      descriptionColumn: "Description",
      amountMode: "single",
      amountColumn: "Amount",
      invertSign: true,
    });
    expect(r.rows[0].amountCents).toBe(-4500);
  });
});
