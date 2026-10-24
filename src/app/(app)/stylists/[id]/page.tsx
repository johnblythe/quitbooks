import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { deleteStylist } from "@/app/actions/stylists";
import { StylistForm } from "@/components/stylist-form";
import { Button, Card, PageHeader, Skeleton } from "@/components/ui";
import { getStylists, requestToday } from "@/lib/data";

export const metadata: Metadata = { title: "Edit stylist" };

export default function EditStylistPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <PageHeader title="Edit stylist" />
      <Suspense fallback={<Skeleton rows={2} />}>
        <EditStylist params={params} />
      </Suspense>
    </>
  );
}

async function EditStylist({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [all, today] = await Promise.all([getStylists(), requestToday()]);
  const stylist = all.find((s) => s.id === id);
  if (!stylist) notFound();
  return (
    <div className="space-y-4">
      <Card>
        <StylistForm stylist={stylist} today={today} />
      </Card>
      <p className="px-1 text-xs text-ink-2">
        When someone leaves, set the date they left instead of deleting them, so past rent stays linked to them.
      </p>
      <form action={deleteStylist}>
        <input type="hidden" name="id" value={stylist.id} />
        <Button type="submit" variant="danger" className="w-full">
          Delete stylist
        </Button>
      </form>
    </div>
  );
}
