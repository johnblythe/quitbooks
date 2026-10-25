import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { deleteTransaction, updateTransaction } from "@/app/actions/transactions";
import { TransactionForm } from "@/components/transaction-form";
import { Button, Card, PageHeader, Skeleton } from "@/components/ui";
import { getCategories, getStylists, getTransaction } from "@/lib/data";
import { monthOf } from "@/lib/dates";
import { canDeleteTransaction } from "@/lib/transaction-delete";

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
  const [tx, categories, stylists] = await Promise.all([getTransaction(id), getCategories({ includeArchived: true }), getStylists()]);
  if (!tx) notFound();

  return (
    <div className="space-y-4">
      <Card>
        <TransactionForm
          action={updateTransaction}
          defaults={tx}
          categories={categories.filter((c) => !c.archived || c.id === tx.categoryId)}
          stylists={stylists.map((s) => ({ id: s.id, name: s.name }))}
          submitLabel="Save changes"
        />
      </Card>
      {tx.source === "csv" ? (
        <p className="px-1 text-xs text-ink-2">
          Imported from a bank CSV. If you delete it, importing a file that includes it again will add it back.
        </p>
      ) : null}
      {canDeleteTransaction(tx.source) ? (
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
