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

  const { migrate } = await import("drizzle-orm/neon-http/migrator");
  const db = drizzle(neon(url), { schema });
  return { db, migrate: () => migrate(db, { migrationsFolder: "./drizzle" }), close: async () => {} };
}
