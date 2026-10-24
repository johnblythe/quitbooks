import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Card, Empty, Money, PageHeader, Skeleton, buttonClass, cx, inputClass } from "@/components/ui";
import { getCategories, getMetricTxs, requestToday } from "@/lib/data";
import { formatDate } from "@/lib/dates";
import { computePnl, type PnlLine } from "@/lib/metrics";
import { rangePresets, resolveRange } from "@/lib/report-range";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Reports" };

type Params = { from?: string; to?: string; range?: string };

export default function ReportsPage({ searchParams }: { searchParams: Promise<Params> }) {
  return (
    <>
      <PageHeader title="Profit & loss" subtitle="Tax-ready summary for any date range." />
      <Suspense fallback={<Skeleton rows={3} />}>
        <Report searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Report({ searchParams }: { searchParams: Promise<Params> }) {
  const [params, today] = await Promise.all([searchParams, requestToday()]);
  const { from, to, preset } = resolveRange(params, today);
  const [categories, txs] = await Promise.all([getCategories({ includeArchived: true }), getMetricTxs(from, to)]);
  const pnl = computePnl(txs, categories, from, to);
  const qs = new URLSearchParams({ from, to }).toString();

  return (
    <div className="space-y-4">
      <nav className="no-print -mx-4 flex gap-2 overflow-x-auto px-4 pb-1" aria-label="Date range">
        {rangePresets(today).map((p) => (
          <Link
            key={p.key}
            href={`/reports?range=${p.key}`}
            className={cx(
              "shrink-0 rounded-full border px-3 py-1.5 text-sm",
              p.key === preset ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface text-ink-2",
            )}
          >
            {p.label}
          </Link>
        ))}
      </nav>

      <form className="no-print grid grid-cols-[1fr_1fr_auto] items-end gap-2" action="/reports">
        <label className="text-xs text-ink-2">
          From
          <input type="date" name="from" defaultValue={from} className={cx(inputClass, "mt-1")} />
        </label>
        <label className="text-xs text-ink-2">
          To
          <input type="date" name="to" defaultValue={to} className={cx(inputClass, "mt-1")} />
        </label>
        <button type="submit" className={buttonClass("secondary")}>
          Go
        </button>
      </form>

      <Card>
        <p className="text-xs uppercase tracking-wide text-ink-2">L Marie Studio LLC</p>
        <p className="mt-1 font-serif text-lg">
          {formatDate(from)} – {formatDate(to)}
        </p>

        {pnl.income.length + pnl.expenses.length === 0 ? (
          <div className="mt-4">
            <Empty>No transactions in this range.</Empty>
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            <Section title="Income" lines={pnl.income} total={pnl.totalIncome} />
            <Section title="Expenses" lines={pnl.expenses} total={pnl.totalExpenses} />
            <div className="flex items-baseline justify-between border-t-2 border-ink pt-3">
              <span className="font-semibold">Net {pnl.net >= 0 ? "profit" : "loss"}</span>
              <Money cents={pnl.net} className="text-lg font-semibold" />
            </div>
          </div>
        )}

        {pnl.uncategorizedCount ? (
          <p className="mt-4 rounded-xl bg-warn-bg px-3 py-2 text-sm text-warn">
            {pnl.uncategorizedCount} transaction{pnl.uncategorizedCount === 1 ? " is" : "s are"} uncategorized.{" "}
            <Link href="/inbox" className="no-print underline">
              Sort them
            </Link>{" "}
            before sending this to the accountant.
          </p>
        ) : null}
        <p className="mt-3 text-xs text-ink-2">Owner draws, contributions and transfers are left out of profit and loss.</p>
      </Card>

      <div className="no-print grid grid-cols-2 gap-2">
        <a href={`/reports/export?${qs}&type=summary`} className={buttonClass("secondary")}>
          Summary CSV
        </a>
        <a href={`/reports/export?${qs}&type=detail`} className={buttonClass("secondary")}>
          All transactions CSV
        </a>
        <PrintButton />
      </div>
    </div>
  );
}

function Section({ title, lines, total }: { title: string; lines: PnlLine[]; total: number }) {
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-2">{title}</h2>
      <table className="w-full text-sm">
        <tbody>
          {lines.map((l) => (
            <tr key={l.categoryId} className="border-b border-line">
              <td className={cx("py-2 pr-3", l.name === "Uncategorized" && "text-warn")}>{l.name}</td>
              <td className="py-2 text-right">
                <Money cents={l.cents} />
              </td>
            </tr>
          ))}
          <tr>
            <td className="py-2 pr-3 font-semibold">Total {title.toLowerCase()}</td>
            <td className="py-2 text-right font-semibold">
              <Money cents={total} />
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
