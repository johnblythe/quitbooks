/**
 * Session token signing/verification. Kept free of `next/headers` so the proxy can use it too.
 * Signature-only: whether the user still exists and `sv` still matches is checked server-side
 * in auth.ts (getSession / requireUser).
 */
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "lm_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** `sv` is users.session_version at sign-in; bumping it in the DB revokes the session. */
export type SessionPayload = { userId: string; name: string; sv: number };

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters.");
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(key());
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (typeof payload.userId !== "string" || typeof payload.name !== "string") return null;
    // Tokens minted before session versions existed have no `sv`; treat them as signed out.
    if (typeof payload.sv !== "number" || !Number.isInteger(payload.sv)) return null;
    return { userId: payload.userId, name: payload.name, sv: payload.sv };
  } catch {
    return null;
  }
}
