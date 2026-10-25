/**
 * Category mapping through the real commit path, against an in-memory PGlite with the real migrations.
 * Uses the synthetic QuickBooks sample in fixtures/ (see csv-qbo.test.ts).
 */
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { BOOTH_RENT_KEY } from "@/db/defaults";
import * as schema from "@/db/schema";
import { detectMapping, parseBankCsv, type CsvMapping } from "./csv";
import { categorize } from "./categorize";
import { commitParsedImport, ImportCategoryError } from "./import-commit";
import {
  categoryKey,
  defaultChoices,
  summarizeFileCategories,
  type CategoryOption,
  type FileCategoryChoice,
} from "./import-categories";

const { transactions, importBatches, csvMappings, users, categories } = schema;

const sample = readFileSync("fixtures/qbo-transaction-detail.sample.csv", "utf8");
const MAPPING: CsvMapping = detectMapping(["Date", "Transaction Type", "Num", "Name", "Memo/Description", "Split", "Amount", "Balance"])!;

let client: PGlite;
let db: Db;
let userId: string;
let boothId: string;
let suppliesId: string;
let ruleCatId: string;
let stylistId: string;

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
  await db.delete(schema.rules);
  await db.delete(schema.stylists);
  await db.delete(categories);
  const made = await db
    .insert(categories)
    .values([
      { name: "Booth Rent", kind: "income", systemKey: BOOTH_RENT_KEY },
      { name: "Supplies", kind: "expense" },
      { name: "Rent Expense", kind: "expense" },
      { name: "Rule Target", kind: "expense" },
    ])
    .returning({ id: categories.id, name: categories.name });
  const id = (n: string) => made.find((c) => c.name === n)!.id;
  boothId = id("Booth Rent");
  suppliesId = id("Supplies");
  ruleCatId = id("Rule Target");
  const [s] = await db
    .insert(schema.stylists)
    .values({ name: "Jane Doe", matchText: "JANE DOE", rentCents: 35000, rentCadence: "weekly", startDate: "2024-01-01" })
    .returning({ id: schema.stylists.id });
  stylistId = s.id;
});

const noAuto = () => ({ categoryId: null, stylistId: null });

function cats(): Promise<CategoryOption[]> {
  return db.select({ id: categories.id, name: categories.name, kind: categories.kind, archived: categories.archived }).from(categories);
}

async function run(over: Partial<Parameters<typeof commitParsedImport>[1]> = {}, csv = sample) {
  const parsed = parseBankCsv(csv, MAPPING);
  return commitParsedImport(db, {
    userId,
    filename: "qbo.csv",
    mappingName: "BMO:categories",
    mapping: MAPPING,
    rows: parsed.rows,
    links: [],
    categorizer: noAuto,
    ...over,
  });
}

async function defaults(csv = sample): Promise<Record<string, FileCategoryChoice>> {
  const parsed = parseBankCsv(csv, MAPPING);
  return defaultChoices(summarizeFileCategories(parsed.rows), await cats());
}

async function tx(description: string) {
  const [row] = await db.select().from(transactions).where(eq(transactions.description, description));
  return row;
}

