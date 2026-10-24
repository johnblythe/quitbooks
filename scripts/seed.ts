/**
 * Seeds starter categories and settings. Safe to run more than once, including after
 * categories have been renamed.
 *
 * - System categories are matched by `systemKey`, never by name, so renaming Booth Rent
 *   neither re-adds it nor trips the system_key unique constraint.
 * - The editable defaults are inserted only when no categories exist yet (first setup). Matching
 *   them by name would resurrect any default that was renamed or hidden.
 */
import { scriptDb } from "./db";
import * as schema from "../src/db/schema";
import { DEFAULT_CATEGORIES, SETTING_KEYS } from "../src/db/defaults";

async function main() {
  const { db, close } = await scriptDb();

  const existing = await db
    .select({ systemKey: schema.categories.systemKey })
    .from(schema.categories);
  const haveKeys = new Set(existing.map((c) => c.systemKey).filter((k): k is string => !!k));
  const firstRun = existing.length === 0;

  const toAdd = DEFAULT_CATEGORIES.map((c, i) => ({
    name: c.name,
    kind: c.kind,
    systemKey: c.systemKey ?? null,
    sortOrder: (i + 1) * 10,
  })).filter((c) => (c.systemKey ? !haveKeys.has(c.systemKey) : firstRun));
  if (toAdd.length) await db.insert(schema.categories).values(toAdd);

  await db
    .insert(schema.settings)
    .values({ key: SETTING_KEYS.totalChairs, value: 6 })
    .onConflictDoNothing();

  await close();
  console.log(`Seeded ${toAdd.length} categories.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
