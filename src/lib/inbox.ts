import { suggestPattern } from "./categorize";

/**
 * Groups Inbox rows by merchant so a whole vendor can be sorted in one tap.
 * Pure: the same inputs always give the same groups.
 */

/** Max rows the grouped Inbox loads at once, so also the most ids one Inbox group can hold. */
export const INBOX_LIMIT = 2000;

export type InboxRow = { id: string; date: string; amountCents: number; description: string };

export type InboxGroup<T extends InboxRow = InboxRow> = {
  /** `${direction}|${pattern}` */
  key: string;
  pattern: string;
  direction: "in" | "out";
  ids: string[];
  count: number;
  totalCents: number;
  rows: T[];
};

export function groupInbox<T extends InboxRow>(rows: T[]): { groups: InboxGroup<T>[]; oneOffs: T[] } {
  const map = new Map<string, InboxGroup<T>>();
  const oneOffs: T[] = [];
  for (const row of rows) {
    const pattern = suggestPattern(row.description);
    if (!pattern) {
      oneOffs.push(row);
      continue;
    }
    const direction = row.amountCents > 0 ? "in" : "out";
    const key = `${direction}|${pattern}`;
    let g = map.get(key);
    if (!g) {
      g = { key, pattern, direction, ids: [], count: 0, totalCents: 0, rows: [] };
      map.set(key, g);
    }
    g.ids.push(row.id);
    g.rows.push(row);
    g.count++;
    g.totalCents += row.amountCents;
  }

  const groups: InboxGroup<T>[] = [];
  for (const g of map.values()) {
    if (g.count < 2) oneOffs.push(g.rows[0]);
    else groups.push(g);
  }
  groups.sort(
    (a, b) => b.count - a.count || Math.abs(b.totalCents) - Math.abs(a.totalCents) || (a.key < b.key ? -1 : 1),
  );
  return { groups, oneOffs };
}

/** Splits a list into slices of at most `size` (keeps `inArray` parameter lists small). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
