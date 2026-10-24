import Link from "next/link";
import { Suspense } from "react";
import { BankBanner } from "@/components/bank-banner";
import { Meter, ProfitBars } from "@/components/charts";
import { MonthSwitcher, resolveMonth } from "@/components/month-switcher";
import { ButtonLink, Card, Empty, Money, PageHeader, Pill, Skeleton } from "@/components/ui";
import { countUncategorized, getBankConnection, getBoothRentCategoryId, getCategories, getMetricTxs, getSettings, getStylists, requestToday } from "@/lib/data";
import { addMonths, formatDate, formatMonth, monthOf, monthRange, monthStart } from "@/lib/dates";
import {
  currentBalance,
  expensesByCategory,
  monthlySummaries,
  occupancyForMonth,
  rentStatusForMonth,
  runwayMonths,
} from "@/lib/metrics";
import { reconcile } from "@/lib/bank-status";
import { unixToLocalDate } from "@/lib/simplefin";

export default function DashboardPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  return (
    <>
      <PageHeader
        title="How we're doing"
        action={
          <ButtonLink href="/import" variant="secondary">
            Import CSV
          </ButtonLink>
        }
      />
      <Suspense fallback={<Skeleton rows={5} />}>
        <Dashboard searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Dashboard({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const current = monthOf(await requestToday());
  const month = resolveMonth((await searchParams).month, current);
  const trendMonths = monthRange(addMonths(month, -5), month);
  const priorMonths = monthRange(addMonths(month, -3), addMonths(month, -1));

  const [categories, stylists, settings, boothRentId, uncategorized, bank] = await Promise.all([
    getCategories({ includeArchived: true }),
    getStylists(),
    getSettings(),
    getBoothRentCategoryId(),
    countUncategorized(),
    getBankConnection(),
  ]);
  // Balance needs everything since the opening balance date; trends need the last ~9 months.
  const since = [settings.openingBalance?.asOf, monthStart(addMonths(month, -8))].filter(Boolean).sort()[0];
  const txs = await getMetricTxs(since);

  const trend = monthlySummaries(txs, categories, trendMonths);
  const thisMonth = trend[trend.length - 1];
  const lastMonth = trend[trend.length - 2];
  const prior = monthlySummaries(txs, categories, priorMonths);
  const rent = rentStatusForMonth(stylists, txs, boothRentId, month);
  const occupancy = occupancyForMonth(stylists, settings.totalChairs, month);
  const expenseRows = expensesByCategory(txs, categories, [...priorMonths, month]);
  const balance = settings.openingBalance ? currentBalance(settings.openingBalance, txs) : null;
  const runway = balance !== null ? runwayMonths(balance, prior) : null;

  const bankAccounts = bank?.accounts.filter((a) => a.include && a.balanceCents !== null) ?? [];
  const bankCents = bankAccounts.length ? bankAccounts.reduce((s, a) => s + (a.balanceCents ?? 0), 0) : null;
  const bankDates = bankAccounts.flatMap((a) => (a.balanceDate ? [a.balanceDate.getTime()] : []));
  const bankAsOf = bankDates.length ? unixToLocalDate(Math.max(...bankDates) / 1000) : null;
  const recon = bankCents !== null && balance !== null ? reconcile(bankCents, balance) : null;

  const rentExpected = rent.reduce((s, r) => s + r.expected, 0);
  const rentCollected = rent.reduce((s, r) => s + r.collected, 0);
  const isCurrent = month === current;

  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <MonthSwitcher month={month} basePath="/" current={current} />
      </div>

      <BankBanner />

      {uncategorized > 0 ? (
        <Link
          href="/inbox"
          className="flex items-center justify-between rounded-2xl bg-warn-bg px-4 py-3 text-sm text-warn"
        >
          <span>
            <strong>{uncategorized}</strong> transaction{uncategorized === 1 ? "" : "s"} need a category
          </span>
          <span aria-hidden="true">→</span>
        </Link>
      ) : null}

      <Card>
        <p className="text-sm text-ink-2">
          Profit {isCurrent ? "so far this month" : `in ${formatMonth(month)}`}
        </p>
        <p className="mt-1 font-serif text-4xl">
          <Money cents={thisMonth.profit} colored whole />
        </p>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-ink-2">In</dt>
            <dd>
              <Money cents={thisMonth.income} whole />
            </dd>
          </div>
          <div>
            <dt className="text-ink-2">Out</dt>
            <dd>
              <Money cents={thisMonth.expenses} whole />
            </dd>
          </div>
          <div>
            <dt className="text-ink-2">vs {formatMonth(lastMonth.month, "short").split(" ")[0]}</dt>
            <dd>
              <Money cents={thisMonth.profit - lastMonth.profit} colored signed whole />
            </dd>
          </div>
        </dl>
        <div className="mt-4">
          <ProfitBars months={trend} highlight={month} />
        </div>
      </Card>

      <Card
        title="Booth rent"
        action={
          <Link href="/stylists" className="text-sm text-accent">
            Stylists
          </Link>
        }
      >
        {rent.length === 0 ? (
          <Empty>
            Add your stylists to track rent. <Link href="/stylists/new" className="text-accent underline">Add one</Link>
          </Empty>
        ) : (
          <>
            <div className="mb-3 flex items-baseline justify-between text-sm">
              <span>
                <Money cents={rentCollected} whole /> <span className="text-ink-2">of</span>{" "}
                <Money cents={rentExpected} whole /> <span className="text-ink-2">collected</span>
              </span>
            </div>
            <Meter value={rentCollected} max={rentExpected} tone={rentCollected >= rentExpected ? "good" : "accent"} />
            <ul className="mt-3 divide-y divide-line">
              {rent.map((r) => (
                <li key={r.stylistId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0 truncate">{r.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-ink-2">
                      <Money cents={r.collected} whole /> / <Money cents={r.expected} whole />
                    </span>
                    {r.status === "paid" ? (
                      <Pill tone="good">Paid</Pill>
                    ) : r.status === "ahead" ? (
                      <Pill tone="good">Ahead</Pill>
                    ) : r.status === "behind" ? (
                      <Pill tone={isCurrent ? "warn" : "bad"}>
                        {isCurrent ? "Due" : "Short"} <Money cents={-r.balance} whole className="ml-1" />
                      </Pill>
                    ) : (
                      <Pill>Not due</Pill>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {isCurrent && rent.some((r) => r.status === "behind") ? (
              <p className="mt-2 text-xs text-ink-2">“Due” includes payments scheduled later this month.</p>
            ) : null}
          </>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Chairs filled">
          {occupancy.total === 0 ? (
            <Empty>
              Set your chair count in <Link href="/settings" className="text-accent underline">Settings</Link>.
            </Empty>
          ) : (
            <>
              <p className="font-serif text-3xl">
                {occupancy.filled}
                <span className="text-lg text-ink-2"> / {occupancy.total}</span>
              </p>
              <div className="mt-3">
                <Meter value={occupancy.filled} max={occupancy.total} />
              </div>
              <p className="mt-2 text-sm text-ink-2">
                {occupancy.total - occupancy.filled > 0
                  ? `${occupancy.total - occupancy.filled} open chair${occupancy.total - occupancy.filled === 1 ? "" : "s"}`
                  : "Every chair is rented"}
              </p>
            </>
          )}
        </Card>

        <Card title="Cash runway">
          {balance === null && bankCents !== null ? (
            <p className="mb-3 text-sm text-ink-2">
              BMO says <Money cents={bankCents} whole />
              {bankAsOf ? ` (as of ${formatDate(bankAsOf)})` : ""}
            </p>
          ) : null}
          {balance === null ? (
            <Empty>
              Add your bank balance in <Link href="/settings" className="text-accent underline">Settings</Link> to see this.
            </Empty>
          ) : (
            <>
              <p className="font-serif text-3xl">
                {runway === null ? "—" : runway >= 24 ? "24+" : runway.toFixed(1)}
                <span className="text-lg text-ink-2"> months</span>
              </p>
              <p className="mt-2 text-sm text-ink-2">
                <Money cents={balance} whole /> in the bank covers this long at recent spending if rent stopped.
              </p>
              {recon ? (
                <p className="mt-3 border-t border-line pt-3 text-sm text-ink-2">
                  BMO says <Money cents={recon.bankCents} />
                  {bankAsOf ? ` (as of ${formatDate(bankAsOf)})` : ""} · Books say <Money cents={recon.booksCents} />{" "}
                  {recon.kind === "match" ? (
                    <span className="text-good" aria-label="Books match the bank">
                      ✓
                    </span>
                  ) : (
                    <Link href="/transactions" className="text-bad underline">
                      Off by <Money cents={Math.abs(recon.diffCents)} />
                    </Link>
                  )}
                </p>
              ) : null}
            </>
          )}
        </Card>
      </div>

      <Card title="Where the money goes" action={<span className="text-xs text-ink-2">vs 3-mo avg</span>}>
        {expenseRows.length === 0 ? (
          <Empty>No expenses yet.</Empty>
        ) : (
          <ul className="space-y-3">
            {expenseRows.slice(0, 8).map((row) => {
              const now = row.byMonth[month] ?? 0;
              const avg = priorMonths.reduce((s, m) => s + (row.byMonth[m] ?? 0), 0) / priorMonths.length;
              const top = Math.max(...expenseRows.map((r) => r.byMonth[month] ?? 0), 1);
              const diff = now - avg;
              return (
                <li key={row.categoryId} className="text-sm">
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <span className="truncate">{row.name}</span>
                    <span className="shrink-0">
                      <Money cents={now} whole />
                      {avg > 0 ? (
                        <span className={`ml-2 text-xs ${diff > avg * 0.15 ? "text-bad" : "text-ink-2"}`}>
                          {diff >= 0 ? "+" : ""}
                          {Math.round((diff / avg) * 100)}%
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <Meter value={now} max={top} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
