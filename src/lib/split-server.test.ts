/**
 * Split transactions on PGlite with the real migrations: saving/removing splits, the schema's
 * guards, metric expansion from the database, and every Inbox exclusion (Inbox query, rules,
 * the rule tester, AI suggestions, import linking).
 */
import { PGlite } from "@electric-sql/pglite";
import { asc, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { suggestCategories, type SuggestClient } from "./ai-suggest-server";
import { parseBankCsv } from "./csv";
import { commitParsedImport } from "./import-commit";
import { inInbox } from "./inbox-where";
import { computePnl, rentStatusForMonth } from "./metrics";
import { applyRules, testRuleMatches } from "./rules-server";
import { metricTxsInRange, removeSplit, saveSplit, splitLinesFor, splitLinesInRange } from "./split-server";

const { transactions, transactionSplits, categories, stylists, rules, users, importBatches, csvMappings } = schema;

let pg: PGlite;
let db: Db;
let cat: Record<"booth" | "sales" | "fees" | "supplies" | "draw" | "old", string>;
let jane: string;
let kim: string;

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: "./drizzle" });
  db = d as unknown as Db;
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await db.delete(transactions);
  await db.delete(importBatches);
  await db.delete(csvMappings);
  await db.delete(rules);
  await db.delete(stylists);
  await db.delete(categories);
  const rows = await db
    .insert(categories)
    .values([
      { name: "Booth Rent", kind: "income", systemKey: "booth_rent" },
      { name: "Product Sales", kind: "income" },
      { name: "Bank & Payment Fees", kind: "expense" },
      { name: "Supplies", kind: "expense" },
      { name: "Owner Draw", kind: "transfer" },
      { name: "Old", kind: "expense", archived: true },
    ])
    .returning({ id: categories.id, name: categories.name });
  const id = (n: string) => rows.find((r) => r.name === n)!.id;
  cat = {
    booth: id("Booth Rent"),
    sales: id("Product Sales"),
    fees: id("Bank & Payment Fees"),
    supplies: id("Supplies"),
    draw: id("Owner Draw"),
    old: id("Old"),
  };
  const people = await db
    .insert(stylists)
    .values([
      { name: "Jane Doe", rentCents: 25000, rentCadence: "monthly", startDate: "2026-01-01" },
      { name: "Kim Lee", rentCents: 25000, rentCadence: "monthly", startDate: "2026-01-01" },
    ])
    .returning({ id: stylists.id, name: stylists.name });
  jane = people.find((p) => p.name === "Jane Doe")!.id;
  kim = people.find((p) => p.name === "Kim Lee")!.id;
});

async function add(description: string, amountCents: number, extra: Partial<typeof transactions.$inferInsert> = {}) {
  const [r] = await db
    .insert(transactions)
    .values({ date: "2026-10-03", amountCents, description, source: "csv", ...extra })
    .returning({ id: transactions.id });
  return r.id;
}
const row = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];
const lineCount = async (id: string) =>
  (await db.select({ n: count() }).from(transactionSplits).where(eq(transactionSplits.transactionId, id)))[0].n;
const L = (categoryId: string, amountCents: number, stylistId: string | null = null, memo: string | null = null) => ({
  categoryId,
  stylistId,
  amountCents,
  memo,
});

describe("saveSplit", () => {
  it("splits a deposit across two stylists and takes the parent out of the Inbox", async () => {
    const id = await add("ZELLE FROM JANE DOE", 50000, { categoryId: cat.booth, stylistId: jane });
    const r = await saveSplit(db, id, [L(cat.booth, 25000, jane), L(cat.booth, 25000, kim, "Kim's share")]);
    expect(r).toEqual({ ok: true, date: "2026-10-03" });
    const p = await row(id);
    expect(p).toMatchObject({ isSplit: true, categoryId: null, stylistId: null, amountCents: 50000 });
    const lines = await splitLinesFor(db, id);
    expect(lines.map((l) => [l.position, l.categoryName, l.stylistName, l.amountCents, l.memo])).toEqual([
      [0, "Booth Rent", "Jane Doe", 25000, null],
      [1, "Booth Rent", "Kim Lee", 25000, "Kim's share"],
    ]);
  });

  it("replaces the lines on a second save", async () => {
    const id = await add("SQUARE INC DEPOSIT", 10000);
    await saveSplit(db, id, [L(cat.sales, 9000), L(cat.fees, 1000)]);
    await saveSplit(db, id, [L(cat.sales, 10300), L(cat.fees, -300)]);
    expect((await splitLinesFor(db, id)).map((l) => l.amountCents)).toEqual([10300, -300]);
  });

  it("checks against the stored amount and writes nothing when invalid", async () => {
    const id = await add("SQUARE INC DEPOSIT", 10000, { categoryId: cat.sales });
    const bad = [
      [L(cat.sales, 9000), L(cat.fees, 999)], // doesn't add up
      [L(cat.sales, 10000)], // one line
      [L(cat.sales, 5000), L(cat.old, 5000)], // archived
      [L(cat.booth, 5000), L(cat.sales, 5000)], // booth rent without a stylist
      [L(cat.sales, 10000), L(cat.fees, 0)], // zero line
    ];
    for (const lines of bad) {
      const r = await saveSplit(db, id, lines);
      expect(r.ok).toBe(false);
    }
    expect(await lineCount(id)).toBe(0);
    expect(await row(id)).toMatchObject({ isSplit: false, categoryId: cat.sales });
    expect(await saveSplit(db, "00000000-0000-4000-8000-000000000000", [L(cat.sales, 1), L(cat.fees, 1)])).toEqual({
      ok: false,
      error: "That transaction no longer exists.",
    });
  });

  it("deleting the transaction deletes its lines", async () => {
    const id = await add("SQUARE INC DEPOSIT", 10000);
    await saveSplit(db, id, [L(cat.sales, 10300), L(cat.fees, -300)]);
    await db.delete(transactions).where(eq(transactions.id, id));
    expect(await lineCount(id)).toBe(0);
  });
});

