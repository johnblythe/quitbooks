/**
 * Runs the bank sync once against DATABASE_URL (needs BANK_TOKEN_KEY).
 *
 *   npm run bank:sync                      sync every connection, print counts
 *   npm run bank:sync -- --connect=TOKEN [--from=YYYY-MM-DD] [--include=Name1,Name2|all]
 *                                          claim a setup token first, choose accounts, then sync
 *
 * Prints counts and balances only, never the Access URL.
 */
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { suggestCategories } from "../src/lib/ai-suggest-server";
import { connectBank, saveBankSelection, syncConnection } from "../src/lib/bank-sync-server";
import { defaultCutover } from "../src/lib/bank-status";
import { todayIso } from "../src/lib/dates";
import { formatCents } from "../src/lib/money";
import { scriptDb } from "./db";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const { db, close } = await scriptDb();
  try {
    const token = arg("connect");
    if (token) {
      const { connectionId, accountsError } = await connectBank({ db }, token, { label: "Demo" });
      if (accountsError) console.log(`Linked, but the accounts didn't load: ${accountsError}`);
      const accounts = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.connectionId, connectionId));
      const want = (arg("include") ?? "all").split(",").map((s) => s.trim());
      const ids = accounts.filter((a) => want.includes("all") || want.includes(a.name) || want.includes(a.externalId)).map((a) => a.id);
      const from = arg("from") ?? defaultCutover(null, todayIso());
      await saveBankSelection(db, connectionId, { includeAccountIds: ids, cutoverDate: from });
      console.log(`Connected. Accounts found: ${accounts.map((a) => `${a.name} (${a.balanceCents === null ? "?" : formatCents(a.balanceCents)})`).join(", ")}`);
      console.log(`Included ${ids.length}, start date ${from}.`);
    }

    const conns = await db.select({ id: schema.bankConnections.id, label: schema.bankConnections.label }).from(schema.bankConnections);
    if (!conns.length) console.log("No bank connections. Use --connect=<setup token>.");
    let failed = false;
    for (const c of conns) {
      const r = await syncConnection({ db }, c.id);
      console.log(`${c.label}: inserted ${r.inserted}, linked ${r.linked}, skipped ${r.skipped}, errors ${r.errors.length}`);
      for (const e of r.errors) console.log(`  error: ${e}`);
      for (const w of r.warnings) console.log(`  warning: ${w}`);
      if (r.errors.length) failed = true;
      const accts = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.connectionId, c.id));
      for (const a of accts.filter((x) => x.include)) {
        console.log(`  ${a.name}: balance ${a.balanceCents === null ? "n/a" : formatCents(a.balanceCents)} as of ${a.balanceDate?.toISOString() ?? "n/a"}`);
      }
    }
    const s = await suggestCategories({ db });
    console.log(
      s.skipped
        ? `Category suggestions skipped (${s.skipped}).`
        : `Category suggestions: ${s.suggested} of ${s.requested} rows, ${s.batches} batch(es)${s.error ? `, error ${s.error}` : ""}.`,
    );
    if (failed) process.exitCode = 1;
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
