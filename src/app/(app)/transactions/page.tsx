import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { MonthSwitcher, resolveMonth } from "@/components/month-switcher";
import { ButtonLink, Card, Empty, Money, PageHeader, Pill, Skeleton } from "@/components/ui";
import { getTransactionsForMonth, requestToday } from "@/lib/data";
import { formatDate, monthOf } from "@/lib/dates";

export const metadata: Metadata = { title: "Transactions" };

export default function TransactionsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  return (
    <>
      <PageHeader
        title="Money in & out"
        action={
          <div className="flex gap-2">
            <ButtonLink href="/import" variant="secondary">
              Import
            </ButtonLink>
            <ButtonLink href="/transactions/new">Add</ButtonLink>
          </div>
        }
      />
      <Suspense fallback={<Skeleton rows={4} />}>
        <TransactionList searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function TransactionList({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const current = monthOf(await requestToday());
  const month = resolveMonth((await searchParams).month, current);
  const rows = await getTransactionsForMonth(month);

  const moneyIn = rows.filter((r) => r.amountCents > 0 && r.categoryKind !== "transfer").reduce((s, r) => s + r.amountCents, 0);
  const moneyOut = rows.filter((r) => r.amountCents < 0 && r.categoryKind !== "transfer").reduce((s, r) => s - r.amountCents, 0);

  // Group by date for a phone-friendly list.
  const byDate = new Map<string, typeof rows>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);

  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <MonthSwitcher month={month} basePath="/transactions" current={current} />
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <Card>
          <p className="text-ink-2">In</p>
          <p className="mt-1 text-lg">
            <Money cents={moneyIn} />
          </p>
        </Card>
        <Card>
          <p className="text-ink-2">Out</p>
          <p className="mt-1 text-lg">
            <Money cents={moneyOut} />
          </p>
        </Card>
      </div>

      {rows.length === 0 ? (
        <Empty>
          Nothing recorded this month. <Link href="/import" className="text-accent underline">Import a CSV</Link> or{" "}
          <Link href="/transactions/new" className="text-accent underline">add one</Link>.
        </Empty>
      ) : (
        [...byDate.entries()].map(([date, items]) => (
          <section key={date}>
            <h2 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-ink-2">{formatDate(date)}</h2>
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {items.map((tx) => (
                <li key={tx.id}>
                  <Link href={`/transactions/${tx.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{tx.description}</span>
                      <span className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-ink-2">
                        {tx.categoryName ? <span>{tx.categoryName}</span> : <Pill tone="warn">Needs category</Pill>}
                        {tx.stylistName ? <span>· {tx.stylistName}</span> : null}
                      </span>
                    </span>
                    <Money
                      cents={tx.amountCents}
                      signed
                      className={tx.amountCents > 0 ? "shrink-0 text-good" : "shrink-0"}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
