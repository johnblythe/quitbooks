/**
 * Runs the real commit path against an in-memory PGlite database with the real migrations applied.
 * (Production uses node-postgres; both drivers run the same SQL and support transactions.)
 */
import { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { parseBankCsv, type CsvMapping } from "./csv";
import { commitParsedImport, existingHashes, findManualCandidates, ImportLinkError } from "./import-commit";
import { matchManualEntries } from "./import-match";

const { transactions, importBatches, csvMappings, users } = schema;

const MAPPING: CsvMapping = {
  dateColumn: "Date",
  descriptionColumn: "Description",
  amountMode: "single",
  amountColumn: "Amount",
};

let client: PGlite;
let db: Db;
let userId: string;

beforeAll(async () => {
  client = new PGlite();
  const pg = drizzle(client, { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  db = pg as unknown as Db;
  const [u] = await db
    .insert(users)
    .values({ email: "t@example.com", name: "Test", passwordHash: "x" })
    .returning({ id: users.id });
  userId = u.id;
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(transactions);
  await db.delete(importBatches);
  await db.delete(csvMappings);
});

const noCategory = () => ({ categoryId: null, stylistId: null });

async function counts() {
  const [t] = await db.select({ n: count() }).from(transactions);
  const [b] = await db.select({ n: count() }).from(importBatches);
  const [m] = await db.select({ n: count() }).from(csvMappings);
  return { transactions: t.n, batches: b.n, mappings: m.n };
}

function commit(csv: string, over: Partial<Parameters<typeof commitParsedImport>[1]> = {}) {
  const parsed = parseBankCsv(csv, MAPPING);
  return commitParsedImport(db, {
    userId,
    filename: "t.csv",
    mappingName: "BMO",
    mapping: MAPPING,
    rows: parsed.rows,
    links: [],
    categorizer: noCategory,
    ...over,
  });
}

describe("commitParsedImport is atomic", () => {
  it("leaves 0 rows, 0 batches and no saved mapping when it fails mid-commit", async () => {
    // 260 rows = two insert chunks of 200 and 60. The categorizer throws on row 250, i.e. after the
    // first chunk has already been inserted and the batch row exists.
    const lines = ["Date,Description,Amount"];
    for (let i = 0; i < 260; i++) lines.push(`10/01/2026,ROW ${i},-${i + 1}.00`);
    let calls = 0;
    await expect(
      commit(lines.join("\n"), {
        categorizer: () => {
          if (++calls === 250) throw new Error("boom");
          return { categoryId: null, stylistId: null };
        },
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(250);
    expect(await counts()).toEqual({ transactions: 0, batches: 0, mappings: 0 });

    // And a clean retry afterwards imports everything exactly once.
    const out = await commit(lines.join("\n"));
    expect(out.inserted).toBe(260);
    expect(await counts()).toEqual({ transactions: 260, batches: 1, mappings: 1 });
  });

  it("rolls back everything when a link no longer holds", async () => {
    const [manual] = await db
      .insert(transactions)
      .values({ date: "2026-10-01", amountCents: 25000, description: "Jane rent", source: "manual" })
      .returning({ id: transactions.id });
    const csv = ["Date,Description,Amount", "10/01/2026,SALLY,-10.00", "10/01/2026,ZELLE JANE,260.00"].join("\n");
    const parsed = parseBankCsv(csv, MAPPING);
    const zelle = parsed.rows.find((r) => r.description === "ZELLE JANE")!;
    // The amount differs from the manual entry, so the server-side re-check must refuse the link.
    await expect(commit(csv, { links: [{ line: zelle.line, transactionId: manual.id }] })).rejects.toBeInstanceOf(
      ImportLinkError,
    );
    expect(await counts()).toEqual({ transactions: 1, batches: 0, mappings: 0 });
  });
});

describe("manual entry + imported row", () => {
  const manualRow = {
    date: "2026-10-01",
    amountCents: 25000,
    description: "Jane rent",
    note: "paid early",
    source: "manual" as const,
  };

  it("links instead of duplicating, keeps the manual row's fields, and dedupes on re-import", async () => {
    const [cat] = await db.select({ id: schema.categories.id }).from(schema.categories).limit(1);
    const [manual] = await db
      .insert(transactions)
      .values({ ...manualRow, categoryId: cat?.id ?? null })
      .returning({ id: transactions.id });
    const csv = [
      "Date,Description,Amount",
      "10/02/2026,ZELLE FROM JANE DOE,250.00",
      "10/03/2026,SALLY BEAUTY,-45.00",
    ].join("\n");
    const parsed = parseBankCsv(csv, MAPPING);

    // Preview side: the candidate is found and matched.
    const fresh = parsed.rows;
    const candidates = await findManualCandidates(db, fresh);
    expect(candidates.map((c) => c.id)).toEqual([manual.id]);
    const matches = matchManualEntries(fresh, candidates);
    expect([...matches.keys()]).toEqual([parsed.rows[0].line]);

    // Commit side.
    const out = await commit(csv, { links: [{ line: parsed.rows[0].line, transactionId: manual.id }] });
    expect(out).toMatchObject({ inserted: 1, linked: 1, duplicates: 0 });
    const all = await db.select().from(transactions);
    expect(all).toHaveLength(2); // one manual (now linked) + the Sally row; no second $250
    const linked = all.find((t) => t.id === manual.id)!;
    expect(linked.dedupeHash).toBe(parsed.rows[0].dedupeHash);
    expect(linked.description).toBe("Jane rent");
    expect(linked.note).toBe("paid early");
    expect(linked.categoryId).toBe(cat?.id ?? null);
    expect(linked.source).toBe("manual");
    expect(linked.date).toBe("2026-10-01");
    expect(linked.importBatchId).toBeNull();

    // Re-importing the same file: everything is a duplicate, nothing is added or matched again.
    const again = await commit(csv);
    expect(again).toMatchObject({ inserted: 0, linked: 0, duplicates: 2 });
    expect(await findManualCandidates(db, parsed.rows)).toEqual([]);
    expect((await db.select({ n: count() }).from(transactions))[0].n).toBe(2);
    const dupes = await existingHashes(db, parsed.rows.map((r) => r.dedupeHash));
    expect(dupes.size).toBe(2);
  });

  it("inserts normally when the match is unchecked (no link passed)", async () => {
    await db.insert(transactions).values(manualRow);
    const csv = ["Date,Description,Amount", "10/02/2026,ZELLE FROM JANE DOE,250.00"].join("\n");
    const out = await commit(csv);
    expect(out).toMatchObject({ inserted: 1, linked: 0 });
    expect((await db.select({ n: count() }).from(transactions))[0].n).toBe(2);
  });

  it("only offers manual, unhashed entries inside the window", async () => {
    await db.insert(transactions).values([
      { ...manualRow, description: "in window" },
      { ...manualRow, date: "2026-10-09", description: "too far" },
      { ...manualRow, description: "hashed", dedupeHash: "abc" },
      { ...manualRow, description: "from a csv", source: "csv" as const },
      { ...manualRow, amountCents: 25001, description: "other amount" },
    ]);
    const c = await findManualCandidates(db, [{ date: "2026-10-02", amountCents: 25000 }]);
    expect(c.map((x) => x.description)).toEqual(["in window"]);
  });

  it("refuses to link the same manual entry from two rows, or a row twice", async () => {
    const [manual] = await db.insert(transactions).values(manualRow).returning({ id: transactions.id });
    const csv = ["Date,Description,Amount", "10/01/2026,A,250.00", "10/01/2026,B,250.00"].join("\n");
    const p = parseBankCsv(csv, MAPPING);
    await expect(
      commit(csv, {
        links: [
          { line: p.rows[0].line, transactionId: manual.id },
          { line: p.rows[1].line, transactionId: manual.id },
        ],
      }),
    ).rejects.toBeInstanceOf(ImportLinkError);
    expect(await counts()).toMatchObject({ batches: 0 });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, manual.id));
    expect(row.dedupeHash).toBeNull();
  });
});
