import { describe, expect, it } from "vitest";
import { daysBetween, matchManualEntries, type ManualCandidate } from "./import-match";

const cand = (id: string, date: string, amountCents: number, description = id): ManualCandidate => ({
  id,
  date,
  amountCents,
  description,
});

describe("daysBetween", () => {
  it("counts across month and year boundaries", () => {
    expect(daysBetween("2026-10-01", "2026-09-30")).toBe(1);
    expect(daysBetween("2026-01-01", "2025-12-30")).toBe(2);
    expect(daysBetween("2026-03-01", "2026-02-27")).toBe(2);
    expect(daysBetween("2026-10-01", "2026-10-04")).toBe(-3);
  });
});

describe("matchManualEntries", () => {
  it("matches same amount within 3 days", () => {
    const m = matchManualEntries(
      [{ line: 2, date: "2026-10-01", amountCents: 25000 }],
      [cand("a", "2026-10-03", 25000, "Jane rent")],
    );
    expect(m.get(2)?.candidate.id).toBe("a");
  });

  it("does not match a different amount or a date 4 days away", () => {
    const m = matchManualEntries(
      [
        { line: 2, date: "2026-10-01", amountCents: 25000 },
        { line: 3, date: "2026-10-01", amountCents: 25001 },
      ],
      [cand("a", "2026-10-05", 25000), cand("b", "2026-10-01", 25000 + 2)],
    );
    expect(m.size).toBe(0);
  });

  it("does not match the opposite sign", () => {
    const m = matchManualEntries(
      [{ line: 2, date: "2026-10-01", amountCents: -4500 }],
      [cand("a", "2026-10-01", 4500)],
    );
    expect(m.size).toBe(0);
  });

  it("is one-to-one: two identical CSV rows and one manual entry link only one", () => {
    const m = matchManualEntries(
      [
        { line: 2, date: "2026-10-01", amountCents: 25000 },
        { line: 3, date: "2026-10-01", amountCents: 25000 },
      ],
      [cand("a", "2026-10-01", 25000)],
    );
    expect([...m.keys()]).toEqual([2]);
  });

  it("is one-to-one the other way: one CSV row claims only one of two entries", () => {
    const m = matchManualEntries(
      [{ line: 2, date: "2026-10-01", amountCents: 25000 }],
      [cand("a", "2026-10-02", 25000), cand("b", "2026-10-01", 25000)],
    );
    expect(m.size).toBe(1);
    expect(m.get(2)?.candidate.id).toBe("b");
  });

  it("assigns the closest dates first, even if that means a later row wins", () => {
    // Entry "a" is 1 day from line 2 but 0 days from line 3; line 3 should get it, line 2 gets "b".
    const m = matchManualEntries(
      [
        { line: 2, date: "2026-10-01", amountCents: 100 },
        { line: 3, date: "2026-10-02", amountCents: 100 },
      ],
      [cand("a", "2026-10-02", 100), cand("b", "2026-10-04", 100)],
    );
    expect(m.get(3)?.candidate.id).toBe("a");
    expect(m.get(2)?.candidate.id).toBe("b");
  });

  it("is deterministic regardless of input order", () => {
    const rows = [
      { line: 2, date: "2026-10-01", amountCents: 100 },
      { line: 3, date: "2026-10-01", amountCents: 100 },
    ];
    const cands = [cand("x", "2026-10-01", 100), cand("y", "2026-10-01", 100)];
    const a = matchManualEntries(rows, cands);
    const b = matchManualEntries([...rows].reverse(), [...cands].reverse());
    expect([...a].map(([l, v]) => [l, v.candidate.id])).toEqual([...b].map(([l, v]) => [l, v.candidate.id]));
  });
});
