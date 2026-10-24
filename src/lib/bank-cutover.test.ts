import { describe, expect, it } from "vitest";
import { coveredNote, splitByCutover } from "./bank-cutover";

describe("splitByCutover", () => {
  const rows = [{ date: "2026-09-30" }, { date: "2026-10-01" }, { date: "2026-10-05" }];
  it("keeps everything with no live feed", () => expect(splitByCutover(rows, null)).toEqual({ kept: rows, covered: [] }));
  it("covers rows on/after the cutover", () => {
    const r = splitByCutover(rows, "2026-10-01");
    expect(r.kept).toEqual([{ date: "2026-09-30" }]);
    expect(r.covered).toHaveLength(2);
  });
  it("words the note", () => {
    expect(coveredNote(1)).toBe("1 row is covered by your bank feed and was skipped.");
    expect(coveredNote(3)).toBe("3 rows are covered by your bank feed and were skipped.");
  });
});
