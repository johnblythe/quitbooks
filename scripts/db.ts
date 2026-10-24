/** Shared DB setup for CLI scripts (migrate, seed, add-user, demo data). */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db";

export async function scriptDb(): Promise<{ db: Db; migrate: () => Promise<void>; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example).");

  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite(url.slice("pglite:".length));
    const db = drizzlePglite(client, { schema });
    return {
      db: db as unknown as Db,
      migrate: () => migrate(db, { migrationsFolder: "./drizzle" }),
      close: () => client.close(),
    };
  }

  const db = drizzle(neon(url), { schema });
  return { db, migrate: () => migrateNeon(process.env.DATABASE_URL_UNPOOLED || url), close: async () => {} };
}

/**
 * The neon-http migrator runs each statement as its own request, so a failed run can leave a
 * half-applied schema. Migrate over a WebSocket Pool instead: all pending migrations run in one
 * transaction, same as PGlite. Prefers the direct (unpooled) URL; Node 22's global WebSocket is used.
 */
async function migrateNeon(url: string) {
  const { Pool } = await import("@neondatabase/serverless");
  const { drizzle: drizzlePool } = await import("drizzle-orm/neon-serverless");
  const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzlePool(pool, { schema }), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}
