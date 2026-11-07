import { describe, expect, it } from "vitest";
import type { FileCategoryChoice } from "./import-categories";
import { canAcknowledgeErrors, reconcileChoices, rowsLabel, unnamedNewCount } from "./import-flow-state";

const inbox: FileCategoryChoice = { type: "inbox" };
const existing = (id: string): FileCategoryChoice => ({ type: "existing", categoryId: id });

describe("reconcileChoices (#5 P4-4)", () => {
  const groups = [{ key: "a" }, { key: "b" }];
  const cats = [{ id: "c1" }, { id: "c2" }];

  it("uses the new server defaults for groups the user never touched", () => {
    const out = reconcileChoices(groups, { a: existing("c1"), b: inbox }, { a: inbox, b: inbox }, new Set(), cats);
    expect(out).toEqual({ a: existing("c1"), b: inbox });
  });
  it("keeps a touched choice", () => {
    const out = reconcileChoices(groups, { a: existing("c1"), b: inbox }, { a: existing("c2") }, new Set(["a"]), cats);
    expect(out.a).toEqual(existing("c2"));
    expect(out.b).toEqual(inbox);
  });
  it("drops a touched existing choice whose category is gone", () => {
    const out = reconcileChoices(groups, { a: existing("c1"), b: inbox }, { a: existing("gone") }, new Set(["a"]), cats);
    expect(out.a).toEqual(existing("c1"));
  });
  it("keeps a touched new/inbox choice regardless of the category list", () => {
    const n: FileCategoryChoice = { type: "new", name: "Mine", kind: "expense" };
    const out = reconcileChoices(groups, { a: inbox, b: inbox }, { a: n, b: inbox }, new Set(["a", "b"]), []);
    expect(out).toEqual({ a: n, b: inbox });
  });
  it("only returns groups that still exist", () => {
    const out = reconcileChoices([{ key: "b" }], { b: inbox }, { a: existing("c1"), b: inbox }, new Set(["a"]), cats);
    expect(Object.keys(out)).toEqual(["b"]);
  });
});

describe("unnamedNewCount (#5 P4-6)", () => {
  const groups = [
    { key: "a", choice: { type: "new", name: "A", kind: "expense" } as FileCategoryChoice },
    { key: "b", choice: { type: "new", name: "B", kind: "expense" } as FileCategoryChoice },
    { key: "c", choice: inbox },
  ];
  it("counts blank and whitespace-only names", () => {
    const choices = {
      a: { type: "new", name: "   ", kind: "expense" } as FileCategoryChoice,
      b: { type: "new", name: "", kind: "income" } as FileCategoryChoice,
    };
    expect(unnamedNewCount(groups, choices)).toBe(2);
  });
  it("falls back to the server default when there is no edit, and ignores other types", () => {
    expect(unnamedNewCount(groups, { a: inbox })).toBe(0);
  });
});

describe("error copy (#5)", () => {
  it("pluralizes rows", () => {
    expect(rowsLabel(1)).toBe("1 row");
    expect(rowsLabel(0)).toBe("0 rows");
    expect(rowsLabel(2)).toBe("2 rows");
  });
  it("offers the acknowledgment only when there is something to import", () => {
    expect(canAcknowledgeErrors(1, 0)).toBe(false);
    expect(canAcknowledgeErrors(0, 5)).toBe(false);
    expect(canAcknowledgeErrors(2, 5)).toBe(true);
  });
});
