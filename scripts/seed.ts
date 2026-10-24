/** Seeds starter categories and settings. Safe to run more than once. */
import { scriptDb } from "./db";
import * as schema from "../src/db/schema";
import { DEFAULT_CATEGORIES, SETTING_KEYS } from "../src/db/defaults";

async function main() {
  const { db, close } = await scriptDb();

  const existing = await db.select({ name: schema.categories.name }).from(schema.categories);
  const have = new Set(existing.map((c) => c.name));
  const toAdd = DEFAULT_CATEGORIES.filter((c) => !have.has(c.name)).map((c, i) => ({
    name: c.name,
    kind: c.kind,
    systemKey: c.systemKey ?? null,
    sortOrder: (i + 1) * 10,
  }));
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
