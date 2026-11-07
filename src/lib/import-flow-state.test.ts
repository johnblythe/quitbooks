import { describe, expect, it } from "vitest";
import type { FileCategoryChoice } from "./import-categories";
import { canAcknowledgeErrors, effectiveChoice, reconcileChoices, rowsLabel, unnamedNewCount, wasWere } from "./import-flow-state";

const inbox: FileCategoryChoice = { type: "inbox" };
const existing = (id: string): FileCategoryChoice => ({ type: "existing", categoryId: id });
/** A group whose rows are all money out (`out` > 0) or all money in. */
const grp = (key: string, out = 1, value = "Supplies") => ({ key, value, inCount: out ? 0 : 1, outCount: out, netCents: out ? -100 : 100 });

describe("reconcileChoices (#5 P4-4)", () => {
  const groups = [grp("a"), grp("b")];
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
    const out = reconcileChoices([grp("b")], { b: inbox }, { a: existing("c1"), b: inbox }, new Set(["a"]), cats);
    expect(Object.keys(out)).toEqual(["b"]);
  });
});

describe("reconcileChoices kind re-guess (#10 R6-6)", () => {
  // After "money out as positive" is ticked, the same rows read as money in.
  const flipped = [grp("a", 0)];
  const mine = (kind: "income" | "expense"): FileCategoryChoice => ({ type: "new", name: "My Name", kind });

  it("re-guesses the kind of a touched Create new when the user never picked a kind, keeping their name", () => {
    const out = reconcileChoices(flipped, { a: { type: "new", name: "Original", kind: "income" } }, { a: mine("expense") }, new Set(["a"]), []);
    expect(out.a).toEqual(mine("income"));
  });
  it("re-guesses it even when the new default isn't a Create new", () => {
    expect(reconcileChoices(flipped, { a: inbox }, { a: mine("expense") }, new Set(["a"]), []).a).toEqual(mine("income"));
    const out = reconcileChoices(flipped, { a: existing("c1") }, { a: mine("expense") }, new Set(["a"]), [{ id: "c1" }]);
    expect(out.a).toEqual(mine("income"));
  });
  it("keeps a kind the user picked", () => {
    const out = reconcileChoices(
      flipped,
      { a: { type: "new", name: "Original", kind: "income" } },
      { a: mine("expense") },
      new Set(["a"]),
      [],
      new Set(["a"]),
    );
    expect(out.a).toEqual(mine("expense"));
  });
  it("guesses a transfer from the file's value, as the first guess does", () => {
    const out = reconcileChoices([grp("a", 1, "Owner's Draw")], { a: inbox }, { a: mine("expense") }, new Set(["a"]), []);
    expect(out.a).toEqual({ ...mine("expense"), kind: "transfer" });
  });
});

describe("wasWere", () => {
  it("agrees with the count", () => {
    expect(wasWere(1)).toBe("was");
    expect(wasWere(0)).toBe("were");
    expect(wasWere(2)).toBe("were");
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

describe("effectiveChoice (R6-1)", () => {
  const cats = [{ id: "c1" }];
  it("falls back to the server default when the picked category is gone", () => {
    expect(effectiveChoice(existing("gone"), inbox, cats)).toEqual(inbox);
    expect(effectiveChoice(existing("gone"), existing("c1"), cats)).toEqual(existing("c1"));
  });
  it("keeps a valid pick, other choice types, and uses the default when there is none", () => {
    expect(effectiveChoice(existing("c1"), inbox, cats)).toEqual(existing("c1"));
    const n: FileCategoryChoice = { type: "new", name: "X", kind: "expense" };
    expect(effectiveChoice(n, inbox, [])).toEqual(n);
    expect(effectiveChoice(undefined, inbox, cats)).toEqual(inbox);
  });
  it("unnamedNewCount uses the effective choice", () => {
    const g = [{ key: "a", choice: { type: "new", name: "", kind: "expense" } as FileCategoryChoice }];
    expect(unnamedNewCount(g, { a: existing("gone") }, cats)).toBe(1);
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
