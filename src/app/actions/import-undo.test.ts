/**
 * The server actions around the undo: they authenticate first, validate the id, and refresh the page
 * after every real attempt, a refusal included (so a stale Undo button goes away). The auth, cache and
 * db modules are stubbed; the undo itself runs on PGlite with the real migrations.
 */
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

const { requireUser, refresh, getDb } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  refresh: vi.fn(),
  getDb: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser }));
vi.mock("next/cache", () => ({ refresh }));
vi.mock("@/db", () => ({ getDb }));

import { previewImportUndoAction, undoImportAction } from "./import-undo";

const { transactions, importBatches, users } = schema;

describe("import undo server actions", () => {
  let client: PGlite;
  let db: Db;
  let userId: string;
  let batchId: string;

  beforeAll(async () => {
    client = new PGlite();
    const pg = drizzle(client, { schema });
    await migrate(pg, { migrationsFolder: "./drizzle" });
    db = pg as unknown as Db;
    const [u] = await db.insert(users).values({ email: "a@example.com", name: "A", passwordHash: "x" }).returning({ id: users.id });
    userId = u.id;
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    requireUser.mockReset().mockResolvedValue({ userId });
    refresh.mockReset();
    getDb.mockReset().mockResolvedValue(db);
    await db.delete(transactions);
    await db.delete(importBatches);
    const [b] = await db.insert(importBatches).values({ filename: "a.csv", rowCount: 1, insertedCount: 1, skippedCount: 0, createdBy: userId }).returning({ id: importBatches.id });
    batchId = b.id;
    await db.insert(transactions).values({ date: "2026-10-01", amountCents: -500, description: "ONE", source: "csv", importBatchId: batchId });
  });

  it("checks the session before anything else, and does nothing when it fails", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(undoImportAction(batchId)).rejects.toThrow("NEXT_REDIRECT");
    await expect(previewImportUndoAction(batchId)).rejects.toThrow("NEXT_REDIRECT");
    expect(getDb).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(await db.select().from(transactions)).toHaveLength(1);
  });

  it("rejects a malformed id without touching the database or refreshing", async () => {
    expect(await undoImportAction("not-a-uuid")).toMatchObject({ ok: false, message: expect.stringMatching(/couldn't be found/) });
    expect(await previewImportUndoAction("not-a-uuid")).toMatchObject({ ok: false });
    expect(getDb).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("previews without changing or refreshing", async () => {
    expect(await previewImportUndoAction(batchId)).toMatchObject({ ok: true, removed: 1, filename: "a.csv" });
    expect(refresh).not.toHaveBeenCalled();
    expect(await db.select().from(transactions)).toHaveLength(1);
  });

  it("undoes, records who did it, and refreshes", async () => {
    expect(await undoImportAction(batchId)).toEqual({ ok: true, message: "Removed 1 transaction from a.csv." });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await db.select().from(transactions)).toHaveLength(0);
    const [b] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
    expect(b.undoneBy).toBe(userId);
  });

  it("refreshes on a refusal too: already undone, and a batch that no longer exists", async () => {
    await undoImportAction(batchId);
    refresh.mockClear();
    expect(await undoImportAction(batchId)).toEqual({ ok: false, message: "That import was already undone." });
    expect(refresh).toHaveBeenCalledTimes(1);

    refresh.mockClear();
    expect(await undoImportAction("00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, message: "That import no longer exists." });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
