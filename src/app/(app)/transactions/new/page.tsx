import type { Metadata } from "next";
import { Suspense } from "react";
import { createTransaction } from "@/app/actions/transactions";
import { TransactionForm } from "@/components/transaction-form";
import { Card, PageHeader, Skeleton } from "@/components/ui";
import { getCategories, getStylists, requestToday } from "@/lib/data";

export const metadata: Metadata = { title: "Add transaction" };

export default function NewTransactionPage() {
  return (
    <>
      <PageHeader title="Add a transaction" subtitle="For anything that isn't in a bank import." />
      <Suspense fallback={<Skeleton rows={2} />}>
        <NewForm />
      </Suspense>
    </>
  );
}

async function NewForm() {
  const [categories, stylists, today] = await Promise.all([getCategories(), getStylists(), requestToday()]);
  return (
    <Card>
      <TransactionForm
        action={createTransaction}
        defaults={{ date: today }}
        categories={categories}
        stylists={stylists.map((s) => ({ id: s.id, name: s.name }))}
        submitLabel="Save"
      />
    </Card>
  );
}
