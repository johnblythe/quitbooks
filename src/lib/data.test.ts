/**
 * Every page read re-checks the session before it touches the database, so a revoked cookie that
 * still has a valid signature (the proxy only checks that) renders no data.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifySession, openDb } = vi.hoisted(() => ({
  verifySession: vi.fn(),
  openDb: vi.fn(),
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("./auth", () => ({ verifySession }));
vi.mock("@/db", async () => ({ getDb: openDb, schema: await import("@/db/schema") }));

import * as data from "./data";

beforeEach(() => {
  verifySession.mockReset().mockRejectedValue(new Error("NEXT_REDIRECT /login"));
  openDb.mockReset();
});

describe("data access layer", () => {
  const reads = Object.entries(data as Record<string, unknown>).filter(
    (e): e is [string, (...a: unknown[]) => Promise<unknown>] => typeof e[1] === "function",
  );

  it("exports the reads this test covers", () => {
    expect(reads.length).toBeGreaterThanOrEqual(18);
  });

  it.each(reads)("%s redirects a failed session check before opening the database", async (_name, read) => {
    await expect(read("2026-10", "2026-10-31")).rejects.toThrow("NEXT_REDIRECT");
    expect(verifySession).toHaveBeenCalled();
    expect(openDb).not.toHaveBeenCalled();
  });
});
