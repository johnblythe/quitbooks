import "server-only";
import { and, count, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { addStylistTerm, matchRule, norm } from "./categorize";
import { makeCategorizer } from "./categorizer";
import { getBoothRentCategoryId } from "./data";
import { chunk } from "./inbox";
import { inInbox } from "./inbox-where";

/**
 * Server-only rule helpers shared by the Inbox and Settings actions. These live outside the
 * "use server" files on purpose: exports from those become public endpoints.
 */

const { transactions, rules, stylists } = schema;

/** `inArray` lists stay at or below this many ids per query. */
export const IN_ARRAY_CHUNK = 1000;

/**
 * Re-runs stylist matching and rules over everything still in the Inbox (split rows are never
 * touched). Returns how many were sorted. `db` is injectable for tests.
 */
export async function applyRules(db?: Db): Promise<number> {
  db ??= await getDb();
  const categorizer = await makeCategorizer(db);
  const open = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      description: transactions.description,
    })
    .from(transactions)
    .where(inInbox());

  // Group updates by (category, stylist) so it's a handful of queries, not one per row.
  const groups = new Map<string, { categoryId: string; stylistId: string | null; ids: string[] }>();
  for (const tx of open) {
    const r = categorizer(tx);
    if (!r.categoryId) continue;
    const key = `${r.categoryId}|${r.stylistId ?? ""}`;
    const g = groups.get(key) ?? { categoryId: r.categoryId, stylistId: r.stylistId, ids: [] };
    g.ids.push(tx.id);
    groups.set(key, g);
  }
  let total = 0;
  for (const g of groups.values()) {
    for (const ids of chunk(g.ids, IN_ARRAY_CHUNK)) {
      await db
        .update(transactions)
        .set({ categoryId: g.categoryId, stylistId: g.stylistId, updatedAt: new Date() })
        .where(and(inArray(transactions.id, ids), inInbox()));
    }
    total += g.ids.length;
  }
  return total;
}

type Sample = { date: string; amountCents: number; description: string };

/**
 * "Remember" after categorizing. Skipped unless the pattern really matches at least one of the
 * sample transactions (same semantics as rules). Booth Rent + a stylist teaches the stylist's
 * match text; anything else becomes a rule. Returns true if something was saved.
 */
export async function rememberPattern(input: {
  pattern: string;
  categoryId: string;
  stylistId: string | null;
  direction: "any" | "in" | "out";
  samples: Sample[];
}): Promise<boolean> {
  const { pattern, categoryId, stylistId, direction, samples } = input;
  if (pattern.length < 3) return false;
  const probe = [{ id: "self", pattern, categoryId, direction, priority: 0 }];
  if (!samples.some((tx) => matchRule(tx, probe) !== null)) return false;

  const db = await getDb();
  const boothRentId = await getBoothRentCategoryId();
  if (stylistId && boothRentId && categoryId === boothRentId) {
    // Booth rent: teach the stylist's match text instead of creating a rule.
    const [st] = await db.select().from(stylists).where(eq(stylists.id, stylistId));
    const matchText = st ? addStylistTerm(st, pattern) : null;
    if (matchText) await db.update(stylists).set({ matchText }).where(eq(stylists.id, stylistId));
  } else {
    await db.insert(rules).values({ pattern, categoryId, direction });
  }
  return true;
}

export type RuleTestResult = {
  /** Total transactions (any category) the pattern would match. */
  matches: number;
  /** Of those, how many are still in the Inbox. */
  inbox: number;
  samples: { date: string; amountCents: number; description: string }[];
};

/**
 * Counts what a rule would match, with the same semantics as `matchRule`: both sides uppercased
 * with whitespace collapsed, plain substring (position, not LIKE, so no wildcard escaping).
 */
export async function testRuleMatches(
  rawPattern: string,
  direction: "any" | "in" | "out",
  db?: Db,
): Promise<RuleTestResult> {
  const pattern = norm(rawPattern);
  if (pattern.length < 3) return { matches: 0, inbox: 0, samples: [] };
  db ??= await getDb();
  const normalized = sql`btrim(upper(regexp_replace(${transactions.description}, '\\s+', ' ', 'g')))`;
  const where = and(
    sql`position(${pattern} in ${normalized}) > 0`,
    direction === "in" ? gt(transactions.amountCents, 0) : direction === "out" ? lt(transactions.amountCents, 0) : undefined,
  );
  const [totals] = await db
    .select({
      matches: count(),
      inbox: sql<number>`count(*) filter (where ${inInbox()})::int`,
    })
    .from(transactions)
    .where(where);
  const samples = await db
    .select({ date: transactions.date, amountCents: transactions.amountCents, description: transactions.description })
    .from(transactions)
    .where(where)
    .orderBy(desc(transactions.date))
    .limit(3);
  return { matches: Number(totals?.matches ?? 0), inbox: Number(totals?.inbox ?? 0), samples };
}
