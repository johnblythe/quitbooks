/** Shared DB setup for CLI scripts (migrate, seed, add-user, demo data). */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
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

  const pool = new Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema });
  return {
    db,
    migrate: () => migrateNode(process.env.DATABASE_URL_UNPOOLED || url),
    close: () => pool.end(),
  };
}

/**
 * Migrates over the direct (unpooled) URL when one is set. The node-postgres migrator runs all
 * pending migrations in a single transaction, same as PGlite, so a failed run leaves nothing behind.
 */
async function migrateNode(url: string) {
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool, { schema }), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}
