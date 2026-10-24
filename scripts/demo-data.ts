/**
 * Loads made-up sample data (stylists, six months of transactions) for local development.
 * Refuses to run against anything but a local PGlite database.
 */
import { scriptDb } from "./db";
import * as schema from "../src/db/schema";
import { SETTING_KEYS } from "../src/db/defaults";
import { eq } from "drizzle-orm";

async function main() {
  if (!process.env.DATABASE_URL?.startsWith("pglite:")) {
    console.error("demo-data only runs against a local pglite: database.");
    process.exit(1);
  }
  const { db, close } = await scriptDb();
  const cats = await db.select().from(schema.categories);
  const cat = (name: string) => {
    const c = cats.find((x) => x.name === name);
    if (!c) throw new Error(`Missing category ${name}; run npm run db:seed first.`);
    return c.id;
  };

  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const monthsAgo = (n: number, day: number) => iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - n, day)));

  const stylistRows = await db
    .insert(schema.stylists)
    .values([
      { name: "Avery Example", matchText: "AVERY EXAMPLE", chairLabel: "Chair 1", rentCents: 25000, rentCadence: "weekly", startDate: monthsAgo(6, 1) },
      { name: "Blake Sample", matchText: "BLAKE SAMPLE", chairLabel: "Chair 2", rentCents: 50000, rentCadence: "biweekly", startDate: monthsAgo(4, 3) },
      { name: "Casey Demo", matchText: "CASEY DEMO", chairLabel: "Chair 3", rentCents: 95000, rentCadence: "monthly", startDate: monthsAgo(6, 1), endDate: monthsAgo(1, 28) },
    ])
    .returning();

  await db.insert(schema.rules).values([
    { pattern: "POWER & LIGHT", categoryId: cat("Utilities"), direction: "out" },
    { pattern: "CITIZENS ENERGY", categoryId: cat("Utilities"), direction: "out" },
    { pattern: "SALLY BEAUTY", categoryId: cat("Supplies"), direction: "out" },
    { pattern: "LANDLORD LLC", categoryId: cat("Rent & Lease"), direction: "out" },
    { pattern: "SQUARE", categoryId: cat("Software & Subscriptions"), direction: "out" },
  ]);

  const txs: (typeof schema.transactions.$inferInsert)[] = [];
  for (let m = 6; m >= 0; m--) {
    for (const day of [3, 10, 17, 24]) {
      if (m === 0 && day > today.getUTCDate()) continue;
      txs.push({ date: monthsAgo(m, day), amountCents: 25000, description: "ZELLE FROM AVERY EXAMPLE", categoryId: cat("Booth Rent"), stylistId: stylistRows[0].id, source: "manual" });
    }
    if (m <= 4) {
      for (const day of [5, 19]) {
        if (m === 0 && day > today.getUTCDate()) continue;
        txs.push({ date: monthsAgo(m, day), amountCents: 50000, description: "ZELLE FROM BLAKE SAMPLE", categoryId: cat("Booth Rent"), stylistId: stylistRows[1].id, source: "manual" });
      }
    }
    if (m >= 1) {
      txs.push({ date: monthsAgo(m, 2), amountCents: 95000, description: "ZELLE FROM CASEY DEMO", categoryId: cat("Booth Rent"), stylistId: stylistRows[2].id, source: "manual" });
    }
    txs.push({ date: monthsAgo(m, 1), amountCents: -220000, description: "LANDLORD LLC RENT", categoryId: cat("Rent & Lease"), source: "manual" });
    txs.push({ date: monthsAgo(m, 12), amountCents: -18000 - m * 900, description: "INDY POWER & LIGHT", categoryId: cat("Utilities"), source: "manual" });
    txs.push({ date: monthsAgo(m, 14), amountCents: -6500 - m * 300, description: "CITIZENS ENERGY", categoryId: cat("Utilities"), source: "manual" });
    txs.push({ date: monthsAgo(m, 15), amountCents: -12000 - (m % 3) * 4000, description: "SALLY BEAUTY #1123", categoryId: cat("Supplies"), source: "manual" });
    txs.push({ date: monthsAgo(m, 20), amountCents: -4900, description: "SQUARE WEBSITE", categoryId: cat("Software & Subscriptions"), source: "manual" });
  }
  txs.push({ date: monthsAgo(0, 1), amountCents: -2599, description: "AMZN MKTP US", source: "manual" });
  txs.push({ date: monthsAgo(0, 2), amountCents: -15000, description: "CHECK 1043", source: "manual" });

  await db.insert(schema.transactions).values(txs);
  await db
    .insert(schema.settings)
    .values({ key: SETTING_KEYS.openingBalance, value: { cents: 500000, asOf: monthsAgo(6, 1) } })
    .onConflictDoNothing();
  await db.update(schema.settings).set({ value: 4 }).where(eq(schema.settings.key, SETTING_KEYS.totalChairs));

  await close();
  console.log(`Loaded ${stylistRows.length} stylists and ${txs.length} transactions.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
