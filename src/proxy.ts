import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session-token";

/**
 * Sends anyone without a validly signed session to /login. Stateless on purpose: it does not
 * touch the DB. The full check (user exists, session not revoked) runs in every page data read
 * (verifySession in src/lib/data.ts) and in every action and handler via requireUser()/getSession().
 */
export async function proxy(request: NextRequest) {
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  const url = new URL("/login", request.url);
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next && next !== "/") url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

/**
 * Skips only: /login and /login/..., exactly /api/cron/bank-sync (authenticates itself with CRON_SECRET), _next/static, _next/image, and root-level metadata files
 * (favicon.ico, icon*, apple-icon*, manifest*). Every exclusion is anchored, so dynamic app
 * routes that merely end in .png/.svg or start with "login"/"icon" are still guarded.
 * Must stay a literal: Next reads it statically. Tested in proxy.test.ts.
 */
export const config = {
  matcher: [
    "/((?!login$|login/|api/cron/bank-sync$|_next/static/|_next/image$|favicon\\.ico$|icon\\d*\\.(?:ico|png|jpg|jpeg|svg)$|apple-icon\\d*\\.(?:png|jpg|jpeg)$|manifest\\.(?:json|webmanifest)$).*)",
  ],
};
