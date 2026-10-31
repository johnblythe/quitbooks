import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signSession,
  verifySessionToken,
  type SessionPayload,
} from "./session-token";

export async function createSession(payload: SessionPayload) {
  const token = await signSession(payload);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function deleteSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * Verifies the cookie signature, then loads the user and checks the session version, so deleted
 * users and revoked sessions (`user:add` on an existing email bumps session_version) are rejected.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const db = await getDb();
  const [user] = await db
    .select({ name: schema.users.name, sessionVersion: schema.users.sessionVersion })
    .from(schema.users)
    .where(eq(schema.users.id, session.userId));
  if (!user || user.sessionVersion !== session.sv) return null;
  return { userId: session.userId, name: user.name, sv: user.sessionVersion };
}

/**
 * Use at the top of every Server Action and Route Handler. The proxy already guards pages,
 * but actions and handlers must authorize themselves rather than trust the client.
 */
export async function requireUser(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * The page-side check (Data Access Layer): every read in src/lib/data.ts runs it, so a revoked or
 * deleted user's still-signed cookie renders nothing and is sent to /login. Memoized per render
 * pass, so a page with several reads looks the user up once. Request-time (reads cookies): call it
 * only inside a <Suspense> boundary, like the reads themselves.
 */
export const verifySession = cache(requireUser);
