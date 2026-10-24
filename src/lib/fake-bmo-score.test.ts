import { describe, expect, it } from "vitest";
import { generateFakeBmo } from "./fake-bmo";
import { formatScoreReport, scoreFakeBmo } from "./fake-bmo-score";

describe("scoreFakeBmo", () => {
  const { csv, truth } = generateFakeBmo({ months: 12, endMonth: "2026-09", seed: 42 });

  it("accounts for every row exactly once", () => {
    const r = scoreFakeBmo(csv, truth);
    expect(r.parseErrors).toEqual([]);
    expect(r.misaligned).toBe(0);
    expect(r.correct + r.wrong.length + r.uncategorized.length).toBe(truth.rows.length);
    expect(r.correct).toBeGreaterThan(0);
  });

  it("is identical for every file shape", () => {
    const a = scoreFakeBmo(csv, truth);
    const other = generateFakeBmo({ months: 12, endMonth: "2026-09", seed: 42, format: "split", zelleSender: "memo", order: "oldest", preamble: false });
    const b = scoreFakeBmo(other.csv, other.truth);
    expect(b.correct).toBe(a.correct);
    expect(b.wrong.length).toBe(a.wrong.length);
    expect(b.uncategorized.length).toBe(a.uncategorized.length);
  });

  it("flags the known substring-match trap and tags it", () => {
    const r = scoreFakeBmo(csv, truth);
    const annual = r.wrong.find((w) => w.trap === "name-substring-annual");
    expect(annual?.gotStylist).toBe("Ann");
    expect(formatScoreReport(r)).toContain("[trap: name-substring-annual]");
  });

  it("reports misalignment when the truth doesn't match the file", () => {
    const r = scoreFakeBmo(csv, { ...truth, rows: truth.rows.slice(1) });
    expect(r.misaligned).toBeGreaterThan(0);
  });
});
