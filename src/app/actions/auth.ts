"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import { createSession, deleteSession } from "@/lib/auth";
import { clearLoginFailures, isLoginThrottled, recordLoginFailure } from "@/lib/login-attempts";
import { THROTTLE_MESSAGE, clientIp } from "@/lib/login-throttle";
import { DUMMY_HASH, verifyPassword } from "@/lib/password";
import { safeNextPath } from "@/lib/safe-next";

/** `email` is echoed back so the field keeps its value after a failed attempt (React resets the form). */
export type LoginState = { error?: string; email?: string } | undefined;

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(String(formData.get("next") ?? "/"));

  if (!email || !password) return { error: "Enter your email and password.", email };

  const ip = clientIp((await headers()).get("x-forwarded-for"));

  // Check first, so a throttled attempt costs a couple of cheap queries instead of a scrypt run.
  if (await isLoginThrottled(email, ip)) return { error: THROTTLE_MESSAGE, email };

  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  // Always run scrypt (against a dummy hash for unknown emails) so timing doesn't reveal which emails exist.
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    await recordLoginFailure(email, ip);
    // Same message either way, so the form doesn't reveal which emails exist.
    return { error: "That email and password don't match.", email };
  }

  await clearLoginFailures(email);
  await createSession({ userId: user.id, name: user.name, sv: user.sessionVersion });
  redirect(next);
}

export async function logout() {
  await deleteSession();
  redirect("/login");
}
