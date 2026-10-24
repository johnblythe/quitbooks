import { describe, expect, it } from "vitest";
import { categorize, matchRule, matchStylist, type MatchableRule, type MatchableStylist } from "./categorize";

const stylists: MatchableStylist[] = [
  { id: "s1", name: "Jane Doe", matchText: null, startDate: "2026-01-01", endDate: null },
  { id: "s2", name: "Sam", matchText: "SAMANTHA R, S RIVERA", startDate: "2026-01-01", endDate: null },
];

const rules: MatchableRule[] = [
  { id: "r1", pattern: "power & light", categoryId: "utilities", direction: "out", priority: 100 },
  { id: "r2", pattern: "sally beauty", categoryId: "supplies", direction: "any", priority: 100 },
  { id: "r3", pattern: "zelle", categoryId: "other-income", direction: "in", priority: 200 },
];

describe("matchStylist", () => {
  it("matches by full name when no match text is set", () => {
    expect(matchStylist({ date: "2026-10-01", amountCents: 25000, description: "Zelle from JANE DOE" }, stylists)?.id).toBe(
      "s1",
    );
  });

  it("matches any of several comma-separated match texts", () => {
    expect(matchStylist({ date: "2026-10-01", amountCents: 100, description: "ZELLE S RIVERA 123" }, stylists)?.id).toBe(
      "s2",
    );
  });

  it("ignores money out", () => {
    expect(matchStylist({ date: "2026-10-01", amountCents: -100, description: "JANE DOE refund" }, stylists)).toBeNull();
  });
});

describe("matchRule", () => {
  it("respects direction", () => {
    expect(matchRule({ date: "x", amountCents: -100, description: "INDY POWER & LIGHT" }, rules)?.id).toBe("r1");
    expect(matchRule({ date: "x", amountCents: 100, description: "INDY POWER & LIGHT" }, rules)).toBeNull();
  });

  it("orders by priority", () => {
    const r = matchRule({ date: "x", amountCents: 100, description: "ZELLE SALLY BEAUTY" }, rules);
    expect(r?.id).toBe("r2");
  });
});

describe("categorize", () => {
  const ctx = { stylists, rules, boothRentCategoryId: "booth-rent" };

  it("stylist payments become Booth Rent tagged to the stylist, ahead of rules", () => {
    expect(categorize({ date: "2026-10-01", amountCents: 25000, description: "ZELLE FROM JANE DOE" }, ctx)).toEqual({
      categoryId: "booth-rent",
      stylistId: "s1",
      reason: "stylist",
    });
  });

  it("falls back to rules, then uncategorized", () => {
    expect(categorize({ date: "x", amountCents: -100, description: "SALLY BEAUTY #12" }, ctx).categoryId).toBe(
      "supplies",
    );
    expect(categorize({ date: "x", amountCents: -100, description: "MYSTERY" }, ctx)).toEqual({
      categoryId: null,
      stylistId: null,
      reason: null,
    });
  });
});
