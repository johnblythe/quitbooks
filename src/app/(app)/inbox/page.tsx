import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { applyRulesToUncategorized, categorizeGroup, categorizeTransaction } from "@/app/actions/transactions";
import { BankBanner } from "@/components/bank-banner";
import { Button, Card, Empty, Money, PageHeader, Skeleton, inputClass } from "@/components/ui";
import type { TxRow } from "@/lib/data";
import { CategoryPicker, SuggestStatus, SuggestionsProvider } from "./suggestions";
import { INBOX_LIMIT, getCategories, getInboxRows, getStylists } from "@/lib/data";
import { majoritySuggestion } from "@/lib/ai-suggest";
import { suggestPattern } from "@/lib/categorize";
import { formatDate } from "@/lib/dates";
import { groupInbox, type InboxGroup } from "@/lib/inbox";
import type { SuggestItem } from "@/lib/inbox-suggest";

export const metadata: Metadata = { title: "Inbox" };

export default function InboxPage() {
  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Transactions that still need a category."
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <form action={applyRulesToUncategorized}>
              <Button type="submit" variant="secondary" className="min-h-10">
                Re-run rules
              </Button>
            </form>
          </div>
        }
      />
      <Suspense fallback={<Skeleton rows={4} />}>
        <InboxList />
      </Suspense>
    </>
  );
}

type Stylist = Awaited<ReturnType<typeof getStylists>>[number];

async function InboxList() {
  const [inbox, categories, stylists] = await Promise.all([getInboxRows(), getCategories(), getStylists()]);
  const { rows } = inbox;
  if (!rows.length) {
    return (
      <div className="space-y-4">
        <BankBanner />
        <Empty>All caught up. Nice.</Empty>
      </div>
    );
  }
  const { groups, oneOffs } = groupInbox(rows);
  // Display order: groups, then one-offs (keyed by row id). Seeds the lazy suggestion runner.
  const items: SuggestItem[] = [
    ...groups.map((g) => ({
      key: g.key,
      ids: g.ids,
      categoryId: majoritySuggestion(
        g.rows.map((r) => r.suggestedCategoryId),
        categories,
        g.direction,
      ),
      needsAsking: g.rows.some((r) => !r.suggestedAt),
    })),
    ...oneOffs.map((tx) => ({
      key: tx.id,
      ids: [tx.id],
      categoryId: majoritySuggestion([tx.suggestedCategoryId], categories, tx.amountCents > 0 ? "in" : "out"),
      needsAsking: !tx.suggestedAt,
    })),
  ];
  const pickerCategories = categories.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
  }));

  return (
    <SuggestionsProvider items={items} categories={pickerCategories}>
      <div className="space-y-4">
        <BankBanner />
        <p className="text-sm text-ink-2">
          {inbox.total} to sort · {groups.length} {groups.length === 1 ? "group" : "groups"}
        </p>
        <SuggestStatus />
        {inbox.capped ? (
          <p className="rounded-xl bg-warn-bg px-3 py-2 text-sm text-warn">
            Showing the newest {INBOX_LIMIT.toLocaleString("en-US")} of {inbox.total.toLocaleString("en-US")}. Sort these and the
            rest will appear.
          </p>
        ) : null}
        {groups.length ? (
          <ul className="space-y-3">
            {groups.map((g) => (
              <li key={g.key}>
                <GroupCard group={g} stylists={stylists} />
              </li>
            ))}
          </ul>
        ) : null}
        {oneOffs.length ? (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-2">One-offs ({oneOffs.length})</h2>
            <ul className="space-y-3">
              {oneOffs.map((tx) => (
                <li key={tx.id}>
                  <OneOffCard tx={tx} stylists={stylists} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </SuggestionsProvider>
  );
}

function GroupCard({ group, stylists }: { group: InboxGroup<TxRow>; stylists: Stylist[] }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-words text-sm font-semibold">{group.pattern}</h3>
        <p className="shrink-0 text-sm text-ink-2">
          {group.count} · <Money cents={group.totalCents} signed className={group.totalCents > 0 ? "text-good" : "text-ink"} />
        </p>
      </div>
      <form action={categorizeGroup} className="mt-3 space-y-2">
        <input type="hidden" name="ids" value={group.ids.join(",")} />
        <input type="hidden" name="direction" value={group.direction} />
        <div className="flex items-end gap-2">
          <CategoryPicker itemKey={group.key} direction={group.direction} />
          <Button type="submit" className="min-h-10 shrink-0">
            Sort {group.count}
          </Button>
        </div>
        {group.direction === "in" && stylists.length ? (
          <select name="stylistId" defaultValue="" className={inputClass} aria-label="Stylist (for booth rent)">
            <option value="">No stylist</option>
            {stylists.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" name="remember" value="1" defaultChecked className="h-4 w-4 accent-[var(--accent)]" />
          <span className="min-w-0 break-words">Remember “{group.pattern}”</span>
        </label>
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-2">Edit matching text</summary>
          <input
            name="pattern"
            defaultValue={group.pattern}
            maxLength={100}
            className={`${inputClass} mt-2`}
            aria-label="Matching text"
          />
        </details>
      </form>
      <details className="mt-1 text-sm">
        <summary className="cursor-pointer py-1 text-ink-2">Show {group.count}</summary>
        <ul className="mt-2 divide-y divide-line">
          {group.rows.map((tx) => (
            <li key={tx.id} className="flex items-start justify-between gap-3 py-1.5">
              <div className="min-w-0">
                <p className="break-words text-xs">{tx.description}</p>
                <p className="text-xs text-ink-2">{formatDate(tx.date)}</p>
              </div>
              <Money
                cents={tx.amountCents}
                signed
                className={tx.amountCents > 0 ? "shrink-0 text-xs text-good" : "shrink-0 text-xs"}
              />
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function OneOffCard({ tx, stylists }: { tx: TxRow; stylists: Stylist[] }) {
  const pattern = suggestPattern(tx.description);
  const direction = tx.amountCents > 0 ? "in" : "out";
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{tx.description}</p>
          <p className="mt-0.5 text-xs text-ink-2">{formatDate(tx.date)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Money cents={tx.amountCents} signed className={tx.amountCents > 0 ? "text-good" : undefined} />
          <Link
            href={`/transactions/${tx.id}/split?from=inbox`}
            className="-my-1 inline-flex min-h-8 items-center text-xs text-accent underline"
          >
            Split
          </Link>
        </div>
      </div>
      <form action={categorizeTransaction} className="mt-3 space-y-2">
        <input type="hidden" name="id" value={tx.id} />
        <input type="hidden" name="direction" value={direction} />
        <div className="flex items-end gap-2">
          <CategoryPicker itemKey={tx.id} direction={direction} />
          <Button type="submit" className="min-h-10 shrink-0">
            Save
          </Button>
        </div>
        {tx.amountCents > 0 && stylists.length ? (
          <select name="stylistId" defaultValue={tx.stylistId ?? ""} className={inputClass} aria-label="Stylist (for booth rent)">
            <option value="">No stylist</option>
            {stylists.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
        {pattern.length >= 3 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-2">Remember for similar transactions</summary>
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="remember" value="1" className="h-4 w-4 accent-[var(--accent)]" />
                Always use this category when the description contains:
              </label>
              <input name="pattern" defaultValue={pattern} maxLength={100} className={inputClass} aria-label="Matching text" />
            </div>
          </details>
        ) : null}
      </form>
    </Card>
  );
}
