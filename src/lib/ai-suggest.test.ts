import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_EXAMPLES,
  SUGGEST_SYSTEM,
  buildSuggestRequest,
  majoritySuggestion,
  pickExamples,
  suggestOutputSchema,
  typicalAmount,
  validateSuggestions,
  type SuggestCategory,
  type SuggestExample,
  type SuggestGroup,
} from "./ai-suggest";

const cats: SuggestCategory[] = [
  { id: "c-rent", name: "Booth Rent", kind: "income" },
  { id: "c-supplies", name: "Supplies", kind: "expense" },
  { id: "c-draw", name: "Owner Draw", kind: "transfer" },
  { id: "c-old", name: "Old Thing", kind: "expense", archived: true },
];
const group = (key: string, direction: "in" | "out" = "out"): SuggestGroup => ({
  key,
  pattern: key.split("|")[1] ?? key,
  direction,
  count: 2,
  sampleDescriptions: ["A", "B", "C", "D"],
  typicalAmountCents: 1234,
});

describe("buildSuggestRequest", () => {
  const examples: SuggestExample[] = [
    { description: "SALLY BEAUTY 123 INDIANAPOLIS IN", direction: "out", categoryName: "Supplies" },
    { description: "ZELLE FROM JANE DOE", direction: "in", categoryName: "Booth Rent" },
  ];
  const groups = [group("out|AMAZON"), group("in|ZELLE BOB")];

  it("is deterministic and independent of input order", () => {
    const a = buildSuggestRequest({ categories: cats, examples, groups });
    const b = buildSuggestRequest({
      categories: [...cats].reverse(),
      examples: [...examples].reverse(),
      groups: [...groups].reverse(),
    });
    expect(b).toEqual(a);
    expect(a.system).toBe(SUGGEST_SYSTEM);
  });

  it("contains no timestamps and orders categories by kind then name", () => {
    const { user } = buildSuggestRequest({ categories: cats, examples, groups });
    expect(user).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const body = JSON.parse(user.slice(user.indexOf("{")));
    expect(body.categories.map((c: { id: string }) => c.id)).toEqual(["c-supplies", "c-rent", "c-draw"]);
    expect(body.groups.map((g: { key: string }) => g.key)).toEqual(["in|ZELLE BOB", "out|AMAZON"]);
  });

  it("excludes archived categories and caps samples at 3", () => {
    const { user } = buildSuggestRequest({ categories: cats, examples, groups });
    expect(user).not.toContain("c-old");
    const body = JSON.parse(user.slice(user.indexOf("{")));
    expect(body.groups[0].sampleDescriptions).toHaveLength(3);
  });

  it("de-duplicates examples by merchant pattern and direction", () => {
    const dupes: SuggestExample[] = [
      { description: "SALLY BEAUTY 111 INDIANAPOLIS IN", direction: "out", categoryName: "Supplies" },
      { description: "SALLY BEAUTY 222 CARMEL IN", direction: "out", categoryName: "Supplies" },
      { description: "SALLY BEAUTY REFUND", direction: "in", categoryName: "Supplies" },
    ];
    const body = JSON.parse(buildSuggestRequest({ categories: cats, examples: dupes, groups }).user.replace(/^[^{]*/, ""));
    expect(body.examples).toHaveLength(2);
    expect(body.examples.filter((e: { direction: string }) => e.direction === "out")).toHaveLength(1);
  });

  it("caps examples at 30", () => {
    const many: SuggestExample[] = Array.from({ length: 50 }, (_, i) => ({
      description: `VENDOR${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))} STORE`,
      direction: "out",
      categoryName: "Supplies",
    }));
    const body = JSON.parse(buildSuggestRequest({ categories: cats, examples: many, groups }).user.replace(/^[^{]*/, ""));
    expect(body.examples.length).toBe(MAX_EXAMPLES);
  });

  it("says descriptions are data and keeps the domain rules", () => {
    expect(SUGGEST_SYSTEM).toMatch(/untrusted data/);
    expect(SUGGEST_SYSTEM).toMatch(/transfer, not an expense/);
    expect(SUGGEST_SYSTEM).toMatch(/Zelle from a person is usually Booth Rent/);
    expect(SUGGEST_SYSTEM).toContain("Tax payments (IRS, Indiana DOR) go to a Taxes category if the list has one.");
    expect(SUGGEST_SYSTEM).toContain(
      "Use Owner Draw / Owner Contribution for money between the business and the owner, and Transfer Between Accounts only for the business's own accounts.",
    );
    expect(SUGGEST_SYSTEM).not.toMatch(/IRS estimated/);
  });
});

describe("pickExamples", () => {
  it("keeps the first (newest) row per merchant and direction, up to the cap", () => {
    const rows = [
      { description: "SALLY BEAUTY 1 CARMEL IN", amountCents: -500, categoryName: "Supplies" },
      { description: "SALLY BEAUTY 2 CARMEL IN", amountCents: -700, categoryName: "Other Expense" },
      { description: "AMAZON MKTPLACE", amountCents: -900, categoryName: "Supplies" },
    ];
    const out = pickExamples(rows, 2);
    expect(out.map((e) => e.categoryName)).toEqual(["Supplies", "Supplies"]);
    expect(out.map((e) => e.description)).toEqual(["SALLY BEAUTY 1 CARMEL IN", "AMAZON MKTPLACE"]);
  });
});

describe("typicalAmount", () => {
  it("is the median of absolute amounts", () => {
    expect(typicalAmount([-100, -300, -200])).toBe(200);
    expect(typicalAmount([-100, 300])).toBe(200);
    expect(typicalAmount([])).toBe(0);
  });
});

describe("suggestOutputSchema", () => {
  const schema = suggestOutputSchema(cats);
  it("accepts string or null ids without throwing (validation is validateSuggestions' job)", () => {
    expect(schema.safeParse({ suggestions: [{ key: "k", categoryId: "c-rent" }, { key: "j", categoryId: null }] }).success).toBe(true);
    expect(schema.safeParse({ suggestions: [{ key: "k", categoryId: "hallucinated" }] }).success).toBe(true);
    expect(schema.safeParse({ suggestions: [{ key: "k" }] }).success).toBe(false);
  });
  it("lists only the active ids for the model", () => {
    const json = JSON.stringify(z.toJSONSchema(schema));
    expect(json).toContain("c-rent");
    expect(json).not.toContain("c-old");
  });
});

describe("validateSuggestions", () => {
  const groups = [group("out|A", "out"), group("in|B", "in")];
  const ctx = { categories: cats, groups };

  it("keeps valid answers and drops nulls", () => {
    expect(
      validateSuggestions({ suggestions: [{ key: "out|A", categoryId: "c-supplies" }, { key: "in|B", categoryId: null }] }, ctx),
    ).toEqual([{ key: "out|A", categoryId: "c-supplies" }]);
  });
  it("drops unknown keys and unknown or archived ids", () => {
    expect(
      validateSuggestions(
        { suggestions: [{ key: "zzz", categoryId: "c-supplies" }, { key: "out|A", categoryId: "ghost" }, { key: "in|B", categoryId: "c-old" }] },
        ctx,
      ),
    ).toEqual([]);
  });
  it("drops kind and direction mismatches but allows transfers either way", () => {
    expect(
      validateSuggestions(
        { suggestions: [{ key: "out|A", categoryId: "c-rent" }, { key: "in|B", categoryId: "c-supplies" }] },
        ctx,
      ),
    ).toEqual([]);
    expect(
      validateSuggestions({ suggestions: [{ key: "out|A", categoryId: "c-draw" }, { key: "in|B", categoryId: "c-draw" }] }, ctx),
    ).toHaveLength(2);
  });
  it("first duplicate key wins", () => {
    expect(
      validateSuggestions({ suggestions: [{ key: "out|A", categoryId: "c-supplies" }, { key: "out|A", categoryId: "c-draw" }] }, ctx),
    ).toEqual([{ key: "out|A", categoryId: "c-supplies" }]);
  });
  it("tolerates garbage", () => {
    expect(validateSuggestions(null, ctx)).toEqual([]);
    expect(validateSuggestions({ suggestions: "x" }, ctx)).toEqual([]);
    expect(validateSuggestions({ suggestions: [null, 5, { key: 1 }, { key: "out|A" }] }, ctx)).toEqual([]);
  });
});

describe("majoritySuggestion", () => {
  it("picks the most common usable suggestion, ties to the smaller id", () => {
    expect(majoritySuggestion(["c-supplies", "c-supplies", "c-draw", null], cats, "out")).toBe("c-supplies");
    expect(majoritySuggestion(["c-supplies", "c-draw"], cats, "out")).toBe("c-draw");
  });
  it("ignores archived, unknown and wrong-direction suggestions", () => {
    expect(majoritySuggestion(["c-old", "ghost", "c-rent"], cats, "out")).toBeNull();
    expect(majoritySuggestion([null, undefined], cats, "in")).toBeNull();
    expect(majoritySuggestion(["c-rent"], cats, "in")).toBe("c-rent");
  });
});
