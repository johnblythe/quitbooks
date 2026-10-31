import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getCategories, getLedgerLinesInRange, getMetricTxs } from "@/lib/data";
import { todayIso } from "@/lib/dates";
import { computePnl } from "@/lib/metrics";
import { detailCsv, summaryCsv } from "@/lib/report-csv";
import { resolveRange } from "@/lib/report-range";

export async function GET(request: NextRequest) {
  if (!(await getSession())) return new NextResponse("Unauthorized", { status: 401 });

  const sp = request.nextUrl.searchParams;
  const { from, to } = resolveRange({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }, todayIso());
  const type = sp.get("type") === "detail" ? "detail" : "summary";

  let csv: string;
  if (type === "detail") {
    // One row per ledger line: a split transaction exports one row per split line.
    csv = detailCsv(await getLedgerLinesInRange(from, to), from, to);
  } else {
    const [categories, txs] = await Promise.all([getCategories({ includeArchived: true }), getMetricTxs(from, to)]);
    csv = summaryCsv(computePnl(txs, categories, from, to), from, to);
  }

  const filename = `lmarie-${type === "detail" ? "transactions" : "pnl"}-cash-basis-${from}-to-${to}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
