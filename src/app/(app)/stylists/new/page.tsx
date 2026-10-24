import type { Metadata } from "next";
import { Suspense } from "react";
import { StylistForm } from "@/components/stylist-form";
import { Card, PageHeader, Skeleton } from "@/components/ui";
import { requestToday } from "@/lib/data";

export const metadata: Metadata = { title: "Add stylist" };

export default function NewStylistPage() {
  return (
    <>
      <PageHeader title="Add a stylist" />
      <Suspense fallback={<Skeleton rows={2} />}>
        <NewStylist />
      </Suspense>
    </>
  );
}

async function NewStylist() {
  const today = await requestToday();
  return (
    <Card>
      <StylistForm today={today} />
    </Card>
  );
}
