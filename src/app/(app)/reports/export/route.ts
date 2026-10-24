import { NextResponse, type NextRequest } from "next/server";
import Papa from "papaparse";
import { getSession } from "@/lib/auth";
import { getCategories, getMetricTxs, getTransactionsInRange } from "@/lib/data";
import { todayIso } from "@/lib/dates";
import { computePnl } from "@/lib/metrics";
import { resolveRange } from "@/lib/report-range";

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** Stops spreadsheet apps from treating bank text like "=HYPERLINK(...)" as a formula. */
const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export async function GET(request: NextRequest) {
  if (!(await getSession())) return new NextResponse("Unauthorized", { status: 401 });

  const sp = request.nextUrl.searchParams;
  const { from, to } = resolveRange({ from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }, todayIso());
  const type = sp.get("type") === "detail" ? "detail" : "summary";

  let csv: string;
  if (type === "detail") {
    const rows = await getTransactionsInRange(from, to);
    csv = Papa.unparse(
      rows.map((r) => ({
        Date: r.date,
        Description: safeText(r.description),
        Amount: dollars(r.amountCents),
        Category: safeText(r.categoryName ?? "Uncategorized"),
        Type: r.categoryKind ?? (r.amountCents >= 0 ? "income" : "expense"),
        Stylist: safeText(r.stylistName ?? ""),
        Note: safeText(r.note ?? ""),
      })),
    );
  } else {
    const [categories, txs] = await Promise.all([getCategories({ includeArchived: true }), getMetricTxs(from, to)]);
    const pnl = computePnl(txs, categories, from, to);
    csv = Papa.unparse([
      ["Section", "Category", "Amount"],
      ...pnl.income.map((l) => ["Income", safeText(l.name), dollars(l.cents)]),
      ["Income", "Total income", dollars(pnl.totalIncome)],
      ...pnl.expenses.map((l) => ["Expenses", safeText(l.name), dollars(l.cents)]),
      ["Expenses", "Total expenses", dollars(pnl.totalExpenses)],
      ["Net", "Net profit (loss)", dollars(pnl.net)],
    ]);
  }

  const filename = `lmarie-${type === "detail" ? "transactions" : "pnl"}-${from}-to-${to}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
