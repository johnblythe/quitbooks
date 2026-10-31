import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { withVerifyFull } from "@/lib/pg-url";
import * as schema from "./schema";

/**
 * One Db type for both drivers. Production uses node-postgres; local dev can use PGlite (cast to
 * the same type). Both support `db.transaction(...)`. Neither exposes `db.batch`, so there is no
 * driver-specific footgun left: use `db.transaction` for anything that must be atomic.
 */
export type Db = NodePgDatabase<typeof schema>;

let dbPromise: Promise<Db> | null = null;

/**
 * Returns the database client.
 *
 * - Production / Vercel: DATABASE_URL is the pooled Neon connection string (node-postgres Pool,
 *   registered with Vercel Fluid compute so idle connections are released before the instance freezes).
 * - Local dev with no Neon: set DATABASE_URL=pglite:./.pglite to use an embedded Postgres on disk.
 *   PGlite is a dev dependency and is only loaded in that case.
 */
export function getDb(): Promise<Db> {
  if (!dbPromise) {
    // Never cache a rejected promise: a transient failure must not poison this instance.
    const p = createDb();
    dbPromise = p;
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
  }
  return dbPromise;
}

async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Use a Neon connection string, or pglite:./.pglite for local dev.",
    );
  }

  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
    const client = new PGlite(url.slice("pglite:".length));
    return drizzlePglite(client, { schema }) as unknown as Db;
  }

  const pool = new Pool({ connectionString: withVerifyFull(url), max: 5 });
  // An idle client erroring (e.g. Neon scale-to-zero closing it) must not crash the process.
  pool.on("error", (err) => console.error("Postgres pool error:", err.message));
  attachDatabasePool(pool);
  return drizzle(pool, { schema });
}

export { schema };
