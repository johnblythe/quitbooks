import { describe, expect, it } from "vitest";
import {
  categoryKey,
  defaultChoice,
  defaultChoices,
  guessKind,
  isPlaceholderCategory,
  looksLikeTransfer,
  resolveRowCategory,
  summarizeFileCategories,
  type CategoryOption,
} from "./import-categories";

const cats: CategoryOption[] = [
  { id: "c-booth", name: "Booth Rent", kind: "income" },
  { id: "c-supplies", name: "Supplies", kind: "expense" },
  { id: "c-old", name: "Old Thing", kind: "expense", archived: true },
];

function group(value: string, amounts: number[]) {
  return summarizeFileCategories(amounts.map((a) => ({ category: value, amountCents: a })))[0];
}

describe("summarizeFileCategories", () => {
  it("counts rows and nets amounts per distinct value, ignoring case, spacing and blanks", () => {
    const g = summarizeFileCategories([
      { category: "Supplies", amountCents: -1000 },
      { category: "  supplies ", amountCents: -500 },
      { category: "Booth  Rent", amountCents: 35000 },
      { category: "", amountCents: -100 },
    ]);
    expect(g.map((x) => [x.key, x.value, x.count, x.netCents])).toEqual([
      ["supplies", "Supplies", 2, -1500],
      ["booth rent", "Booth Rent", 1, 35000],
    ]);
  });
});

describe("placeholders and kinds", () => {
  it.each(["-Split-", "--Split--", "Uncategorized Income", "uncategorized expense", "Uncategorized Asset", "Ask My Accountant", "", "  "])(
    "%j is a QuickBooks placeholder",
    (v) => expect(isPlaceholderCategory(v)).toBe(true),
  );
  it("does not treat real categories as placeholders", () => {
    expect(isPlaceholderCategory("Supplies")).toBe(false);
    expect(isPlaceholderCategory("Splitting Hairs Supplies")).toBe(false);
  });

  it.each(["Owner's Draw", "Owner Contribution", "Member Equity", "Distributions", "Transfer to Savings"])(
    "%s looks like owner equity",
    (v) => expect(looksLikeTransfer(v)).toBe(true),
  );

  it("guesses transfer for equity names regardless of sign", () => {
    expect(guessKind(group("Owner's Draw", [-50000]))).toBe("transfer");
  });
  it("guesses income when most rows are money in, expense when most are out", () => {
    expect(guessKind(group("Retail Sales", [100, 200, -50]))).toBe("income");
    expect(guessKind(group("Plumber", [-100, -200, 50]))).toBe("expense");
  });
  it("falls back to the net sign on a tie", () => {
    expect(guessKind(group("Mixed", [1000, -200]))).toBe("income");
    expect(guessKind(group("Mixed", [200, -1000]))).toBe("expense");
  });
});

describe("defaultChoice", () => {
  it("matches an existing category by name, ignoring case", () => {
    expect(defaultChoice(group("booth rent", [100]), cats)).toEqual({ type: "existing", categoryId: "c-booth" });
  });
  it("sends placeholders to the Inbox", () => {
    expect(defaultChoice(group("-Split-", [-100]), cats)).toEqual({ type: "inbox" });
    expect(defaultChoice(group("Uncategorized Income", [100]), cats)).toEqual({ type: "inbox" });
  });
  it("proposes a new category of the guessed kind for anything else", () => {
    expect(defaultChoice(group("Retail Sales", [100]), cats)).toEqual({ type: "new", name: "Retail Sales", kind: "income" });
    expect(defaultChoice(group("Owner's Draw", [-100]), cats)).toEqual({ type: "new", name: "Owner's Draw", kind: "transfer" });
  });
  it("does not match an archived category by name", () => {
    expect(defaultChoice(group("Old Thing", [-100]), cats).type).toBe("new");
  });
  it("prefers what was remembered, when that category still exists", () => {
    const g = group("Retail Sales", [100]);
    expect(defaultChoice(g, cats, { [g.key]: { type: "existing", categoryId: "c-supplies" } })).toEqual({
      type: "existing",
      categoryId: "c-supplies",
    });
    expect(defaultChoice(g, cats, { [g.key]: { type: "inbox" } })).toEqual({ type: "inbox" });
    // A remembered category that has since been deleted falls back to the normal defaults.
    expect(defaultChoice(g, cats, { [g.key]: { type: "existing", categoryId: "gone" } }).type).toBe("new");
  });
  it("builds a choice per group, keyed like the groups", () => {
    const groups = summarizeFileCategories([
      { category: "Supplies", amountCents: -1 },
      { category: "-Split-", amountCents: -1 },
    ]);
    expect(Object.keys(defaultChoices(groups, cats)).sort()).toEqual([categoryKey("-Split-"), "supplies"].sort());
  });
});

describe("resolveRowCategory", () => {
  const auto = { categoryId: "c-rule", stylistId: null };
  it("keeps the automatic result when the file has no category for the row", () => {
    expect(resolveRowCategory(undefined, auto, "c-booth")).toEqual(auto);
  });
  it("lets the file's category beat a rule", () => {
    expect(resolveRowCategory("c-supplies", auto, "c-booth")).toEqual({ categoryId: "c-supplies", stylistId: null });
  });
  it("drops a stylist match when the file picks something other than Booth Rent", () => {
    expect(resolveRowCategory("c-supplies", { categoryId: "c-booth", stylistId: "s1" }, "c-booth")).toEqual({
      categoryId: "c-supplies",
      stylistId: null,
    });
  });
  it("keeps the stylist for Booth Rent", () => {
    expect(resolveRowCategory("c-booth", { categoryId: "c-booth", stylistId: "s1" }, "c-booth")).toEqual({
      categoryId: "c-booth",
      stylistId: "s1",
    });
  });
  it("sends Booth Rent without a stylist to the Inbox", () => {
    expect(resolveRowCategory("c-booth", auto, "c-booth")).toEqual({ categoryId: null, stylistId: null });
  });
});
