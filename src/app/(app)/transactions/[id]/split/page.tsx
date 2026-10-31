import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { getBoothRentCategoryId, getCategories, getSplitLines, getStylists, getTransaction } from "@/lib/data";
import { SplitEditor } from "./split-editor";

export const metadata: Metadata = { title: "Split transaction" };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> };

export default function SplitTransactionPage({ params, searchParams }: Props) {
  return (
    <>
      <PageHeader title="Split transaction" subtitle="Divide one bank row across categories or stylists." />
      <Suspense fallback={<Skeleton rows={3} />}>
        <Editor params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Editor({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [tx, lines, categories, stylists, boothRentId] = await Promise.all([
    getTransaction(id),
    getSplitLines(id),
    getCategories({ includeArchived: true }),
    getStylists(),
    getBoothRentCategoryId(),
  ]);
  if (!tx) notFound();

  // Hidden categories stay listed only where an existing line still uses one (save asks to change it).
  const used = new Set(lines.map((l) => l.categoryId));
  return (
    <SplitEditor
      key={lines.map((l) => `${l.categoryId}:${l.amountCents}`).join("|") || "new"}
      tx={{
        id: tx.id,
        date: tx.date,
        description: tx.description,
        amountCents: tx.amountCents,
        categoryId: tx.categoryId,
        stylistId: tx.stylistId,
        isSplit: tx.isSplit,
      }}
      existing={lines.map((l) => ({ categoryId: l.categoryId, stylistId: l.stylistId, amountCents: l.amountCents, memo: l.memo }))}
      categories={categories
        .filter((c) => !c.archived || used.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, kind: c.kind, archived: c.archived }))}
      stylists={stylists.map((s) => ({ id: s.id, name: s.name }))}
      boothRentId={boothRentId}
      returnTo={sp.from === "inbox" ? "inbox" : "transaction"}
    />
  );
}
