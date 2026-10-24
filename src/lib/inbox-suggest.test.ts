import { describe, expect, it } from "vitest";
import {
  applyOutcome,
  markPending,
  pickerValue,
  planChunks,
  progressOf,
  seedSuggestions,
  type SuggestItem,
} from "./inbox-suggest";

const item = (key: string, over: Partial<SuggestItem> = {}): SuggestItem => ({
  key,
  ids: [key],
  categoryId: null,
  needsAsking: true,
  ...over,
});

describe("planChunks", () => {
  it("keeps display order, first chunk 4 then 6", () => {
    const keys = Array.from({ length: 17 }, (_, i) => `k${i}`);
    const plan = planChunks(keys);
    expect(plan.map((c) => c.length)).toEqual([4, 6, 6, 1]);
    expect(plan.flat()).toEqual(keys);
  });
  it("handles short and empty lists", () => {
    expect(planChunks([])).toEqual([]);
    expect(planChunks(["a", "b"])).toEqual([["a", "b"]]);
    expect(planChunks(["a", "b", "c", "d"])).toEqual([["a", "b", "c", "d"]]);
  });
});

describe("seed and apply", () => {
  it("seeds asked items as done and the rest as pending", () => {
    const m = seedSuggestions([
      item("a"),
      item("b", { needsAsking: false, categoryId: "c1" }),
      item("c", { needsAsking: false }),
    ]);
    expect(m).toEqual({
      a: { status: "pending", categoryId: null },
      b: { status: "done", categoryId: "c1" },
      c: { status: "done", categoryId: null },
    });
  });
  it("applies results by key, null answers and missing keys become done/none", () => {
    const m = seedSuggestions([item("a"), item("b"), item("c")]);
    const next = applyOutcome(m, ["a", "b", "c"], {
      results: { a: { categoryId: "x" }, b: { categoryId: null } },
    });
    expect(next).toEqual({
      a: { status: "done", categoryId: "x" },
      b: { status: "done", categoryId: null },
      c: { status: "done", categoryId: null },
    });
    expect(m.a.status).toBe("pending"); // input not mutated
  });
  it("marks only the chunk's keys as error, then retry goes back to pending", () => {
    const m = seedSuggestions([item("a"), item("b")]);
    const failed = applyOutcome(m, ["a"], { error: "api_error_429" });
    expect(failed.a.status).toBe("error");
    expect(failed.b.status).toBe("pending");
    expect(markPending(failed, ["a"]).a).toEqual({
      status: "pending",
      categoryId: null,
    });
  });
});

describe("progressOf", () => {
  it("counts settled, pending and errors", () => {
    const m = applyOutcome(seedSuggestions([item("a"), item("b"), item("c")]), ["a", "b"], { error: "x" });
    expect(progressOf(m, ["a", "b", "c"])).toEqual({
      settled: 2,
      total: 3,
      errors: 2,
      pending: 1,
    });
  });
});

describe("pickerValue", () => {
  it("prefers the user's pick, never overridden by a later suggestion", () => {
    expect(pickerValue(null, null)).toBe("");
    expect(pickerValue(null, "s1")).toBe("s1");
    expect(pickerValue("mine", "s1")).toBe("mine");
    expect(pickerValue("mine", undefined)).toBe("mine");
  });
});
