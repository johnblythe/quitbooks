/**
 * Builds the categorizer from the DB state. Free of Next imports so the sync core and tests can
 * pass any `Db`. `getCategorizer()` in data.ts is the request-scoped wrapper.
 */
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { BOOTH_RENT_KEY } from "@/db/defaults";
import { categorize, type CategorizeInput } from "./categorize";

const { stylists, rules, categories } = schema;

export async function makeCategorizer(db: Pick<Db, "select">) {
  const [allStylists, allRules, booth] = await Promise.all([
    db.select().from(stylists),
    db.select().from(rules).orderBy(asc(rules.priority), desc(sql`length(${rules.pattern})`), asc(rules.createdAt), asc(rules.id)),
    db.select({ id: categories.id }).from(categories).where(eq(categories.systemKey, BOOTH_RENT_KEY)),
  ]);
  const boothRentCategoryId = booth[0]?.id ?? null;
  return (tx: CategorizeInput) => categorize(tx, { stylists: allStylists, rules: allRules, boothRentCategoryId });
}
