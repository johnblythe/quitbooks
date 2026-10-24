import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ButtonLink, Empty, Money, PageHeader, Pill, Skeleton } from "@/components/ui";
import { getStylists, requestToday } from "@/lib/data";
import { formatDate } from "@/lib/dates";

export const metadata: Metadata = { title: "Stylists" };

const cadence = { weekly: "/ week", biweekly: "/ 2 weeks", monthly: "/ month" } as const;

export default function StylistsPage() {
  return (
    <>
      <PageHeader title="Stylists" subtitle="Who rents a chair, and what they pay." action={<ButtonLink href="/stylists/new">Add</ButtonLink>} />
      <Suspense fallback={<Skeleton rows={3} />}>
        <StylistList />
      </Suspense>
    </>
  );
}

async function StylistList() {
  const [stylists, today] = await Promise.all([getStylists(), requestToday()]);
  if (!stylists.length) return <Empty>No stylists yet. Add the people renting chairs so rent can be tracked.</Empty>;
  const active = stylists.filter((s) => s.startDate <= today && (!s.endDate || s.endDate >= today));
  const past = stylists.filter((s) => !active.includes(s));

  const list = (items: typeof stylists) => (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {items.map((s) => (
        <li key={s.id}>
          <Link href={`/stylists/${s.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
            <span className="min-w-0">
              <span className="block truncate font-medium">{s.name}</span>
              <span className="text-xs text-ink-2">
                {s.chairLabel ? `${s.chairLabel} · ` : ""}
                {s.endDate ? `Left ${formatDate(s.endDate)}` : `Since ${formatDate(s.startDate)}`}
              </span>
            </span>
            <span className="shrink-0 text-sm">
              <Money cents={s.rentCents} whole={s.rentCents % 100 === 0} />{" "}
              <span className="text-ink-2">{cadence[s.rentCadence]}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-5">
      {active.length ? list(active) : <Empty>No one is renting a chair right now.</Empty>}
      {past.length ? (
        <section>
          <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold uppercase tracking-wide text-ink-2">
            Past & upcoming <Pill>{past.length}</Pill>
          </h2>
          {list(past)}
        </section>
      ) : null}
    </div>
  );
}
