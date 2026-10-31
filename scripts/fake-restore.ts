/** Restore the committed BMO fixtures through the real CSV parser/import writer. Never wipes data. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { scriptDb } from "./db";
import * as schema from "../src/db/schema";
import { parseBankCsv } from "../src/lib/csv";
import { makeCategorizer } from "../src/lib/categorizer";
import { commitParsedImport } from "../src/lib/import-commit";

async function main() {
  const args = process.argv.slice(2);
  if (!process.env.DATABASE_URL?.startsWith("pglite:") && !args.includes("--yes")) {
    throw new Error("Fake data is local-only by default. To restore the disposable dev database, pass --yes explicitly. Never target production.");
  }
  const csvPath = args.find((a) => !a.startsWith("--")) ?? "fixtures/bmo-fake-12mo-single.csv";
  const truthPath = csvPath.replace(/\.csv$/, ".truth.json");
  if (truthPath === csvPath) throw new Error("Pass a .csv fixture with a matching .truth.json file.");
  const parsed = parseBankCsv(readFileSync(csvPath, "utf8"));
  const truth = JSON.parse(readFileSync(truthPath, "utf8")) as { rows: unknown[] };
  if (!parsed.mapping || parsed.errors.length || !parsed.rows.length || parsed.rows.length !== truth.rows.length) {
    throw new Error("The fixture did not parse completely. Nothing was loaded.");
  }
  const { db, close } = await scriptDb();
  try {
    const [user] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
    if (!user) throw new Error("Create a test login with npm run user:add first. Run db:migrate before restoring.");
    const [feed] = await db.select({ id: schema.bankConnections.id }).from(schema.bankConnections).limit(1);
    const [bankRow] = await db.select({ id: schema.bankAccounts.id }).from(schema.bankAccounts).limit(1);
    if (feed || bankRow) throw new Error("Refusing fake CSV restore into books with bank-feed history. Use a separate test database.");
  } finally {
    await close();
  }
  execFileSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], { stdio: "inherit" });
  execFileSync(process.execPath, ["--import", "tsx", "scripts/fake-load.ts", truthPath, ...args.filter((a) => a === "--yes")], { stdio: "inherit" });
  const target = await scriptDb();
  try {
    const [user] = await target.db.select({ id: schema.users.id }).from(schema.users).limit(1);
    const outcome = await commitParsedImport(target.db, {
      userId: user.id,
      filename: basename(csvPath),
      mappingName: "BMO",
      mapping: parsed.mapping,
      rows: parsed.rows,
      links: [],
      categorizer: await makeCategorizer(target.db),
    });
    console.log(`Fixture restored: ${outcome.inserted} inserted, ${outcome.duplicates} already present. No existing transactions were deleted.`);
  } finally {
    await target.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Fixture restore failed.");
  process.exit(1);
});
