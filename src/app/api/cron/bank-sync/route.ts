import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { suggestCategories } from "@/lib/ai-suggest-server";
import { syncAllConnections } from "@/lib/bank-sync-server";

/** Constant-time check of `Authorization: Bearer ${CRON_SECRET}`. Unset secret never authorizes. */
function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Vercel Cron calls this daily. Returns counts only. */
export async function GET(request: NextRequest) {
  if (!authorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = await getDb();
  const counts = await syncAllConnections({ db });
  // Best-effort category suggestions for whatever is still uncategorized. Never throws.
  const suggestions = await suggestCategories({ db });
  return NextResponse.json({ ...counts, suggestions });
}
