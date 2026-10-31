import { describe, expect, it } from "vitest";
import { addEditorLine, initialEditorLines, resolveEditor, setEditorAmount, toggleEditorDir, typedCents } from "./split-editor";

const usable = new Set(["booth", "sales", "fees"]);

describe("split editor", () => {
  it("opens with the current category and full amount, plus an auto line, so a 2-way split is one edit", () => {
    let lines = initialEditorLines({ amountCents: 50000, categoryId: "booth", stylistId: "jane" }, [], usable);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ categoryId: "booth", stylistId: "jane", amountText: "500.00", dir: 1, auto: false });
    expect(lines[1]).toMatchObject({ categoryId: "", auto: true });

    let r = resolveEditor(50000, lines, "booth");
    expect(r.left).toBe(0);
    expect(r.lines[1].cents).toBeNull(); // nothing left yet

    lines = setEditorAmount(lines, lines[0].key, "250");
    r = resolveEditor(50000, lines, "booth");
    expect(r.lines[1]).toMatchObject({ cents: 25000, shownText: "250.00", shownDir: 1 });
    expect(r.left).toBe(0);
  });

  it("doesn't prefill a category that can't be used (archived) or a stylist without it", () => {
    const lines = initialEditorLines({ amountCents: -5000, categoryId: "old", stylistId: "jane" }, [], usable);
    expect(lines[0]).toMatchObject({ categoryId: "", stylistId: "", amountText: "50.00", dir: -1 });
  });

  it("handles a net deposit: the auto line flips sign for the fee", () => {
    let lines = initialEditorLines({ amountCents: 10000, categoryId: null, stylistId: null }, [], usable);
    lines = setEditorAmount(lines, lines[0].key, "103.00");
    const r = resolveEditor(10000, lines, "booth");
    expect(r.lines[1]).toMatchObject({ cents: -300, shownText: "3.00", shownDir: -1 });
    expect(r.payload.map((p) => p.amountCents)).toEqual([10300, -300]);
  });

  it("typing in the auto line makes it ordinary, and Left to assign then shows the gap", () => {
    let lines = initialEditorLines({ amountCents: 10000, categoryId: "sales", stylistId: null }, [], usable);
    lines = setEditorAmount(lines, lines[0].key, "60");
    lines = setEditorAmount(lines, lines[1].key, "30");
    const r = resolveEditor(10000, lines, "booth");
    expect(r.lines[1].auto).toBe(false);
    expect(r.left).toBe(1000);
  });

  it("Add line: becomes the auto line only when none is filling what's left", () => {
    let lines = initialEditorLines({ amountCents: 75000, categoryId: "booth", stylistId: "a" }, [], usable);
    lines = addEditorLine(lines, 75000);
    expect(lines[2].auto).toBe(false); // line 2 is already auto
    lines = setEditorAmount(lines, lines[0].key, "250");
    lines = setEditorAmount(lines, lines[2].key, "250");
    let r = resolveEditor(75000, lines, "booth");
    expect(r.lines[1].cents).toBe(25000);

    lines = setEditorAmount(lines, lines[1].key, "200");
    lines = addEditorLine(lines, 75000);
    expect(lines[3].auto).toBe(true);
    r = resolveEditor(75000, lines, "booth");
    expect(r.lines[3].cents).toBe(5000);
    expect(r.left).toBe(0);
  });

  it("loads an existing split as ordinary lines", () => {
    const lines = initialEditorLines(
      { amountCents: 10000, categoryId: null, stylistId: null },
      [
        { categoryId: "sales", stylistId: null, amountCents: 10300, memo: "Sales" },
        { categoryId: "fees", stylistId: null, amountCents: -300, memo: null },
      ],
      usable,
    );
    expect(lines.map((l) => [l.categoryId, l.amountText, l.dir, l.memo, l.auto])).toEqual([
      ["sales", "103.00", 1, "Sales", false],
      ["fees", "3.00", -1, "", false],
    ]);
    expect(resolveEditor(10000, lines, null).left).toBe(0);
  });

  it("toggling direction on the auto line freezes the shown amount, then flips it", () => {
    let lines = initialEditorLines({ amountCents: 10000, categoryId: null, stylistId: null }, [], usable);
    lines = setEditorAmount(lines, lines[0].key, "60");
    lines = toggleEditorDir(lines, lines[1].key, 10000, null);
    expect(lines[1]).toMatchObject({ auto: false, amountText: "40.00", dir: -1 });
    expect(resolveEditor(10000, lines, null).left).toBe(8000);
  });

  it("only Booth Rent lines send a stylist, and memos are trimmed", () => {
    const lines = initialEditorLines({ amountCents: 10000, categoryId: "sales", stylistId: null }, [], usable).map((l, i) =>
      i === 0 ? { ...l, stylistId: "jane", memo: "  hi " } : { ...l, categoryId: "booth", stylistId: "kim" },
    );
    const r = resolveEditor(10000, setEditorAmount(lines, lines[0].key, "40"), "booth");
    expect(r.payload).toEqual([
      { categoryId: "sales", stylistId: null, amountCents: 4000, memo: "hi" },
      { categoryId: "booth", stylistId: "kim", amountCents: 6000, memo: null },
    ]);
  });

  it("typedCents ignores blanks, junk and zero, and applies the direction", () => {
    expect(typedCents({ amountText: "", dir: 1 })).toBeNull();
    expect(typedCents({ amountText: "abc", dir: 1 })).toBeNull();
    expect(typedCents({ amountText: "0.00", dir: 1 })).toBeNull();
    expect(typedCents({ amountText: "$1,234.56", dir: -1 })).toBe(-123456);
    expect(typedCents({ amountText: "-5", dir: 1 })).toBe(500);
  });
});
