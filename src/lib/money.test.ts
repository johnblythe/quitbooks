import { describe, expect, it } from "vitest";
import { formatCents, parseAmountToCents } from "./money";

describe("parseAmountToCents", () => {
  it.each([
    ["12.34", 1234],
    ["$1,234.56", 123456],
    ["-45.00", -4500],
    ["(45.00)", -4500],
    ["45.00-", -4500],
    ["+7", 700],
    ["0.1", 10],
    ["1.005", 101],
    [" 300 ", 30000],
    [12.5, 1250],
  ])("parses %s", (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  it.each(["", "abc", "1.2.3", null, undefined])("rejects %s", (input) => {
    expect(parseAmountToCents(input as string)).toBeNull();
  });

  it("routes numbers through the string path (no float error)", () => {
    expect(parseAmountToCents(1.005)).toBe(101);
    expect(parseAmountToCents(0.285)).toBe(29);
    expect(parseAmountToCents(-19.99)).toBe(-1999);
    expect(parseAmountToCents(NaN)).toBeNull();
    expect(parseAmountToCents(Infinity)).toBeNull();
  });

  it("bounds amounts to the integer column range", () => {
    expect(parseAmountToCents("21474836.47")).toBe(2147483647);
    expect(parseAmountToCents("-21474836.47")).toBe(-2147483647);
    expect(parseAmountToCents("21474836.48")).toBeNull();
    expect(parseAmountToCents("-21474836.48")).toBeNull();
    expect(parseAmountToCents("99999999999999999999")).toBeNull();
    expect(parseAmountToCents(1e12)).toBeNull();
  });
});

describe("formatCents", () => {
  it("formats dollars", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-4500)).toBe("-$45.00");
    expect(formatCents(123456, { whole: true })).toBe("$1,235");
    expect(formatCents(500, { signed: true })).toBe("+$5.00");
  });
});
