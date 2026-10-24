/**
 * Loads a fake-BMO roster into the database: stylists, total chairs and the opening balance.
 * Transactions are NOT inserted; import the CSV through the app so the real path is exercised.
 * Usage: npm run fake:load -- <file.truth.json> [--yes]   (--yes is required unless DATABASE_URL is pglite:)
 */
import { readFileSync } from "node:fs";
import { scriptDb } from "./db";
import * as schema from "../src/db/schema";
import { SETTING_KEYS } from "../src/db/defaults";
import type { FakeTruth } from "../src/lib/fake-bmo";

async function setSetting(db: Awaited<ReturnType<typeof scriptDb>>["db"], key: string, value: unknown) {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("Usage: npm run fake:load -- <file.truth.json> [--yes]");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL?.startsWith("pglite:") && !yes) {
    console.error("DATABASE_URL is not a pglite: database. Re-run with --yes to load fake data into it anyway.");
    process.exit(1);
  }
  const truth = JSON.parse(readFileSync(path, "utf8")) as FakeTruth;

  const { db, close } = await scriptDb();
  const existing = new Set((await db.select({ name: schema.stylists.name }).from(schema.stylists)).map((s) => s.name));
  const toAdd = truth.roster.filter((r) => !existing.has(r.name));
  if (toAdd.length) {
    await db.insert(schema.stylists).values(
      toAdd.map((r) => ({
        name: r.name,
        matchText: r.matchText,
        chairLabel: r.chairLabel,
        rentCents: r.rentCents,
        rentCadence: r.cadence,
        startDate: r.startDate,
        endDate: r.endDate,
      })),
    );
  }
  await setSetting(db, SETTING_KEYS.totalChairs, truth.totalChairs);
  await setSetting(db, SETTING_KEYS.openingBalance, truth.openingBalance);
  await close();
  console.log(
    `Inserted ${toAdd.length} stylists (${truth.roster.length - toAdd.length} already existed). ` +
      `Chairs: ${truth.totalChairs}. Opening balance: ${truth.openingBalance.cents} cents as of ${truth.openingBalance.asOf}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
