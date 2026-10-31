import "server-only";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import { RETENTION_DAYS, WINDOW_MINUTES, isThrottled } from "./login-throttle";

const t = schema.loginAttempts;

type AttemptsDb = Pick<Db, "select" | "insert" | "delete">;

/**
 * Records this attempt as a failure first, then counts recent failures including it, so N parallel
 * requests can't all pass a check made before any of them was written: each one sees every attempt
 * recorded before its own count, so at most the cap gets through. Run before any scrypt work.
 * Returns the attempt id, or null when throttled (the attempt is removed again, so hammering a
 * locked account doesn't extend the lockout). A wrong password leaves the row as the failure; a
 * right one clears it with clearLoginFailures.
 */
export async function beginLoginAttempt(email: string, ip: string, db?: AttemptsDb): Promise<string | null> {
  const d = db ?? (await getDb());
  const key = email.slice(0, 254);
  const [row] = await d.insert(t).values({ email: key, ip, ok: false }).returning({ id: t.id });
  const since = sql`now() - make_interval(mins => ${WINDOW_MINUTES})`;
  const count = async (col: typeof t.email | typeof t.ip, value: string) => {
    const [r] = await d
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(and(eq(col, value), eq(t.ok, false), gt(t.at, since)));
    return r?.n ?? 0;
  };
  const [emailAttempts, ipAttempts] = await Promise.all([count(t.email, key), count(t.ip, ip)]);
  // Minus this attempt: isThrottled takes the failures that came before it.
  if (isThrottled({ emailFailures: emailAttempts - 1, ipFailures: ipAttempts - 1 })) {
    await d.delete(t).where(eq(t.id, row.id));
    return null;
  }
  // Opportunistic cleanup so the table stays tiny.
  await d.delete(t).where(lt(t.at, sql`now() - make_interval(days => ${RETENTION_DAYS})`));
  return row.id;
}

export async function clearLoginFailures(email: string, db?: AttemptsDb): Promise<void> {
  const d = db ?? (await getDb());
  await d.delete(t).where(and(eq(t.email, email.slice(0, 254)), eq(t.ok, false)));
}
