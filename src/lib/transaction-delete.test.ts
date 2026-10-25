import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { canDeleteTransaction, deleteTransactionRow } from "./transaction-delete";

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

const add = async (source: "manual" | "csv" | "bank_sync") =>
  (await db.insert(transactions).values({ date: "2026-10-01", amountCents: -100, description: source, source }).returning())[0].id;
const exists = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id))).length === 1;

describe("deleting transactions", () => {
  it("deletes manual and CSV rows", async () => {
    for (const source of ["manual", "csv"] as const) {
      const id = await add(source);
      expect(canDeleteTransaction(source)).toBe(true);
      expect(await deleteTransactionRow(db, id)).toBe(true);
      expect(await exists(id)).toBe(false);
    }
  });

  it("refuses bank feed rows (the next sync would bring them back)", async () => {
    const id = await add("bank_sync");
    expect(canDeleteTransaction("bank_sync")).toBe(false);
    expect(await deleteTransactionRow(db, id)).toBe(false);
    expect(await exists(id)).toBe(true);
  });
});
