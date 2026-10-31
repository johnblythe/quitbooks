/**
 * Login throttling on PGlite (real migrations). The parallel cases are the race the pre-check had:
 * every request counted before any of them was recorded, so all of them got a scrypt guess.
 */
import { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { beginLoginAttempt, clearLoginFailures } from "./login-attempts";
import { MAX_EMAIL_FAILURES, MAX_IP_FAILURES } from "./login-throttle";

const t = schema.loginAttempts;
let client: PGlite;
let db: Db;

const rows = async () => (await db.select({ n: count() }).from(t))[0].n;

beforeAll(async () => {
  client = new PGlite();
  const pg = drizzle(client, { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  db = pg as unknown as Db;
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(t);
});

describe("beginLoginAttempt", () => {
  it("allows 5 failures from one IP, then throttles without recording the throttled tries", async () => {
    for (let i = 0; i < MAX_IP_FAILURES; i++) expect(await beginLoginAttempt("a@x.test", "1.1.1.1", db)).not.toBeNull();
    expect(await beginLoginAttempt("a@x.test", "1.1.1.1", db)).toBeNull();
    expect(await beginLoginAttempt("b@x.test", "1.1.1.1", db)).toBeNull();
    expect(await rows()).toBe(MAX_IP_FAILURES);
    // Another IP can still try that email.
    expect(await beginLoginAttempt("a@x.test", "2.2.2.2", db)).not.toBeNull();
  });

  it("parallel attempts from one IP never exceed the IP cap", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => beginLoginAttempt("a@x.test", "1.1.1.1", db)));
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(MAX_IP_FAILURES);
    expect(await rows()).toBeLessThanOrEqual(MAX_IP_FAILURES);
  });

  it("parallel attempts on one email from many IPs never exceed the email cap", async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => beginLoginAttempt("owner@x.test", `10.0.0.${i}`, db)),
    );
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(MAX_EMAIL_FAILURES);
    // Sequentially after the burst, the email is still capped.
    for (let i = 0; i < MAX_EMAIL_FAILURES; i++) await beginLoginAttempt("owner@x.test", `10.1.0.${i}`, db);
    expect(await beginLoginAttempt("owner@x.test", "10.2.0.1", db)).toBeNull();
    const [n] = await db.select({ n: count() }).from(t).where(eq(t.email, "owner@x.test"));
    expect(n.n).toBe(MAX_EMAIL_FAILURES);
  });

  it("a successful login clears the email's failures, including its own attempt", async () => {
    for (let i = 0; i < 3; i++) await beginLoginAttempt("a@x.test", "1.1.1.1", db);
    expect(await beginLoginAttempt("a@x.test", "1.1.1.1", db)).not.toBeNull();
    await clearLoginFailures("a@x.test", db);
    expect(await rows()).toBe(0);
  });
});
