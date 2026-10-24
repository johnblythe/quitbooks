import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

let dbPromise: Promise<Db> | null = null;

/**
 * Returns the database client.
 *
 * - Production / Vercel: DATABASE_URL is a Neon connection string (uses the Neon HTTP driver).
 * - Local dev with no Neon: set DATABASE_URL=pglite:./.pglite to use an embedded Postgres on disk.
 *   PGlite is a dev dependency and is only loaded in that case.
 */
export function getDb(): Promise<Db> {
  if (!dbPromise) dbPromise = createDb();
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
    // Same query-builder API as the Neon driver; the cast keeps one Db type across the app.
    return drizzlePglite(client, { schema }) as unknown as Db;
  }

  return drizzle(neon(url), { schema });
}

export { schema };
