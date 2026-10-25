import { describe, expect, it } from "vitest";
import { coveredNote, csvOverlapMessage, feedCoverageStart, needsFullSync, splitByCutover } from "./bank-cutover";

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

describe("feedCoverageStart", () => {
  it("is off with no live feed and no feed rows", () => expect(feedCoverageStart(null, null)).toBeNull());
  it("still covers feed rows after a disconnect", () => expect(feedCoverageStart(null, "2026-09-01")).toBe("2026-09-01"));
  it("is the start date when feed rows begin there or later", () => {
    expect(feedCoverageStart("2026-10-01", null)).toBe("2026-10-01");
    expect(feedCoverageStart("2026-10-01", "2026-10-03")).toBe("2026-10-01");
  });
  it("goes back to the earliest feed row after the start date moved later", () => {
    expect(feedCoverageStart("2026-10-15", "2026-10-01")).toBe("2026-10-01");
  });
});

describe("csvOverlapMessage", () => {
  it("allows a start date after the last CSV row, or no CSV at all", () => {
    expect(csvOverlapMessage("2026-11-01", "2026-10-31")).toBeNull();
    expect(csvOverlapMessage("2026-01-01", null)).toBeNull();
  });
  it("rejects a start date on or before the last CSV row, naming both dates", () => {
    const msg = "Your imported CSV goes through Oct 31, 2026. Start the feed on Nov 1, 2026 or later.";
    expect(csvOverlapMessage("2026-10-31", "2026-10-31")).toBe(msg);
    expect(csvOverlapMessage("2026-09-15", "2026-10-31")).toBe(msg);
  });
});

describe("needsFullSync", () => {
  const before = { cutover: "2026-10-01", included: ["a"] };
  it("is false for the same or a later start date with the same accounts", () => {
    expect(needsFullSync(before, { cutover: "2026-10-01", included: ["a"] })).toBe(false);
    expect(needsFullSync(before, { cutover: "2026-10-10", included: ["a"] })).toBe(false);
  });
  it("is false when only removing an account", () => expect(needsFullSync({ ...before, included: ["a", "b"] }, before)).toBe(false));
  it("is true for an earlier start date", () => expect(needsFullSync(before, { cutover: "2026-09-30", included: ["a"] })).toBe(true));
  it("is true for a newly included account", () => expect(needsFullSync(before, { cutover: "2026-10-01", included: ["a", "b"] })).toBe(true));
});
