/**
 * Compares our cash-basis P&L with a QuickBooks Online "Profit and Loss by Month" CSV export,
 * month by month and category by category, and lists our transactions behind every cell that differs.
 *
 * READ ONLY. Safe to run against production: it only runs SELECTs, inside a single
 * `READ ONLY, REPEATABLE READ` transaction that Postgres refuses to write in, and it stops before
 * reading anything unless Postgres reports the transaction as read-only (src/lib/qbo-compare-db.ts).
 * It writes nothing to the database. The only file it writes is the optional --out report.
 *
 * Usage:
 *   npm run qbo:compare -- <pnl-by-month.csv> [--from YYYY-MM] [--to YYYY-MM]
 *                          [--tolerance-cents N] [--map map.json] [--out report.md]
 *   DATABASE_URL="$(cs production --pooled)" npm run qbo:compare -- pnl.csv --to 2026-09
 *
 * --map is a JSON object {"QuickBooks account": "Our category"}; "Inbox" means uncategorized.
 * Exit code 0 when every cell matches (within --tolerance-cents), 1 otherwise.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { scriptDb } from "./db";
import { parseCompareArgs, QboCompareInputError } from "../src/lib/qbo-compare";
import { runQboCompare } from "../src/lib/qbo-compare-db";
import { QboPnlParseError } from "../src/lib/qbo-pnl";

async function main(): Promise<number> {
  const args = parseCompareArgs(process.argv.slice(2));
  const csvText = readFileSync(args.file, "utf8");
  let overrides: unknown;
  if (args.mapFile) {
    try {
      overrides = JSON.parse(readFileSync(args.mapFile, "utf8"));
    } catch (e) {
      throw new QboCompareInputError(`--map ${args.mapFile} isn't readable JSON: ${(e as Error).message}`);
    }
  }

  const { db, close } = await scriptDb();
  try {
    const run = await runQboCompare(db, {
      csvText,
      fileName: basename(args.file),
      from: args.from,
      to: args.to,
      toleranceCents: args.toleranceCents,
      overrides,
    });
    process.stdout.write(run.report);
    if (args.outFile) {
      writeFileSync(args.outFile, run.report);
      console.error(`Report written to ${args.outFile}`);
    }
    return run.match ? 0 : 1;
  } finally {
    await close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const known = e instanceof QboCompareInputError || e instanceof QboPnlParseError;
    console.error(known ? (e as Error).message : e);
    process.exit(1);
  },
);
