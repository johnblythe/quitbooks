import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, PageHeader, Skeleton } from "@/components/ui";
import { getRecentImports } from "@/lib/data";
import { ImportFlow } from "./import-flow";

export const metadata: Metadata = { title: "Import" };

export default function ImportPage() {
  return (
    <>
      <PageHeader title="Import from BMO" subtitle="Download a CSV from BMO online banking and drop it here." />
      <Suspense fallback={<Skeleton rows={2} />}>
        <ImportContent />
      </Suspense>
    </>
  );
}

async function ImportContent() {
  const recent = await getRecentImports();
  return (
    <div className="space-y-4">
      <ImportFlow />
      <Card title="Importing from QuickBooks?">
        <p className="text-sm text-ink-2">
          In QuickBooks Online, open Reports and run <strong className="text-ink">Transaction Detail by Account</strong>{" "}
          for the BMO account. Choose all dates and <strong className="text-ink">Cash basis</strong>, then Export. If
          QuickBooks only offers Excel, open the file and Save As CSV. Your categories come along: you’ll match each
          one to ours before anything is saved.
        </p>
      </Card>
      {recent.length ? (
        <Card title="Recent imports">
          <ul className="divide-y divide-line text-sm">
            {recent.map((b) => (
              <li key={b.id} className="flex justify-between gap-3 py-2">
                <span className="min-w-0 truncate">{b.filename}</span>
                <span className="shrink-0 text-ink-2">
                  {b.insertedCount} added · {b.skippedCount} skipped
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
