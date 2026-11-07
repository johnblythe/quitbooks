import { describe, expect, it } from "vitest";
import { categoryChoicesSchema } from "./import-schema";

const id = "6f1b1c0e-8a53-4c47-9d5c-2f3d1d0a1b2c";
const ok = (v: unknown) => categoryChoicesSchema.safeParse(v).success;

describe("categoryChoicesSchema (#5)", () => {
  it("accepts existing, new and inbox choices, and an empty object", () => {
    expect(
      ok({
        supplies: { type: "existing", categoryId: id },
        "chair rental": { type: "new", name: "Booth Rent 2", kind: "income" },
        "ask my accountant": { type: "inbox" },
      }),
    ).toBe(true);
    expect(ok({})).toBe(true);
  });
  it("trims a new name and rejects a blank or whitespace-only one", () => {
    const parsed = categoryChoicesSchema.parse({ a: { type: "new", name: "  Tips  ", kind: "income" } });
    expect(parsed.a).toEqual({ type: "new", name: "Tips", kind: "income" });
    expect(ok({ a: { type: "new", name: "", kind: "income" } })).toBe(false);
    expect(ok({ a: { type: "new", name: "   ", kind: "income" } })).toBe(false);
  });
  it("rejects an unknown type", () => {
    expect(ok({ a: { type: "delete" } })).toBe(false);
    expect(ok({ a: {} })).toBe(false);
  });
  it("rejects a bad kind and a non-uuid category id", () => {
    expect(ok({ a: { type: "new", name: "X", kind: "asset" } })).toBe(false);
    expect(ok({ a: { type: "new", name: "X" } })).toBe(false);
    expect(ok({ a: { type: "existing", categoryId: "nope" } })).toBe(false);
  });
  it("rejects oversized input: a 61-char name and a 301-char key", () => {
    expect(ok({ a: { type: "new", name: "x".repeat(61), kind: "expense" } })).toBe(false);
    expect(ok({ a: { type: "new", name: "x".repeat(60), kind: "expense" } })).toBe(true);
    expect(ok({ ["k".repeat(301)]: { type: "inbox" } })).toBe(false);
    expect(ok({ ["k".repeat(300)]: { type: "inbox" } })).toBe(true);
  });
});
