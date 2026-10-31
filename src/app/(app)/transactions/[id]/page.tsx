import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { deleteTransaction, updateTransaction } from "@/app/actions/transactions";
import { TransactionForm } from "@/components/transaction-form";
import { Button, ButtonLink, Card, Money, PageHeader, Skeleton } from "@/components/ui";
import { getCategories, getSplitLines, getStylists, getTransaction } from "@/lib/data";
import { monthOf } from "@/lib/dates";
import { FEED_LOCKED_NOTE, isFeedLinked } from "@/lib/transaction-guards";

export const metadata: Metadata = { title: "Edit transaction" };

export default function EditTransactionPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <PageHeader title="Edit transaction" />
      <Suspense fallback={<Skeleton rows={2} />}>
        <EditForm params={params} />
      </Suspense>
    </>
  );
}

async function EditForm({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [tx, categories, stylists, lines] = await Promise.all([
    getTransaction(id),
    getCategories({ includeArchived: true }),
    getStylists(),
    getSplitLines(id),
  ]);
  if (!tx) notFound();
  const splitHref = `/transactions/${tx.id}/split`;
  const feedLinked = isFeedLinked(tx);

  return (
    <div className="space-y-4">
      {tx.isSplit ? (
        <Card
          title={`Split · ${lines.length}`}
          action={
            <ButtonLink href={splitHref} variant="secondary">
              Edit split
            </ButtonLink>
          }
        >
          <ul className="divide-y divide-line">
            {lines.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block break-words">
                    {l.categoryName}
                    {l.stylistName ? <span className="text-ink-2"> · {l.stylistName}</span> : null}
                  </span>
                  {l.memo ? <span className="block break-words text-xs text-ink-2">{l.memo}</span> : null}
                </span>
                <Money cents={l.amountCents} signed className={l.amountCents > 0 ? "shrink-0 text-good" : "shrink-0"} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card>
        <TransactionForm
          action={updateTransaction}
          defaults={tx}
          categories={categories.filter((c) => !c.archived || c.id === tx.categoryId)}
          stylists={stylists.map((s) => ({ id: s.id, name: s.name }))}
          submitLabel="Save changes"
          split={tx.isSplit}
          lockedNote={feedLinked ? FEED_LOCKED_NOTE : undefined}
        />
      </Card>
      {tx.isSplit ? null : (
        <ButtonLink href={splitHref} variant="secondary" className="w-full">
          Split across categories or stylists
        </ButtonLink>
      )}
      {tx.source === "csv" ? (
        <p className="px-1 text-xs text-ink-2">
          Imported from a bank CSV. If you delete it, importing a file that includes it again will add it back.
        </p>
      ) : null}
      {!feedLinked ? (
        <form action={deleteTransaction}>
          <input type="hidden" name="id" value={tx.id} />
          <input type="hidden" name="month" value={monthOf(tx.date)} />
          <Button type="submit" variant="danger" className="w-full">
            Delete transaction
          </Button>
        </form>
      ) : (
        <p className="px-1 text-xs text-ink-2">
          From your bank feed. It&apos;s real bank activity, so it can&apos;t be deleted. Give it a category instead.
        </p>
      )}
    </div>
  );
}
