"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { commitImport, previewImport, type ImportPreview, type ImportResult } from "@/app/actions/import";
import { Button, Card, ErrorText, Field, Money, Pill, inputClass } from "@/components/ui";
import type { CsvMapping } from "@/lib/csv";
import { formatDate } from "@/lib/dates";

export function ImportFlow({ savedMapping }: { savedMapping: CsvMapping | null }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(savedMapping);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function runPreview(text: string, m: CsvMapping | null) {
    setError(null);
    startTransition(async () => {
      try {
        const p = await previewImport(text, m);
        setPreview(p);
        setMapping(p.mapping);
      } catch {
        setError("Couldn't read that file. Is it a CSV export?");
      }
    });
  }

  async function onFile(f: File | undefined) {
    setResult(null);
    setPreview(null);
    if (!f) return;
    const text = await f.text();
    setFile({ name: f.name, text });
    runPreview(text, savedMapping);
  }

  function updateMapping(patch: Partial<CsvMapping>) {
    if (!file || !preview) return;
    const base: CsvMapping = mapping ?? {
      dateColumn: preview.headers[0] ?? "",
      descriptionColumn: preview.headers[1] ?? "",
      amountMode: "single",
      amountColumn: preview.headers[2] ?? "",
    };
    const next = { ...base, ...patch };
    setMapping(next);
    runPreview(file.text, next);
  }

  function onCommit() {
    if (!file || !mapping) return;
    startTransition(async () => {
      try {
        setResult(await commitImport(file.text, mapping, file.name));
        setPreview(null);
        setFile(null);
      } catch {
        setError("The import didn't finish. It's safe to try again; anything already added will be skipped.");
      }
    });
  }

  if (result?.ok) {
    const month = result.months[result.months.length - 1];
    return (
      <Card>
        <p className="font-serif text-xl">Imported {result.inserted} transactions</p>
        <p className="mt-1 text-sm text-ink-2">
          {result.skipped ? `${result.skipped} were already here and were skipped. ` : ""}
          Anything the rules couldn’t sort is waiting in the Inbox.
        </p>
        <div className="mt-4 flex gap-2">
          <Link href="/inbox" className="text-sm font-medium text-accent underline">
            Go to Inbox
          </Link>
          {month ? (
            <Link href={`/transactions?month=${month}`} className="text-sm font-medium text-accent underline">
              See transactions
            </Link>
          ) : null}
        </div>
      </Card>
    );
  }

  const headerOptions = preview?.headers ?? [];
  const select = (value: string | undefined, onChange: (v: string) => void, label: string) => (
    <Field label={label}>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">—</option>
        {headerOptions.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <div className="space-y-4">
      <Card>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line px-4 py-8 text-center hover:bg-surface-2">
          <span className="text-sm font-medium">{file ? file.name : "Choose a CSV file"}</span>
          <span className="text-xs text-ink-2">Nothing is saved until you confirm.</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        {pending ? <p className="mt-3 text-center text-sm text-ink-2">Reading…</p> : null}
        <div className="mt-3">
          <ErrorText>{error ?? (result && !result.ok ? result.error : null)}</ErrorText>
        </div>
      </Card>

      {preview ? (
        <>
          <Card title="Columns">
            <div className="grid gap-3 sm:grid-cols-2">
              {select(mapping?.dateColumn, (v) => updateMapping({ dateColumn: v }), "Date")}
              {select(mapping?.descriptionColumn, (v) => updateMapping({ descriptionColumn: v }), "Description")}
              <Field label="Amounts are in">
                <select
                  value={mapping?.amountMode ?? "single"}
                  onChange={(e) => updateMapping({ amountMode: e.target.value as CsvMapping["amountMode"] })}
                  className={inputClass}
                >
                  <option value="single">One column (+ in, − out)</option>
                  <option value="split">Separate debit & credit columns</option>
                </select>
              </Field>
              {mapping?.amountMode === "split" ? (
                <>
                  {select(mapping.debitColumn, (v) => updateMapping({ debitColumn: v }), "Money out (debit)")}
                  {select(mapping.creditColumn, (v) => updateMapping({ creditColumn: v }), "Money in (credit)")}
                </>
              ) : (
                select(mapping?.amountColumn, (v) => updateMapping({ amountColumn: v }), "Amount")
              )}
              {select(mapping?.memoColumn, (v) => updateMapping({ memoColumn: v || undefined }), "Extra details (optional)")}
            </div>
            {mapping?.amountMode !== "split" ? (
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!mapping?.invertSign}
                  onChange={(e) => updateMapping({ invertSign: e.target.checked })}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                This bank shows money out as positive numbers
              </label>
            ) : null}
            <p className="mt-3 text-xs text-ink-2">Saved after your first import, so next time it just works.</p>
          </Card>

          <Card
            title="Preview"
            action={
              <span className="text-xs text-ink-2">
                {preview.newCount} new · {preview.duplicateCount} already here
              </span>
            }
          >
            {preview.errors.length ? (
              <details className="mb-3 text-sm">
                <summary className="cursor-pointer text-warn">{preview.errors.length} rows couldn’t be read</summary>
                <ul className="mt-2 space-y-1 text-xs text-ink-2">
                  {preview.errors.slice(0, 20).map((e, i) => (
                    <li key={i}>
                      Line {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto text-sm">
              {preview.rows.slice(0, 200).map((r) => (
                <li key={r.line} className={`flex items-center justify-between gap-3 py-2 ${r.duplicate ? "opacity-50" : ""}`}>
                  <span className="min-w-0">
                    <span className="block truncate">{r.description}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
                      {formatDate(r.date)}
                      {r.duplicate ? (
                        <Pill>Already imported</Pill>
                      ) : r.categoryName ? (
                        <span>· {r.stylistName ? `${r.categoryName} · ${r.stylistName}` : r.categoryName}</span>
                      ) : (
                        <Pill tone="warn">Inbox</Pill>
                      )}
                    </span>
                  </span>
                  <Money cents={r.amountCents} signed className={r.amountCents > 0 ? "shrink-0 text-good" : "shrink-0"} />
                </li>
              ))}
            </ul>
            {preview.rows.length > 200 ? (
              <p className="mt-2 text-xs text-ink-2">Showing the first 200 of {preview.rows.length} rows.</p>
            ) : null}
          </Card>

          <Button onClick={onCommit} disabled={pending || !mapping || preview.newCount === 0} className="w-full">
            {preview.newCount === 0 ? "Nothing new to import" : `Import ${preview.newCount} transactions`}
          </Button>
        </>
      ) : null}
    </div>
  );
}
