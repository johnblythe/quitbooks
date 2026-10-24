import type { Metadata } from "next";
import { Suspense } from "react";
import { applyRulesToUncategorized, categorizeTransaction } from "@/app/actions/transactions";
import { Button, Card, Empty, Money, PageHeader, Skeleton, inputClass } from "@/components/ui";
import { getCategories, getStylists, getUncategorized } from "@/lib/data";
import { formatDate } from "@/lib/dates";

export const metadata: Metadata = { title: "Inbox" };

/** Suggests a rule pattern: the description minus reference numbers, dates and trailing noise. */
function suggestPattern(description: string): string {
  return description
    .toUpperCase()
    .split(/\s+/)
    .filter((w) => !/\d/.test(w) && w.length > 1)
    .slice(0, 4)
    .join(" ");
}

export default function InboxPage() {
  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Transactions that still need a category."
        action={
          <form action={applyRulesToUncategorized}>
            <Button type="submit" variant="secondary">
              Re-run rules
            </Button>
          </form>
        }
      />
      <Suspense fallback={<Skeleton rows={4} />}>
        <InboxList />
      </Suspense>
    </>
  );
}

async function InboxList() {
  const [rows, categories, stylists] = await Promise.all([getUncategorized(), getCategories(), getStylists()]);
  if (!rows.length) return <Empty>All caught up. Nice.</Empty>;

  return (
    <ul className="space-y-3">
      {rows.map((tx) => {
        const pattern = suggestPattern(tx.description);
        const direction = tx.amountCents > 0 ? "in" : "out";
        const suggestedKind = tx.amountCents > 0 ? "income" : "expense";
        return (
          <li key={tx.id}>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{tx.description}</p>
                  <p className="mt-0.5 text-xs text-ink-2">{formatDate(tx.date)}</p>
                </div>
                <Money cents={tx.amountCents} signed className={tx.amountCents > 0 ? "shrink-0 text-good" : "shrink-0"} />
              </div>
              <form action={categorizeTransaction} className="mt-3 space-y-2">
                <input type="hidden" name="id" value={tx.id} />
                <input type="hidden" name="direction" value={direction} />
                <div className="flex gap-2">
                  <select name="categoryId" required defaultValue="" className={inputClass} aria-label="Category">
                    <option value="" disabled>
                      Pick a category…
                    </option>
                    {[suggestedKind, suggestedKind === "income" ? "expense" : "income", "transfer"].map((kind) => (
                      <optgroup key={kind} label={kind === "income" ? "Money in" : kind === "expense" ? "Money out" : "Transfers"}>
                        {categories
                          .filter((c) => c.kind === kind)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  <Button type="submit" className="shrink-0">
                    Save
                  </Button>
                </div>
                {tx.amountCents > 0 && stylists.length ? (
                  <select name="stylistId" defaultValue="" className={inputClass} aria-label="Stylist (for booth rent)">
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
          </li>
        );
      })}
    </ul>
  );
}