describe("schema guards", () => {
  it("a split parent can't carry its own category, and a line can't be zero", async () => {
    const id = await add("SQUARE INC DEPOSIT", 10000);
    await saveSplit(db, id, [L(cat.sales, 10300), L(cat.fees, -300)]);
    await expect(db.update(transactions).set({ categoryId: cat.sales }).where(eq(transactions.id, id))).rejects.toThrow();
    await expect(
      db.insert(transactionSplits).values({ transactionId: id, position: 9, categoryId: cat.sales, amountCents: 0 }),
    ).rejects.toThrow();
  });
});

describe("removeSplit", () => {
  it("with no category, the row goes back to the Inbox", async () => {
    const id = await add("SQUARE INC DEPOSIT", 10000);
    await saveSplit(db, id, [L(cat.sales, 10300), L(cat.fees, -300)]);
    expect(await removeSplit(db, id, { categoryId: null, stylistId: jane })).toEqual({ ok: true, date: "2026-10-03" });
    expect(await row(id)).toMatchObject({ isSplit: false, categoryId: null, stylistId: null });
    expect(await lineCount(id)).toBe(0);
    expect((await db.select({ id: transactions.id }).from(transactions).where(inInbox())).map((r) => r.id)).toEqual([id]);
  });

  it("with a category (and stylist), the row takes it", async () => {
    const id = await add("ZELLE FROM JANE DOE", 50000);
    await saveSplit(db, id, [L(cat.booth, 25000, jane), L(cat.booth, 25000, kim)]);
    await removeSplit(db, id, { categoryId: cat.booth, stylistId: jane });
    expect(await row(id)).toMatchObject({ isSplit: false, categoryId: cat.booth, stylistId: jane });
  });

  it("rejects a hidden category and leaves the split alone; is a no-op on an unsplit row", async () => {
    const id = await add("SQUARE INC DEPOSIT", 10000);
    await saveSplit(db, id, [L(cat.sales, 10300), L(cat.fees, -300)]);
    expect((await removeSplit(db, id, { categoryId: cat.old, stylistId: null })).ok).toBe(false);
    expect(await lineCount(id)).toBe(2);

    const plain = await add("PLAIN", -500, { categoryId: cat.supplies });
    await removeSplit(db, plain, { categoryId: null, stylistId: null });
    expect(await row(plain)).toMatchObject({ categoryId: cat.supplies });
  });
});

describe("metrics from the database expand split parents", () => {
  it("P&L and booth rent per stylist see the lines; the balance is unchanged", async () => {
    const dep = await add("ZELLE FROM JANE DOE", 50000);
    await saveSplit(db, dep, [L(cat.booth, 25000, jane), L(cat.booth, 25000, kim)]);
    const sq = await add("SQUARE INC DEPOSIT", 10000, { date: "2026-10-05" });
    await saveSplit(db, sq, [L(cat.sales, 10300), L(cat.fees, -300)]);
    const costco = await add("COSTCO", -6000, { date: "2026-10-09" });
    await saveSplit(db, costco, [L(cat.supplies, -4500), L(cat.draw, -1500)]);
    await add("OUT OF RANGE", 99900, { date: "2026-11-01" });
    const outside = await add("SPLIT OUT OF RANGE", 2000, { date: "2026-09-30" });
    await saveSplit(db, outside, [L(cat.sales, 1000), L(cat.sales, 1000)]);

    const txs = await metricTxsInRange(db, "2026-10-01", "2026-10-31");
    expect(txs).toHaveLength(6);
    expect(txs.reduce((s, t) => s + t.amountCents, 0)).toBe(50000 + 10000 - 6000);
    expect(txs.every((t) => t.categoryId !== null)).toBe(true);

    const cats = (await db.select().from(categories)).map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
    const p = computePnl(txs, cats, "2026-10-01", "2026-10-31");
    expect(p.totalIncome).toBe(50000 + 10300);
    expect(p.totalExpenses).toBe(300 + 4500);
    expect(p.uncategorizedCount).toBe(0);

    const roster = (await db.select().from(stylists)).map((s) => ({ ...s, rentCadence: s.rentCadence }));
    const rent = rentStatusForMonth(roster, txs, cat.booth, "2026-10");
    expect(rent.map((r) => [r.name, r.collected, r.status])).toEqual([
      ["Jane Doe", 25000, "paid"],
      ["Kim Lee", 25000, "paid"],
    ]);

    expect((await splitLinesInRange(db, "2026-10-01", "2026-10-31")).length).toBe(6);
    expect((await splitLinesInRange(db)).length).toBe(8);
  });
});

