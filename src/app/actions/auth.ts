"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import { createSession, deleteSession } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";

/** `email` is echoed back so the field keeps its value after a failed attempt (React resets the form). */
export type LoginState = { error?: string; email?: string } | undefined;

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (!email || !password) return { error: "Enter your email and password.", email };

  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  // Same message either way, so the form doesn't reveal which emails exist.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return { error: "That email and password don't match.", email };
  }

  await createSession({ userId: user.id, name: user.name });
  // Only allow same-site relative redirects.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logout() {
  await deleteSession();
  redirect("/login");
}
