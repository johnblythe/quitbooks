import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { deleteTransactionRow, isFeedLinked, updateTransactionRow } from "./transaction-guards";

const { transactions } = schema;
let client: PGlite;
let db: Db;

beforeAll(async () => {
  client = new PGlite();
  const pg = drizzle(client, { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  db = pg as unknown as Db;
});
afterAll(async () => {
  await client.close();
});

let n = 0;
const add = async (source: "manual" | "csv" | "bank_sync", linked = source === "bank_sync") =>
  (
    await db
      .insert(transactions)
      .values({ date: "2026-10-01", amountCents: -100, description: source, source, externalId: linked ? `ext-${++n}` : null })
      .returning()
  )[0];
const row = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0];
const edit = { date: "2026-10-01", amountCents: -100, description: "renamed", note: "n", categoryId: null, stylistId: null };
const missingId = "123e4567-e89b-42d3-a456-426614174000";

describe("feed-linked rows", () => {
  it("are rows with a bank externalId, whatever the source", () => {
    expect(isFeedLinked({ externalId: "x" })).toBe(true);
    expect(isFeedLinked({ externalId: null })).toBe(false);
  });

  it("manual and CSV rows can be deleted", async () => {
    for (const source of ["manual", "csv"] as const) {
      const tx = await add(source);
      expect(await deleteTransactionRow(db, tx.id)).toBe("ok");
      expect(await row(tx.id)).toBeUndefined();
    }
  });

  it("feed rows and feed-matched manual entries can't be deleted", async () => {
    for (const tx of [await add("bank_sync"), await add("manual", true)]) {
      expect(await deleteTransactionRow(db, tx.id)).toBe("feed_linked");
      expect(await row(tx.id)).toBeDefined();
    }
  });

  it("deleting a row that's already gone says so", async () => {
    expect(await deleteTransactionRow(db, missingId)).toBe("missing");
  });

  it("a feed-linked row keeps its amount and date, but the rest can change", async () => {
    const tx = await add("manual", true);
    expect(await updateTransactionRow(db, tx.id, { ...edit, amountCents: -999 })).toBe("feed_linked");
    expect(await updateTransactionRow(db, tx.id, { ...edit, date: "2026-10-02" })).toBe("feed_linked");
    expect((await row(tx.id)).description).toBe("manual");
    expect(await updateTransactionRow(db, tx.id, edit)).toBe("ok");
    expect(await row(tx.id)).toMatchObject({ description: "renamed", note: "n", amountCents: -100, date: "2026-10-01" });
  });

  it("other rows can change everything", async () => {
    const tx = await add("csv");
    expect(await updateTransactionRow(db, tx.id, { ...edit, amountCents: -999, date: "2026-10-03" })).toBe("ok");
    expect(await row(tx.id)).toMatchObject({ amountCents: -999, date: "2026-10-03" });
    expect(await updateTransactionRow(db, missingId, edit)).toBe("missing");
  });
});