describe("split parents are never in the Inbox", () => {
  async function seed() {
    const open = await add("SALLY BEAUTY #1", -2000);
    const done = await add("SALLY BEAUTY #2", -3000, { categoryId: cat.supplies });
    const split = await add("SALLY BEAUTY #3", -5000);
    await saveSplit(db, split, [L(cat.supplies, -4000), L(cat.draw, -1000)]);
    return { open, done, split };
  }

  it("the Inbox query skips them", async () => {
    const { open } = await seed();
    const inbox = await db.select({ id: transactions.id }).from(transactions).where(inInbox());
    expect(inbox.map((r) => r.id)).toEqual([open]);
  });

  it("applyRules sorts only real Inbox rows and leaves split parents split", async () => {
    const { open, split } = await seed();
    await db.insert(rules).values({ pattern: "SALLY BEAUTY", categoryId: cat.fees, direction: "out" });
    expect(await applyRules(db)).toBe(1);
    expect(await row(open)).toMatchObject({ categoryId: cat.fees });
    expect(await row(split)).toMatchObject({ isSplit: true, categoryId: null });
    expect(await lineCount(split)).toBe(2);
  });

  it("the rule tester's 'M in Inbox' doesn't count them", async () => {
    await seed();
    const r = await testRuleMatches("sally beauty", "out", db);
    expect(r.matches).toBe(3);
    expect(r.inbox).toBe(1);
  });

  it("AI suggestions never ask about or write to them", async () => {
    const { open, split } = await seed();
    const sent: string[] = [];
    const client: SuggestClient = {
      messages: {
        parse: async (params) => {
          const content = String((params.messages[0] as { content: string }).content);
          const groups: { key: string; sampleDescriptions: string[] }[] = JSON.parse(content.slice(content.indexOf("{"))).groups;
          sent.push(...groups.flatMap((g) => g.sampleDescriptions));
          return { stop_reason: "end_turn", parsed_output: { suggestions: groups.map((g) => ({ key: g.key, categoryId: cat.supplies })) } };
        },
      },
    };
    const r = await suggestCategories({ db, client });
    expect(r.requested).toBe(1);
    expect(sent).toEqual(["SALLY BEAUTY #1"]);
    expect((await row(open)).suggestedCategoryId).toBe(cat.supplies);
    expect(await row(split)).toMatchObject({ suggestedCategoryId: null, suggestedAt: null });
  });
});

describe("import linking", () => {
  it("linking a CSV row to a split manual entry keeps the split and its lines", async () => {
    const [u] = await db.insert(users).values({ email: "s@example.com", name: "S", passwordHash: "x" }).returning({ id: users.id });
    const manual = await add("Square deposit (typed in)", 10000, { source: "manual", date: "2026-10-05" });
    await saveSplit(db, manual, [L(cat.sales, 10300), L(cat.fees, -300)]);
    const mapping = { dateColumn: "Date", descriptionColumn: "Description", amountMode: "single" as const, amountColumn: "Amount" };
    const parsed = parseBankCsv("Date,Description,Amount\n10/05/2026,SQUARE INC DEPOSIT,100.00\n", mapping);
    const out = await commitParsedImport(db, {
      userId: u.id,
      filename: "t.csv",
      mappingName: "BMO",
      mapping,
      rows: parsed.rows,
      links: [{ line: parsed.rows[0].line, transactionId: manual }],
      categorizer: () => ({ categoryId: cat.supplies, stylistId: null }),
    });
    expect(out).toMatchObject({ inserted: 0, linked: 1 });
    const p = await row(manual);
    expect(p.isSplit).toBe(true);
    expect(p.categoryId).toBeNull();
    expect(p.dedupeHash).toBe(parsed.rows[0].dedupeHash);
    expect(
      (await db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, manual)).orderBy(asc(transactionSplits.position))).map(
        (l) => l.amountCents,
      ),
    ).toEqual([10300, -300]);
  });
});
