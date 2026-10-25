import { describe, expect, it } from "vitest";
import { leftToAssign, splitTotal, validateSplit, type SplitContext, type SplitLineInput } from "./splits";

const ctx = (parentAmountCents: number, over: Partial<SplitContext> = {}): SplitContext => ({
  parentAmountCents,
  categories: [
    { id: "booth", archived: false },
    { id: "sales", archived: false },
    { id: "fees", archived: false },
    { id: "supplies", archived: false },
    { id: "old", archived: true },
  ],
  boothRentCategoryId: "booth",
  stylistIds: ["jane", "kim"],
  ...over,
});

const line = (categoryId: string, amountCents: number, stylistId: string | null = null, memo: string | null = null): SplitLineInput => ({
  categoryId,
  stylistId,
  amountCents,
  memo,
});

describe("validateSplit", () => {
  it("accepts a deposit covering two stylists' booth rent", () => {
    const v = validateSplit([line("booth", 25000, "jane"), line("booth", 25000, "kim")], ctx(50000));
    expect(v.ok).toBe(true);
  });

  it("accepts mixed signs: a Square deposit net of fees (+$103 sales, -$3 fees on +$100)", () => {
    const v = validateSplit([line("sales", 10300), line("fees", -300)], ctx(10000));
    expect(v).toEqual({ ok: true, lines: [line("sales", 10300), line("fees", -300)] });
  });

  it("accepts a money-out split", () => {
    expect(validateSplit([line("supplies", -4000), line("fees", -1000)], ctx(-5000)).ok).toBe(true);
  });

  it("needs at least 2 lines", () => {
    expect(validateSplit([line("sales", 10000)], ctx(10000))).toMatchObject({ ok: false, error: expect.stringMatching(/at least 2/) });
    expect(validateSplit([], ctx(10000)).ok).toBe(false);
  });

  it("rejects too many lines", () => {
    const many = Array.from({ length: 31 }, () => line("sales", 1));
    expect(validateSplit(many, ctx(31)).ok).toBe(false);
  });

  it("rejects zero, fractional, NaN and out-of-range amounts", () => {
    expect(validateSplit([line("sales", 10000), line("fees", 0)], ctx(10000))).toMatchObject({ ok: false, line: 2 });
    expect(validateSplit([line("sales", 5000.5), line("fees", 4999.5)], ctx(10000))).toMatchObject({ ok: false, line: 1 });
    expect(validateSplit([line("sales", Number.NaN), line("fees", 100)], ctx(100))).toMatchObject({ ok: false, line: 1 });
    expect(validateSplit([line("sales", 3_000_000_000), line("fees", -2_999_990_000)], ctx(10000))).toMatchObject({ ok: false, line: 1 });
  });

  it("requires the lines to sum exactly to the parent", () => {
    const under = validateSplit([line("sales", 6000), line("fees", 3999)], ctx(10000));
    expect(under).toMatchObject({ ok: false, error: expect.stringMatching(/\$0\.01 is still unassigned/) });
    const over = validateSplit([line("supplies", -4000), line("fees", -2000)], ctx(-5000));
    expect(over).toMatchObject({ ok: false, error: expect.stringMatching(/\$10\.00 over/) });
  });

  it("requires every category to exist and not be archived", () => {
    expect(validateSplit([line("sales", 5000), line("nope", 5000)], ctx(10000))).toMatchObject({ ok: false, line: 2 });
    expect(validateSplit([line("", 5000), line("sales", 5000)], ctx(10000))).toMatchObject({ ok: false, line: 1 });
    expect(validateSplit([line("sales", 5000), line("old", 5000)], ctx(10000))).toMatchObject({
      ok: false,
      line: 2,
      error: expect.stringMatching(/hidden/),
    });
  });

  it("requires a stylist on Booth Rent lines, and a stylist that exists", () => {
    expect(validateSplit([line("booth", 25000, "jane"), line("booth", 25000)], ctx(50000))).toMatchObject({
      ok: false,
      line: 2,
      error: expect.stringMatching(/stylist/),
    });
    expect(validateSplit([line("booth", 25000, "jane"), line("booth", 25000, "ghost")], ctx(50000))).toMatchObject({ ok: false, line: 2 });
  });

  it("trims memos, turns empty memos into null, and caps their length", () => {
    const v = validateSplit([line("sales", 10300, null, "  Square sales  "), line("fees", -300, null, "   ")], ctx(10000));
    expect(v.ok && v.lines.map((l) => l.memo)).toEqual(["Square sales", null]);
    expect(validateSplit([line("sales", 10300, null, "x".repeat(201)), line("fees", -300)], ctx(10000)).ok).toBe(false);
  });
});

describe("leftToAssign", () => {
  it("is measured in the parent's direction", () => {
    expect(leftToAssign(10000, [{ amountCents: 6000 }])).toBe(4000);
    expect(leftToAssign(10000, [{ amountCents: 10300 }, { amountCents: -300 }])).toBe(0);
    expect(leftToAssign(-5000, [{ amountCents: -4000 }])).toBe(1000);
    expect(leftToAssign(-5000, [{ amountCents: -6000 }])).toBe(-1000);
    expect(splitTotal([{ amountCents: 1 }, { amountCents: -3 }])).toBe(-2);
  });
});
