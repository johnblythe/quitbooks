/**
 * Deletes transactions (and split lines), import batches, rules, CSV mappings and stylists, and makes the bank feed's
 * next sync re-fetch from its start date (so wiped feed rows come back). Keeps users, categories,
 * settings and the bank link. Requires --yes on any database.
 * Usage: npm run db:wipe -- --yes
 */
import { count } from "drizzle-orm";
import { scriptDb } from "./db";
import * as schema from "../src/db/schema";

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error(`Refusing to wipe ${process.env.DATABASE_URL?.split(":")[0] ?? "unknown"} database without --yes.`);
    process.exit(1);
  }
  const { db, close } = await scriptDb();
  // Order matters: split lines reference transactions; transactions reference batches and stylists.
  const targets = [
    ["split lines", schema.transactionSplits],
    ["transactions", schema.transactions],
    ["import batches", schema.importBatches],
    ["rules", schema.rules],
    ["csv mappings", schema.csvMappings],
    ["stylists", schema.stylists],
  ] as const;
  for (const [label, table] of targets) {
    const [{ n }] = await db.select({ n: count() }).from(table);
    await db.delete(table);
    console.log(`Deleted ${n} ${label}`);
  }
  const reset = await db
    .update(schema.bankConnections)
    .set({ fullSyncPending: true })
    .returning({ id: schema.bankConnections.id });
  console.log(`Bank feed: the next sync re-fetches from the start date (${reset.length} connection${reset.length === 1 ? "" : "s"})`);
  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
