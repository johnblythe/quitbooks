/**
 * End to end on PGlite with the real migrations: import the synthetic QuickBooks Transaction Detail
 * sample through the real import path, then compare against the synthetic P&L by Month sample.
 *
 * fixtures/qbo-pnl-by-month.sample.csv is what QuickBooks would report for that detail file. A raw
 * import leaves the rows QuickBooks categorized but we deliberately don't (Booth Rent nobody matched,
 * a -Split- row, an asset purchase) in the Inbox; sorting those three is what makes it MATCH.
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { DEFAULT_CATEGORIES } from "@/db/defaults";
import * as schema from "@/db/schema";
import { makeCategorizer } from "./categorizer";
import { parseBankCsv } from "./csv";
import { CATEGORIZED_MAPPING_NAME, defaultChoices, summarizeFileCategories } from "./import-categories";
import { commitParsedImport } from "./import-commit";
import { QboCompareInputError } from "./qbo-compare";
import { runQboCompare, withReadOnly } from "./qbo-compare-db";
import { saveSplit } from "./split-server";

const { transactions, importBatches, csvMappings, users, categories, stylists, rules } = schema;

const detail = readFileSync("fixtures/qbo-transaction-detail.sample.csv", "utf8");
const pnlCsv = readFileSync("fixtures/qbo-pnl-by-month.sample.csv", "utf8");

let client: PGlite;
let db: Db;
let userId: string;
let jane: string;

beforeAll(async () => {
  client = new PGlite();
  const pg = drizzle(client, { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  db = pg as unknown as Db;
  const [u] = await db.insert(users).values({ email: "t@example.com", name: "T", passwordHash: "x" }).returning({ id: users.id });
  userId = u.id;
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(transactions);
  await db.delete(importBatches);
  await db.delete(csvMappings);
  await db.delete(rules);
  await db.delete(stylists);
  await db.delete(categories);
  // What `db:seed` creates on first setup.
  await db.insert(categories).values(
    DEFAULT_CATEGORIES.map((c, i) => ({ name: c.name, kind: c.kind, systemKey: c.systemKey ?? null, sortOrder: (i + 1) * 10 })),
  );
  const made = await db
    .insert(stylists)
    .values([
      { name: "Jane Doe", matchText: "JANE DOE", rentCents: 35000, rentCadence: "weekly", startDate: "2024-01-01" },
      { name: "Maria Ortiz", matchText: "MARIA ORTIZ", rentCents: 35000, rentCadence: "weekly", startDate: "2024-01-01" },
    ])
    .returning({ id: stylists.id, name: stylists.name });
  jane = made.find((s) => s.name === "Jane Doe")!.id;
  await importDetail();
});

/** The import screen's path: detected mapping, default category choices, stylist matching and rules. */
async function importDetail() {
  const parsed = parseBankCsv(detail);
  expect(parsed.mapping?.categoryColumn).toBe("Split");
  expect(parsed.errors).toHaveLength(1); // the 13/45/2025 row, which can't be imported
  const cats = await db.select({ id: categories.id, name: categories.name, kind: categories.kind, archived: categories.archived }).from(categories);
  const out = await commitParsedImport(db, {
    userId,
    filename: "qbo-transaction-detail.sample.csv",
    mappingName: CATEGORIZED_MAPPING_NAME,
    mapping: parsed.mapping!,
    rows: parsed.rows,
    links: [],
    categorizer: await makeCategorizer(db),
    categoryChoices: defaultChoices(summarizeFileCategories(parsed.rows), cats),
  });
  expect(out.inserted).toBe(parsed.rows.length);
}

async function categoryId(name: string) {
  const [c] = await db.select({ id: categories.id }).from(categories).where(eq(categories.name, name));
  return c.id;
}

