import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  categorize,
  matchRule,
  matchStylist,
  norm,
  suggestPattern,
  STYLIST_GRACE_AFTER_END_DAYS,
  STYLIST_GRACE_BEFORE_START_DAYS,
  type MatchableRule,
  type MatchableStylist,
} from "./categorize";

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

const ann: MatchableStylist = { id: "ann", name: "Ann", matchText: "ANN", startDate: "2026-01-01", endDate: null };
const tx = (description: string, date = "2026-10-01", amountCents = 25000) => ({ date, amountCents, description });

describe("matchStylist whole words", () => {
  it.each([
    "ANNUAL REWARDS CREDIT",
    "ZELLE PAYMENT FROM JOANNE MERCER",
    "ONLINE TRANSFER FROM SHANNON KELLER SAVINGS",
  ])("does not match Ann inside %s", (d) => {
    expect(matchStylist(tx(d), [ann])).toBeNull();
  });

  it("matches Ann as a whole word", () => {
    expect(matchStylist(tx("ZELLE PAYMENT FROM ANN WHITAKER"), [ann])?.id).toBe("ann");
  });

  it("escapes regex characters in terms", () => {
    const s = { ...ann, id: "x", matchText: "A.B (C)" };
    expect(matchStylist(tx("ZELLE FROM A.B (C) 123"), [s])?.id).toBe("x");
    expect(matchStylist(tx("ZELLE FROM AXB (C) 123"), [s])).toBeNull();
  });

  it("matches multi-term matchText", () => {
    const s = { ...ann, id: "m", matchText: "MARCUS ORTIZ, KELSEY ORTIZ" };
    expect(matchStylist(tx("ZELLE FROM KELSEY ORTIZ"), [s])?.id).toBe("m");
    expect(matchStylist(tx("ZELLE FROM MARCUS ORTIZ"), [s])?.id).toBe("m");
  });
});

describe("matchStylist active window", () => {
  const gone = { ...ann, startDate: "2026-03-01", endDate: "2026-06-30" };
  it("exports the grace constants", () => {
    expect(STYLIST_GRACE_BEFORE_START_DAYS).toBe(14);
    expect(STYLIST_GRACE_AFTER_END_DAYS).toBe(45);
  });
  it("matches 30 days after endDate but not 60", () => {
    expect(matchStylist(tx("ZELLE FROM ANN W", "2026-07-30"), [gone])?.id).toBe("ann");
    expect(matchStylist(tx("ZELLE FROM ANN W", "2026-08-29"), [gone])).toBeNull();
  });
  it("matches 10 days before startDate but not 30", () => {
    expect(matchStylist(tx("ZELLE FROM ANN W", "2026-02-19"), [gone])?.id).toBe("ann");
    expect(matchStylist(tx("ZELLE FROM ANN W", "2026-01-30"), [gone])).toBeNull();
  });
});

describe("matchRule tie-break", () => {
  it("prefers the older rule at equal priority and length", () => {
    const a: MatchableRule = { id: "b", pattern: "AMAZON", categoryId: "new", direction: "any", priority: 100, createdAt: "2026-02-01T00:00:00Z" };
    const b: MatchableRule = { id: "a", pattern: "AMAZON", categoryId: "old", direction: "any", priority: 100, createdAt: "2026-01-01T00:00:00Z" };
    expect(matchRule(tx("AMAZON MKTPLACE", "2026-10-01", -500), [a, b])?.categoryId).toBe("old");
    expect(matchRule(tx("AMAZON MKTPLACE", "2026-10-01", -500), [b, a])?.categoryId).toBe("old");
  });
});

describe("suggestPattern", () => {
  it("picks the longest clean run", () => {
    expect(suggestPattern("POS PURCHASE 0819 SALLY BEAUTY #1847 INDIANAPOLIS IN")).toBe("SALLY BEAUTY");
  });
  it("caps at 5 words", () => {
    expect(suggestPattern("ACH DEBIT MERIDIAN PROPERTY GROUP RENT")).toBe("ACH DEBIT MERIDIAN PROPERTY GROUP");
  });
  it("returns empty when too short", () => {
    expect(suggestPattern("12 34 A")).toBe("");
  });
  it("is empty-or-matching for every fixture description", () => {
    const truth = JSON.parse(readFileSync("fixtures/bmo-fake-12mo-split.truth.json", "utf8")) as {
      rows: { amountCents: number; date: string; description: string }[];
    };
    expect(truth.rows.length).toBeGreaterThan(100);
    for (const r of truth.rows) {
      const p = suggestPattern(r.description);
      expect(p === "" || norm(r.description).includes(p)).toBe(true);
      if (p) expect(matchRule(r, [{ id: "p", pattern: p, categoryId: "c", direction: "any", priority: 1 }])).not.toBeNull();
    }
  });
});
