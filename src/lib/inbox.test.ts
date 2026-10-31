import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchRule } from "./categorize";
import { chunk, groupInbox, type InboxRow } from "./inbox";

const truth = JSON.parse(readFileSync("fixtures/bmo-fake-12mo-split.truth.json", "utf8")) as {
  rows: { date: string; amountCents: number; description: string; memo: string }[];
};
const fixtureRows: InboxRow[] = truth.rows.map((r, i) => ({
  id: `id-${i}`,
  date: r.date,
  amountCents: r.amountCents,
  description: r.memo ? `${r.description} ${r.memo}` : r.description,
}));

const row = (id: string, description: string, amountCents: number): InboxRow => ({
  id,
  date: "2026-01-01",
  amountCents,
  description,
});

describe("groupInbox", () => {
  it("groups by direction and pattern; singles and empty patterns are one-offs", () => {
    const { groups, oneOffs } = groupInbox([
      row("a", "COSMOPROF 1186 INDPLS IN", -1000),
      row("b", "COSMOPROF 2201 INDPLS IN", -2000),
      row("c", "COSMOPROF REFUND", 500),
      row("d", "X1 12", -300),
      row("e", "ONLY ONCE LLC", -300),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ direction: "out", ids: ["a", "b"], count: 2, totalCents: -3000 });
    expect(oneOffs.map((r) => r.id).sort()).toEqual(["c", "d", "e"]);
  });

  it("sorts by count desc, then absolute total desc", () => {
    const { groups } = groupInbox([
      row("1", "ALPHA STORE", -100),
      row("2", "ALPHA STORE", -100),
      row("3", "BRAVO STORE", -5000),
      row("4", "BRAVO STORE", -5000),
      row("5", "CHARLIE STORE", -1),
      row("6", "CHARLIE STORE", -1),
      row("7", "CHARLIE STORE", -1),
    ]);
    expect(groups.map((g) => g.pattern)).toEqual(["CHARLIE STORE", "BRAVO STORE", "ALPHA STORE"]);
  });

  it("partitions the fixture and every group's pattern matches every member", () => {
    const { groups, oneOffs } = groupInbox(fixtureRows);
    expect(groups.reduce((n, g) => n + g.count, 0) + oneOffs.length).toBe(fixtureRows.length);
    expect(groups.length).toBeGreaterThan(5);
    for (const g of groups) {
      const rule = { id: "r", pattern: g.pattern, categoryId: "c", direction: g.direction, priority: 0 };
      expect(g.ids).toHaveLength(g.count);
      for (const r of g.rows) expect(matchRule(r, [rule])).not.toBeNull();
    }
    for (let i = 1; i < groups.length; i++) {
      const [p, c] = [groups[i - 1], groups[i]];
      expect(p.count > c.count || (p.count === c.count && Math.abs(p.totalCents) >= Math.abs(c.totalCents))).toBe(true);
    }
  });
});

describe("chunk", () => {
  it("slices into pieces of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