async function tx(description: string, date?: string) {
  const rows = await db
    .select()
    .from(transactions)
    .where(date ? and(eq(transactions.description, description), eq(transactions.date, date)) : eq(transactions.description, description));
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** What a person does in the Inbox to match QuickBooks for the three rows the importer leaves there. */
async function sortInboxLikeLauren() {
  // Booth Rent from a Zelle the stylist matcher couldn't place: Lauren knows it was Jane's.
  const stranger = await tx("Zelle from a stranger");
  await db.update(transactions).set({ categoryId: await categoryId("Booth Rent"), stylistId: jane }).where(eq(transactions.id, stranger.id));
  // QuickBooks had Costco as a split: supplies plus a repair part.
  const costco = await tx("Costco");
  const split = await saveSplit(db, costco.id, [
    { categoryId: await categoryId("Supplies"), stylistId: null, amountCents: -26055, memo: "Color and foils" },
    { categoryId: await categoryId("Repairs & Maintenance"), stylistId: null, amountCents: -5000, memo: "Sink part" },
  ]);
  expect(split.ok).toBe(true);
  // QuickBooks put the Amazon purchase on the balance sheet (Uncategorized Asset): not P&L.
  const amazon = await tx("Amazon — Stuff");
  await db.update(transactions).set({ categoryId: await categoryId("Transfer Between Accounts") }).where(eq(transactions.id, amazon.id));
}

const compare = (opts: Partial<Parameters<typeof runQboCompare>[1]> = {}) =>
  runQboCompare(db, { csvText: pnlCsv, fileName: "qbo-pnl-by-month.sample.csv", ...opts });

const cells = (run: Awaited<ReturnType<typeof compare>>) =>
  run.result.mismatches.map((c) => ({ month: c.month, label: c.label, qbo: c.qbo, ours: c.ours, diff: c.diff }));

describe("qbo:compare against the synthetic QuickBooks samples", () => {
  it("matches QuickBooks to the penny once the Inbox is sorted", async () => {
    await sortInboxLikeLauren();
    const run = await compare();

    expect(run.result.warnings).toEqual([]);
    expect(cells(run)).toEqual([]);
    expect(run.match).toBe(true);
    expect(run.summary).toBe("MATCH");
    expect(run.report.trimEnd().split("\n").at(-1)).toBe("MATCH");
    for (const m of run.result.months) {
      expect(m.ours).toEqual(m.qbo);
    }
    expect(run.result.months.map((m) => m.qbo.net)).toEqual([-69607, -167075, -176602]);
    // Every QuickBooks account found its category through the mapping saved by the import.
    expect(run.result.unmapped).toEqual([]);
    expect(run.result.unmatchedCategories).toEqual([]);
    expect(new Set(run.result.mappings.map((m) => m.via))).toEqual(new Set(["saved import mapping"]));
    // What's still in the Inbox is what QuickBooks also left uncategorized.
    expect(run.result.inbox.map(({ month, inCents, outCents }) => ({ month, inCents, outCents }))).toEqual([
      { month: "2025-01", inCents: 0, outCents: 0 },
      { month: "2025-02", inCents: 7500, outCents: 17200 },
      { month: "2025-03", inCents: 0, outCents: 0 },
    ]);
  });

  it("flags exactly the changed cell and lists the transaction in it", async () => {
    await sortInboxLikeLauren();
    const square = await tx("Square — Card sales deposit", "2025-02-20");
    await db.update(transactions).set({ amountCents: 10300 }).where(eq(transactions.id, square.id));

    const run = await compare();
    expect(cells(run)).toEqual([{ month: "2025-02", label: "Product Sales", qbo: 13000, ours: 10300, diff: -2700 }]);
    const [cell] = run.result.mismatches;
    expect(cell.feeds).toEqual([{ account: "Product Sales", section: "income", cents: 13000 }]);
    expect(cell.lines.map((l) => [l.date, l.amountCents, l.tx.description, l.tx.source])).toEqual([
      ["2025-02-20", 10300, "Square — Card sales deposit", "csv"],
    ]);
    expect(run.report).toContain(`| 2025-02-20 | +$103.00 | Square — Card sales deposit | csv | /transactions/${square.id} |`);
    expect(run.match).toBe(false);
    expect(run.summary).toBe("1 mismatch, total abs diff $27.00");
    expect(run.report.trimEnd().split("\n").at(-1)).toBe("1 mismatch, total abs diff $27.00");
  });

  it("shows a recategorized transaction as the two cells it moved between, with month totals still equal", async () => {
    await sortInboxLikeLauren();
    const duke = await tx("Duke Energy", "2025-01-16");
    await db.update(transactions).set({ categoryId: await categoryId("Repairs & Maintenance") }).where(eq(transactions.id, duke.id));

    const run = await compare();
    expect(cells(run)).toEqual([
      { month: "2025-01", label: "Repairs & Maintenance", qbo: 0, ours: 14218, diff: 14218 },
      { month: "2025-01", label: "Utilities", qbo: 14218, ours: 0, diff: -14218 },
    ]);
    expect(run.result.months[0].ours).toEqual(run.result.months[0].qbo);
    expect(run.result.mismatches[0].lines.map((l) => l.tx.id)).toEqual([duke.id]);
    expect(run.result.mismatches[1].lines).toEqual([]);
  });

  it("explains a raw import: Inbox money on one side, QuickBooks' category on the other", async () => {
    const run = await compare();
    expect(cells(run)).toEqual([
      { month: "2025-01", label: "Booth Rent", qbo: 140000, ours: 105000, diff: -35000 },
      { month: "2025-01", label: "Inbox: uncategorized money in", qbo: 0, ours: 35000, diff: 35000 },
      { month: "2025-02", label: "Inbox: uncategorized money out", qbo: 17200, ours: 54676, diff: 37476 },
      { month: "2025-02", label: "Supplies", qbo: 45075, ours: 19020, diff: -26055 },
      { month: "2025-02", label: "Repairs & Maintenance", qbo: 5000, ours: 0, diff: -5000 },
    ]);
    expect(run.summary).toBe("5 mismatches, total abs diff $1,385.31");
    const uncatIn = run.result.mismatches[1];
    expect(uncatIn.lines.map((l) => l.tx.description)).toEqual(["Zelle from a stranger"]);
    expect(run.result.mismatches[2].feeds.map((f) => f.account)).toEqual(["Uncategorized Expense", "Ask My Accountant"]);
    expect(run.result.inbox[1]).toMatchObject({ inCents: 7500, inCount: 1, outCents: 54676, outCount: 5 });
    // Net income is off only by the asset purchase QuickBooks keeps off the P&L.
    expect(run.result.months.map((m) => m.ours.net - m.qbo.net)).toEqual([0, -6421, 0]);
  });

  it("compares only the months asked for", async () => {
    await sortInboxLikeLauren();
    const square = await tx("Square — Card sales deposit", "2025-02-20");
    await db.update(transactions).set({ amountCents: 10300 }).where(eq(transactions.id, square.id));

    expect((await compare({ from: "2025-03" })).summary).toBe("MATCH");
    expect((await compare({ to: "2025-01" })).summary).toBe("MATCH");
    const feb = await compare({ from: "2025-02", to: "2025-02" });
    expect(feb.result.columns.map((c) => c.month)).toEqual(["2025-02"]);
    expect(feb.summary).toBe("1 mismatch, total abs diff $27.00");
  });

  it("lets --map override the saved mapping, and lists our category left without an account", async () => {
    await sortInboxLikeLauren();
    const run = await compare({ overrides: { "Bank Charges": "bank & payment fees" } });
    expect(run.result.mappings.find((m) => m.fullName === "Bank Charges")).toMatchObject({ via: "--map", targetLabel: "Bank & Payment Fees" });
    expect(cells(run)).toEqual([
      { month: "2025-01", label: "Bank & Payment Fees", qbo: 1500, ours: 0, diff: -1500 },
      { month: "2025-01", label: "Bank Charges", qbo: 0, ours: 1500, diff: 1500 },
      { month: "2025-02", label: "Bank & Payment Fees", qbo: 1500, ours: 0, diff: -1500 },
      { month: "2025-02", label: "Bank Charges", qbo: 0, ours: 1500, diff: 1500 },
    ]);
    expect(run.result.unmatchedCategories.map((u) => [u.category.name, u.cents])).toEqual([["Bank Charges", 3000]]);
    await expect(compare({ overrides: { "Bank Charges": "Nope" } })).rejects.toBeInstanceOf(QboCompareInputError);
  });

  it("tolerates differences up to --tolerance-cents", async () => {
    await sortInboxLikeLauren();
    const square = await tx("Square — Card sales deposit", "2025-02-20");
    await db.update(transactions).set({ amountCents: 12999 }).where(eq(transactions.id, square.id));
    expect((await compare()).summary).toBe("1 mismatch, total abs diff $0.01");
    expect((await compare({ toleranceCents: 1 })).summary).toBe("MATCH");
  });
});

describe("read only", () => {
  it("refuses writes inside the compare's transaction", async () => {
    const [before] = await db.select({ n: count() }).from(categories);
    const err = await withReadOnly(db, (t) => t.insert(categories).values({ name: "Sneaky", kind: "expense" })).then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    // Drizzle wraps the Postgres error; the cause is Postgres refusing the write.
    expect(err?.cause?.message).toMatch(/cannot execute INSERT in a read-only transaction/);
    const [after] = await db.select({ n: count() }).from(categories);
    expect(after.n).toBe(before.n);
  });

  it("writes nothing while comparing", async () => {
    const snapshot = async () => ({
      tx: await db.select().from(transactions).orderBy(transactions.id),
      cats: await db.select().from(categories).orderBy(categories.id),
      maps: await db.select().from(csvMappings).orderBy(csvMappings.id),
    });
    const before = await snapshot();
    await compare();
    expect(await snapshot()).toEqual(before);
  });
});
