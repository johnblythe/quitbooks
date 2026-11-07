/**
 * Undoing an import, on PGlite with the real migrations: the plan itself, then the real commit and
 * undo paths end to end (what goes, what stays, refusals, and re-importing afterwards).
 */
import { PGlite } from "@electric-sql/pglite";
import { asc, count, desc, eq, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { parseBankCsv, type CsvMapping, type ParsedRow } from "./csv";
import { commitParsedImport } from "./import-commit";
import {
  planImportUndo,
  previewImportUndo,
  undoImport,
  UNDO_ALREADY,
  UNDO_MISSING,
  type UndoBatch,
  type UndoRow,
} from "./import-undo";
import { saveSplit } from "./split-server";

const { transactions, transactionSplits, importBatches, csvMappings, users, categories, bankAccounts } = schema;

const MAPPING: CsvMapping = {
  dateColumn: "Date",
  descriptionColumn: "Description",
  amountMode: "single",
  amountColumn: "Amount",
};

describe("planImportUndo", () => {
  const at = new Date("2026-11-01T12:00:00Z");
  const batch: UndoBatch = { id: "b", filename: "qbo.csv", createdAt: at, undoneAt: null };
  const row = (over: Partial<UndoRow> = {}): UndoRow => ({
    id: Math.random().toString(36),
    amountCents: -1000,
    categoryId: null,
    isSplit: false,
    externalId: null,
    updatedAt: at,
    ...over,
  });

  it("counts removed, touched and the net amount", () => {
    const rows = [
      row(), // untouched: updatedAt is the import's own timestamp
      row({ amountCents: 25000, categoryId: "c" }),
      row({ amountCents: -500, isSplit: true, updatedAt: new Date(at.getTime() + 60_000) }),
      row({ amountCents: -2500, updatedAt: new Date(at.getTime() + 1) }), // edited
    ];
    const plan = planImportUndo(batch, rows);
    expect(plan).toMatchObject({ ok: true, filename: "qbo.csv", removed: 4, touched: 3, netCents: 21000 });
    expect(plan.ok && plan.ids).toEqual(rows.map((r) => r.id));
  });

  it("refuses a missing or undone batch, and any feed-linked row", () => {
    expect(planImportUndo(undefined, [])).toEqual({ ok: false, error: UNDO_MISSING });
    expect(planImportUndo({ ...batch, undoneAt: at }, [row()])).toEqual({ ok: false, error: UNDO_ALREADY });
    const linked = planImportUndo(batch, [row(), row({ externalId: "sf-1" }), row({ externalId: "sf-2" })]);
    expect(linked.ok).toBe(false);
    expect(!linked.ok && linked.error).toMatch(/^2 transactions .* bank feed/);
  });

  it("allows an empty batch (everything was a duplicate)", () => {
    expect(planImportUndo(batch, [])).toMatchObject({ ok: true, removed: 0, touched: 0, netCents: 0 });
  });
});

describe("undoImport on PGlite", () => {
  let client: PGlite;
  let db: Db;
  let userId: string;
  let supplies: string;
  let sales: string;
  let acctId: string;

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
    const cats = await db
      .insert(categories)
      .values([
        { name: "Undo Supplies", kind: "expense" },
        { name: "Undo Sales", kind: "income" },
      ])
      .returning({ id: categories.id, name: categories.name });
    supplies = cats.find((c) => c.name === "Undo Supplies")!.id;
    sales = cats.find((c) => c.name === "Undo Sales")!.id;
    const [a] = await db
      .insert(bankAccounts)
      .values({ externalId: "ACT-1", name: "Checking" })
      .returning({ id: bankAccounts.id });
    acctId = a.id;
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

  async function commit(
    filename: string,
    csv: string,
    over: Partial<Parameters<typeof commitParsedImport>[1]> = {},
  ) {
    const parsed = parseBankCsv(csv, MAPPING);
    const out = await commitParsedImport(db, {
      userId,
      filename,
      mappingName: "BMO",
      mapping: MAPPING,
      rows: parsed.rows,
      links: [],
      categorizer: noCategory,
      ...over,
    });
    const [batch] = await db.select().from(importBatches).orderBy(desc(importBatches.createdAt)).limit(1);
    expect(batch.filename).toBe(filename);
    return { out, batch, rows: parsed.rows };
  }

  async function totals() {
    const [t] = await db.select({ n: count(), net: sum(transactions.amountCents) }).from(transactions);
    const [s] = await db.select({ n: count() }).from(transactionSplits);
    return { transactions: t.n, net: Number(t.net ?? 0), splits: s.n };
  }

  const bankRow = {
    date: "2026-10-05",
    amountCents: -1234,
    description: "FEED ROW",
    source: "bank_sync" as const,
    externalId: "sf-feed-1",
  };

  it("removes exactly the batch's csv rows and their split lines; other batches, manual and bank rows stay", async () => {
    const [manual] = await db
      .insert(transactions)
      .values({ date: "2026-09-01", amountCents: 9900, description: "Typed in", source: "manual" })
      .returning({ id: transactions.id });
    const [bank] = await db
      .insert(transactions)
      .values({ ...bankRow, bankAccountId: acctId })
      .returning({ id: transactions.id });
    const a = await commit(
      "a.csv",
      ["Date,Description,Amount", "10/01/2026,A ONE,-10.00", "10/02/2026,A TWO,-20.00", "10/03/2026,A THREE,300.00"].join("\n"),
    );
    const b = await commit("b.csv", ["Date,Description,Amount", "10/04/2026,B ONE,-40.00", "10/05/2026,B TWO,-50.00"].join("\n"));
    expect(a.out.inserted).toBe(3);
    expect(b.out.inserted).toBe(2);

    // Split one of A's rows, and one of B's, so we can see whose lines go.
    const [aSplit] = await db.select().from(transactions).where(eq(transactions.description, "A THREE"));
    expect(await saveSplit(db, aSplit.id, [L(sales, 20000), L(supplies, 10000)])).toMatchObject({ ok: true });
    const [bSplit] = await db.select().from(transactions).where(eq(transactions.description, "B ONE"));
    expect(await saveSplit(db, bSplit.id, [L(supplies, -1000), L(supplies, -3000)])).toMatchObject({ ok: true });
    expect((await totals()).splits).toBe(4);

    const result = await undoImport(db, a.batch.id, userId);
    expect(result).toEqual({ ok: true, filename: "a.csv", removed: 3, touched: 1, netCents: 27000 });

    const left = await db.select().from(transactions);
    expect(left.map((t) => t.description).sort()).toEqual(["B ONE", "B TWO", "FEED ROW", "Typed in"]);
    expect(left.find((t) => t.id === manual.id)).toBeTruthy();
    expect(left.find((t) => t.id === bank.id)?.externalId).toBe("sf-feed-1");
    const splits = await db.select().from(transactionSplits);
    expect(splits).toHaveLength(2);
    expect(new Set(splits.map((s) => s.transactionId))).toEqual(new Set([bSplit.id]));

    const batches = await db.select().from(importBatches);
    expect(batches).toHaveLength(2); // the undone batch stays, as history
    const undone = batches.find((x) => x.id === a.batch.id)!;
    expect(undone.undoneAt).toBeInstanceOf(Date);
    expect(undone.undoneBy).toBe(userId);
    expect(undone.insertedCount).toBe(3);
    expect(batches.find((x) => x.id === b.batch.id)!.undoneAt).toBeNull();
  });

  it("leaves linked manual entries alone, dedupe hash included", async () => {
    const [manual] = await db
      .insert(transactions)
      .values({ date: "2026-10-01", amountCents: 25000, description: "Jane rent", note: "paid early", source: "manual", categoryId: sales })
      .returning({ id: transactions.id });
    const csv = ["Date,Description,Amount", "10/02/2026,ZELLE FROM JANE DOE,250.00", "10/03/2026,SALLY BEAUTY,-45.00"].join("\n");
    const parsed = parseBankCsv(csv, MAPPING);
    const { out, batch } = await commit("linked.csv", csv, { links: [{ line: parsed.rows[0].line, transactionId: manual.id }] });
    expect(out).toMatchObject({ inserted: 1, linked: 1 });
    const [before] = await db.select().from(transactions).where(eq(transactions.id, manual.id));

    expect(await undoImport(db, batch.id, userId)).toMatchObject({ ok: true, removed: 1 });

    const [after] = await db.select().from(transactions).where(eq(transactions.id, manual.id));
    expect(after).toEqual(before);
    expect(after.dedupeHash).toBe(parsed.rows[0].dedupeHash);
    expect((await totals()).transactions).toBe(1);
  });

  it("refuses a second undo of the same batch, and an unknown batch", async () => {
    const { batch } = await commit("twice.csv", ["Date,Description,Amount", "10/01/2026,ONE,-10.00"].join("\n"));
    expect(await undoImport(db, batch.id, userId)).toMatchObject({ ok: true, removed: 1 });
    const [first] = await db.select().from(importBatches).where(eq(importBatches.id, batch.id));

    // A row that later picks up the batch id (it can't today, but the undo must not touch it anyway).
    await db.insert(transactions).values({ date: "2026-10-01", amountCents: -10, description: "later", source: "csv", importBatchId: batch.id });
    expect(await undoImport(db, batch.id, userId)).toEqual({ ok: false, error: UNDO_ALREADY });
    expect(await previewImportUndo(db, batch.id)).toEqual({ ok: false, error: UNDO_ALREADY });
    expect((await totals()).transactions).toBe(1);
    const [second] = await db.select().from(importBatches).where(eq(importBatches.id, batch.id));
    expect(second.undoneAt).toEqual(first.undoneAt);

    const unknown = "00000000-0000-4000-8000-000000000000";
    expect(await undoImport(db, unknown, userId)).toEqual({ ok: false, error: UNDO_MISSING });
    expect(await previewImportUndo(db, unknown)).toEqual({ ok: false, error: UNDO_MISSING });
  });

  it("refuses the whole undo when one row is feed-linked, and changes nothing", async () => {
    const { batch } = await commit(
      "feed.csv",
      ["Date,Description,Amount", "10/01/2026,ONE,-10.00", "10/02/2026,TWO,-20.00", "10/03/2026,THREE,-30.00"].join("\n"),
    );
    await db
      .update(transactions)
      .set({ bankAccountId: acctId, externalId: "sf-linked-1" })
      .where(eq(transactions.description, "TWO"));
    const before = await db.select().from(transactions).orderBy(asc(transactions.id));

    const result = await undoImport(db, batch.id, userId);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/bank feed.*Nothing was changed/);
    expect((await previewImportUndo(db, batch.id)).ok).toBe(false);

    expect(await db.select().from(transactions).orderBy(asc(transactions.id))).toEqual(before);
    const [b] = await db.select().from(importBatches).where(eq(importBatches.id, batch.id));
    expect(b.undoneAt).toBeNull();
    expect(b.undoneBy).toBeNull();
  });

  it("re-importing the same file after an undo inserts its rows again, except lines linked to manual entries", async () => {
    await db.insert(transactions).values({ date: "2026-10-01", amountCents: 25000, description: "Jane rent", source: "manual" });
    const csv = [
      "Date,Description,Amount",
      "10/02/2026,ZELLE FROM JANE DOE,250.00",
      "10/03/2026,SALLY BEAUTY,-45.00",
      "10/04/2026,COMCAST,-89.99",
    ].join("\n");
    const parsed = parseBankCsv(csv, MAPPING);
    const [manual] = await db.select().from(transactions);
    const first = await commit("redo.csv", csv, { links: [{ line: parsed.rows[0].line, transactionId: manual.id }] });
    expect(first.out).toMatchObject({ inserted: 2, linked: 1, duplicates: 0 });

    expect(await undoImport(db, first.batch.id, userId)).toMatchObject({ ok: true, removed: 2 });
    expect(await hashesPresent(parsed.rows)).toEqual([parsed.rows[0].dedupeHash]);

    // A plain re-import (no links): the two removed lines come back, the linked line stays a duplicate.
    const again = await commit("redo.csv", csv);
    expect(again.out).toMatchObject({ inserted: 2, duplicates: 1, linked: 0 });
    const rows = await db.select().from(transactions);
    expect(rows.map((t) => t.description).sort()).toEqual(["COMCAST", "Jane rent", "SALLY BEAUTY"]);
    expect(rows.filter((t) => t.importBatchId === again.batch.id)).toHaveLength(2);
  });

  it("previews exactly what the undo then removes", async () => {
    await db.insert(transactions).values({ ...bankRow, bankAccountId: acctId });
    const { batch } = await commit(
      "preview.csv",
      [
        "Date,Description,Amount",
        "10/01/2026,RULE HIT,-10.00",
        "10/02/2026,EDITED LATER,-20.00",
        "10/03/2026,SPLIT LATER,500.00",
        "10/04/2026,UNTOUCHED,-1.23",
      ].join("\n"),
      // A category at import time counts as sorted.
      { categorizer: (r) => ({ categoryId: r.description === "RULE HIT" ? supplies : null, stylistId: null }) },
    );
    await db
      .update(transactions)
      .set({ note: "checked", updatedAt: new Date(batch.createdAt.getTime() + 60_000) })
      .where(eq(transactions.description, "EDITED LATER"));
    const [toSplit] = await db.select().from(transactions).where(eq(transactions.description, "SPLIT LATER"));
    await saveSplit(db, toSplit.id, [L(sales, 40000), L(sales, 10000)]);

    const preview = await previewImportUndo(db, batch.id);
    expect(preview).toEqual({ ok: true, filename: "preview.csv", removed: 4, touched: 3, netCents: 46877 });
    expect(await totals()).toMatchObject({ transactions: 5, splits: 2 }); // preview changed nothing

    const before = await totals();
    const result = await undoImport(db, batch.id, userId);
    expect(result).toEqual(preview);
    const after = await totals();
    expect(ok(result).removed).toBe(before.transactions - after.transactions);
    expect(ok(result).netCents).toBe(before.net - after.net);
    expect(after).toEqual({ transactions: 1, net: -1234, splits: 0 });
  });

  function L(categoryId: string, amountCents: number) {
    return { categoryId, stylistId: null, amountCents, memo: null };
  }

  async function hashesPresent(rows: ParsedRow[]) {
    const all = await db.select({ h: transactions.dedupeHash }).from(transactions);
    const present = new Set(all.map((r) => r.h));
    return rows.map((r) => r.dedupeHash).filter((h) => present.has(h));
  }

  function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
    if (!r.ok) throw new Error("expected ok");
    return r as Extract<T, { ok: true }>;
  }
});
