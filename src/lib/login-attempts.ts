import "server-only";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { RETENTION_DAYS, WINDOW_MINUTES, isThrottled } from "./login-throttle";

const t = schema.loginAttempts;

/** True when this email or this IP has too many recent failures. Run before any scrypt work. */
export async function isLoginThrottled(email: string, ip: string): Promise<boolean> {
  const db = await getDb();
  const since = sql`now() - make_interval(mins => ${WINDOW_MINUTES})`;
  const count = async (col: typeof t.email | typeof t.ip, value: string) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(and(eq(col, value), eq(t.ok, false), gt(t.at, since)));
    return row?.n ?? 0;
  };
  const [emailFailures, ipFailures] = await Promise.all([count(t.email, email), count(t.ip, ip)]);
  return isThrottled({ emailFailures, ipFailures });
}

export async function recordLoginFailure(email: string, ip: string): Promise<void> {
  const db = await getDb();
  await db.insert(t).values({ email: email.slice(0, 254), ip, ok: false });
  // Opportunistic cleanup so the table stays tiny.
  await db.delete(t).where(lt(t.at, sql`now() - make_interval(days => ${RETENTION_DAYS})`));
}

export async function clearLoginFailures(email: string): Promise<void> {
  const db = await getDb();
  await db.delete(t).where(and(eq(t.email, email), eq(t.ok, false)));
}