describe("file categories at commit", () => {
  it("creates 'new' categories and files rows under them, in the same commit", async () => {
    const choices = await defaults();
    const before = (await cats()).length;
    const out = await run({ categoryChoices: choices });

    // Product Sales, Utilities, Software & Subscriptions, Bank Charges, Owner's Draw, Owner Contribution,
    // Insurance, Retail Sales, Repairs & Maintenance are new; Booth Rent, Supplies, Rent Expense exist.
    expect(out.createdCategories).toBe(9);
    expect((await cats()).length).toBe(before + 9);

    const [draw] = await db.select().from(categories).where(eq(categories.name, "Owner's Draw"));
    expect(draw.kind).toBe("transfer");
    const [sales] = await db.select().from(categories).where(eq(categories.name, "Retail Sales"));
    expect(sales.kind).toBe("income");
    expect((await tx("Owner took money")).categoryId).toBe(draw.id);
    expect((await tx("Zelle Pat Kim")).categoryId).toBe(sales.id);
    // Existing-name match is case-insensitive: "rent expense" and "Rent Expense" both land on one category.
    const [rent] = await db.select().from(categories).where(eq(categories.name, "Rent Expense"));
    expect((await tx("Landlord LLC — February rent")).categoryId).toBe(rent.id);
    expect((await tx("Landlord LLC — March rent")).categoryId).toBe(rent.id);
  });

  it("leaves placeholders and blank categories uncategorized when nothing else matches", async () => {
    await run({ categoryChoices: await defaults() });
    for (const d of [
      "Costco",
      "Unknown — Mystery deposit",
      "Venmo — Something",
      "Amazon — Stuff",
      "Tax guy — Question for the CPA",
    ]) {
      expect((await tx(d)).categoryId).toBeNull();
    }
    expect((await tx("Mystery — No category on this one")).categoryId).toBeNull();
  });

  it("lets a placeholder row fall through to the rules", async () => {
    const rule = (r: { description: string; amountCents: number; date: string }) =>
      categorize(r, {
        stylists: [],
        rules: [{ id: "r1", pattern: "COSTCO", categoryId: ruleCatId, direction: "any", priority: 100 }],
        boothRentCategoryId: boothId,
      });
    await run({ categoryChoices: await defaults(), categorizer: rule });
    expect((await tx("Costco")).categoryId).toBe(ruleCatId);
  });

  it("beats rules: a mapped file category wins over a matching rule", async () => {
    const rule = () => ({ categoryId: ruleCatId, stylistId: null });
    await run({ categoryChoices: await defaults(), categorizer: rule });
    expect((await tx("Sally Beauty")).categoryId).toBe(suppliesId); // file says Supplies, rule says Rule Target
    expect((await tx("Costco")).categoryId).toBe(ruleCatId); // Leave for Inbox -> the rule
  });

  it("Booth Rent keeps its stylist from stylist matching, and goes to the Inbox without one", async () => {
    const auto = (r: { description: string; amountCents: number; date: string }) =>
      categorize(r, {
        stylists: [{ id: stylistId, name: "Jane Doe", matchText: "JANE DOE", startDate: "2024-01-01", endDate: null }],
        rules: [],
        boothRentCategoryId: boothId,
      });
    await run({ categoryChoices: await defaults(), categorizer: auto });
    const jane = await db.select().from(transactions).where(eq(transactions.description, "Zelle booth rent Jane Doe"));
    expect(jane.length).toBeGreaterThan(0);
    for (const j of jane) {
      expect(j.categoryId).toBe(boothId);
      expect(j.stylistId).toBe(stylistId);
    }
    // Booth Rent in the file but nobody to attribute it to: Inbox.
    const stranger = await tx("Zelle from a stranger");
    expect(stranger.categoryId).toBeNull();
    expect(stranger.stylistId).toBeNull();
    // Maria has no stylist record here either.
    expect((await tx("Zelle MARIA ORTIZ rent")).categoryId).toBeNull();
  });

  it("honours 'Leave for Inbox' and a different existing category chosen by the user", async () => {
    const choices = await defaults();
    choices["supplies"] = { type: "inbox" };
    choices["product sales"] = { type: "existing", categoryId: suppliesId };
    await run({ categoryChoices: choices });
    expect((await tx("Sally Beauty")).categoryId).toBeNull();
    expect((await tx("Square — Card sales deposit")).categoryId).toBe(suppliesId);
  });

  it("reuses an existing category when a 'new' name matches one, instead of making a twin", async () => {
    const out = await run({ categoryChoices: { supplies: { type: "new", name: "  SUPPLIES ", kind: "expense" } } });
    expect(out.createdCategories).toBe(0);
    const [n] = await db.select({ n: count() }).from(categories).where(eq(categories.name, "Supplies"));
    expect(n.n).toBe(1);
    expect((await tx("Sally Beauty")).categoryId).toBe(suppliesId);
  });

  it("does not create a category that no imported row uses", async () => {
    const out = await run({ categoryChoices: { "never seen": { type: "new", name: "Never Seen", kind: "expense" } } });
    expect(out.createdCategories).toBe(0);
    expect(await db.select().from(categories).where(eq(categories.name, "Never Seen"))).toHaveLength(0);
  });

  it("rolls back created categories when the commit fails afterwards", async () => {
    const before = (await cats()).length;
    let calls = 0;
    await expect(
      run({
        categoryChoices: await defaults(),
        categorizer: () => {
          if (++calls === 20) throw new Error("boom");
          return noAuto();
        },
      }),
    ).rejects.toThrow("boom");
    expect((await cats()).length).toBe(before);
    const [t] = await db.select({ n: count() }).from(transactions);
    expect(t.n).toBe(0);
    const [m] = await db.select({ n: count() }).from(csvMappings);
    expect(m.n).toBe(0);
  });

  it("refuses a choice pointing at a category that no longer exists", async () => {
    await expect(
      run({ categoryChoices: { supplies: { type: "existing", categoryId: "00000000-0000-4000-8000-000000000000" } } }),
    ).rejects.toBeInstanceOf(ImportCategoryError);
    const [t] = await db.select({ n: count() }).from(transactions);
    expect(t.n).toBe(0);
  });
});

describe("remembered mapping", () => {
  it("saves the choices with the column mapping, a new category as the one it created", async () => {
    await run({ categoryChoices: await defaults() });
    const [saved] = await db.select().from(csvMappings).where(eq(csvMappings.name, "BMO:categories"));
    expect(saved.mapping.categoryColumn).toBe("Split");
    const map = saved.mapping.categoryMap!;
    const [draw] = await db.select().from(categories).where(eq(categories.name, "Owner's Draw"));
    expect(map[categoryKey("Owner's Draw")]).toEqual({ type: "existing", categoryId: draw.id });
    expect(map["-split-"]).toEqual({ type: "inbox" });
    expect(map["supplies"]).toEqual({ type: "existing", categoryId: suppliesId });
  });

  it("pre-fills the next import, so nothing is created twice", async () => {
    await run({ categoryChoices: await defaults() });
    const [saved] = await db.select().from(csvMappings).where(eq(csvMappings.name, "BMO:categories"));

    const parsed = parseBankCsv(sample, saved.mapping);
    const groups = summarizeFileCategories(parsed.rows);
    const again = defaultChoices(groups, await cats(), saved.mapping.categoryMap);
    expect(Object.values(again).filter((c) => c.type === "new")).toHaveLength(0);

    // A choice the user changed last time is what comes back, not the heuristic.
    await db.delete(transactions);
    const edited = { ...again, supplies: { type: "inbox" } as FileCategoryChoice };
    await run({ categoryChoices: edited });
    const [saved2] = await db.select().from(csvMappings).where(eq(csvMappings.name, "BMO:categories"));
    const next = defaultChoices(groups, await cats(), saved2.mapping.categoryMap);
    expect(next["supplies"]).toEqual({ type: "inbox" });
  });

  it("does not store a category map for a mapping without a category column", async () => {
    const plain: CsvMapping = { dateColumn: "Date", descriptionColumn: "Name", amountMode: "single", amountColumn: "Amount" };
    await run({ mapping: plain, mappingName: "BMO", categoryChoices: { supplies: { type: "inbox" } } });
    const [saved] = await db.select().from(csvMappings).where(and(eq(csvMappings.name, "BMO")));
    expect(saved.mapping.categoryMap).toBeUndefined();
  });
});
