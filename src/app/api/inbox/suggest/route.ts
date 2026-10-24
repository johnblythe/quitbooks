import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { suggestForGroups } from "@/lib/ai-suggest-server";
import { getSession } from "@/lib/auth";
import { isSameOrigin, suggestGroupsInput } from "@/lib/suggest-request";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Inbox lazy suggestions over a Route Handler (not a Server Action) so chunks run in parallel and
 * never queue the user's Sort/Save submissions. Stores suggestions only; never sorts.
 * POST handlers are request-time (never prerendered or cached).
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  if (!(await getSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
  }
  const parsed = suggestGroupsInput.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });

  const result = await suggestForGroups({ db: await getDb(), groups: parsed.data });
  return NextResponse.json(result, { headers: NO_STORE });
}
