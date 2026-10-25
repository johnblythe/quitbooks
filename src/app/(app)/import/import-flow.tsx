"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { commitImport, previewImport, type ImportPreview, type ImportResult } from "@/app/actions/import";
import { Button, Card, ErrorText, Field, Money, Pill, inputClass } from "@/components/ui";
import type { CsvMapping } from "@/lib/csv";
import { guessKind, resolveRowCategory, type CategoryKind, type FileCategoryChoice } from "@/lib/import-categories";
import { formatDate } from "@/lib/dates";
import { coveredNote } from "@/lib/bank-cutover";
import { MAX_CSV_BYTES, TOO_BIG_MESSAGE } from "@/lib/import-limits";

export function ImportFlow() {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Lines whose "Same transaction" box the user unticked. Matched rows start ticked. */
  const [unlinked, setUnlinked] = useState<Set<number>>(new Set());
  const [ackErrors, setAckErrors] = useState(false);
  /** What to do with each distinct value of the file's category column, keyed by the server's group key. */
  const [choices, setChoices] = useState<Record<string, FileCategoryChoice>>({});
  const [pending, startTransition] = useTransition();

  function runPreview(text: string, m: CsvMapping | null, resetChoices = false) {
    setError(null);
    startTransition(async () => {
      try {
        const p = await previewImport(text, m);
        setPreview(p);
        setMapping(p.mapping);
        // Keep what the user already picked; only values not seen yet start from the server's default.
        const defaults = Object.fromEntries(p.categoryGroups.map((g) => [g.key, g.choice]));
        setChoices((prev) => (resetChoices ? defaults : { ...defaults, ...prev }));
        setUnlinked(new Set());
        setAckErrors(false);
      } catch {
        setError("Couldn't read that file. Is it a CSV export?");
      }
    });
  }

  async function onFile(f: File | undefined) {
    setResult(null);
    setPreview(null);
    setChoices({});
    setError(null);
    if (!f) return;
    if (f.size > MAX_CSV_BYTES) {
      setFile(null);
      setError(TOO_BIG_MESSAGE);
      return;
    }
    const text = await f.text();
    setFile({ name: f.name, text });
    runPreview(text, null, true);
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
    runPreview(file.text, next, "categoryColumn" in patch);
  }

  const matched = preview?.rows.filter((r) => r.match && !r.duplicate) ?? [];
  const links = matched
    .filter((r) => !unlinked.has(r.line))
    .map((r) => ({ line: r.line, transactionId: r.match!.transactionId }));
  const errorCount = preview?.errors.length ?? 0;
  const groups = preview?.categoryGroups ?? [];
  const catById = new Map((preview?.categories ?? []).map((c) => [c.id, c]));

  function setChoice(key: string, choice: FileCategoryChoice) {
    setChoices((prev) => ({ ...prev, [key]: choice }));
  }

  /** Category and stylist a row will get, given the file category and the current choice for it. */
  function rowOutcome(r: ImportPreview["rows"][number]): { category: string | null; stylist: string | null; isNew: boolean } {
    const choice = r.fileCategoryKey ? choices[r.fileCategoryKey] : undefined;
    if (choice?.type === "new") return { category: choice.name.trim() || null, stylist: null, isNew: true };
    const out = resolveRowCategory(
      choice?.type === "existing" ? choice.categoryId : undefined,
      { categoryId: r.autoCategoryId, stylistId: r.autoStylistId },
      preview?.boothRentCategoryId ?? null,
    );
    if (choice?.type === "existing") {
      return {
        category: out.categoryId ? (catById.get(out.categoryId)?.name ?? null) : null,
        stylist: out.stylistId ? r.stylistName : null,
        isNew: false,
      };
    }
    return { category: r.categoryName, stylist: r.stylistName, isNew: false };
  }
  const toInsert = (preview?.newCount ?? 0) - links.length;
  const canImport = !pending && !!mapping && (preview?.newCount ?? 0) > 0 && (errorCount === 0 || ackErrors);

  function onCommit() {
    if (!file || !mapping) return;
    startTransition(async () => {
      try {
        const sent = Object.fromEntries(groups.map((g) => [g.key, choices[g.key] ?? g.choice]));
        setResult(await commitImport(file.text, mapping, file.name, links, ackErrors, sent));
        setPreview(null);
        setFile(null);
      } catch {
        setError("The import didn't finish and nothing was saved. It's safe to try again.");
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
          {result.linked ? `${result.linked} linked to existing entries. ` : ""}
          {result.covered ? `${coveredNote(result.covered)} ` : ""}
          {result.createdCategories
            ? `${result.createdCategories} new ${result.createdCategories === 1 ? "category was" : "categories were"} created. `
            : ""}
          {result.skippedLines ? `${result.skippedLines} report lines were skipped. ` : ""}
          Anything the rules couldn’t sort is waiting in the Inbox.
        </p>
        {result.errors.length ? (
          <div className="mt-3 rounded-lg border border-warn/40 p-3 text-sm" role="alert">
            <p className="font-medium text-warn">
              {result.errors.length} rows couldn’t be read and were NOT imported
            </p>
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-ink-2">
              {result.errors.map((e, i) => (
                <li key={i}>
                  Line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
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
              {select(mapping?.descriptionColumn, (v) => updateMapping({ descriptionColumn: v }), "Description / name")}
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
              {select(mapping?.memoColumn, (v) => updateMapping({ memoColumn: v || undefined }), "Memo / extra details (optional)")}
              {select(mapping?.categoryColumn, (v) => updateMapping({ categoryColumn: v || undefined }), "Category (optional)")}
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

          {groups.length ? (
            <Card
              title="Categories in this file"
              action={<span className="text-xs text-ink-2">{groups.length} to map</span>}
            >
              <p className="mb-2 text-xs text-ink-2">
                Pick what each one becomes. These win over your rules. “Leave for Inbox” sorts the rows the usual way.
              </p>
              <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto text-sm">
                {groups.map((g) => {
                  const choice = choices[g.key] ?? g.choice;
                  const selectValue = choice.type === "existing" ? choice.categoryId : choice.type;
                  return (
                    <li key={g.key} className="space-y-2 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate font-medium">{g.value}</span>
                        <span className="shrink-0 text-xs text-ink-2">
                          {g.count} {g.count === 1 ? "row" : "rows"} · <Money cents={g.netCents} signed />
                        </span>
                      </div>
                      <select
                        aria-label={`Category for ${g.value}`}
                        value={selectValue}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "inbox") setChoice(g.key, { type: "inbox" });
                          else if (v === "new") setChoice(g.key, { type: "new", name: g.value.slice(0, 60), kind: guessKind(g) });
                          else setChoice(g.key, { type: "existing", categoryId: v });
                        }}
                        className={inputClass}
                      >
                        <option value="inbox">Leave for Inbox</option>
                        <option value="new">Create new…</option>
                        {(["income", "expense", "transfer"] as const).map((kind) => (
                          <optgroup key={kind} label={kind[0].toUpperCase() + kind.slice(1)}>
                            {preview.categories
                              .filter((c) => c.kind === kind)
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                      </select>
                      {choice.type === "new" ? (
                        <div className="grid grid-cols-[1fr_auto] gap-2">
                          <input
                            aria-label={`New category name for ${g.value}`}
                            value={choice.name}
                            maxLength={60}
                            onChange={(e) => setChoice(g.key, { ...choice, name: e.target.value })}
                            className={inputClass}
                          />
                          <select
                            aria-label={`Kind for ${choice.name || g.value}`}
                            value={choice.kind}
                            onChange={(e) => setChoice(g.key, { ...choice, kind: e.target.value as CategoryKind })}
                            className={inputClass}
                          >
                            <option value="income">Income</option>
                            <option value="expense">Expense</option>
                            <option value="transfer">Transfer</option>
                          </select>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}

          <Card
            title="Preview"
            action={
              <span className="text-xs text-ink-2">
                {preview.newCount} new · {preview.duplicateCount} already here
              </span>
            }
          >
            {preview.coveredCount ? (
              <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">{coveredNote(preview.coveredCount)}</p>
            ) : null}
            {preview.skippedLines ? (
              <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">
                {preview.skippedLines} report {preview.skippedLines === 1 ? "line" : "lines"} skipped (headings, totals, footer).
              </p>
            ) : null}
            {errorCount ? (
              <div className="mb-3 rounded-lg border border-warn/40 p-3 text-sm" role="alert">
                <p className="font-medium text-warn">{errorCount} rows couldn’t be read</p>
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-ink-2">
                  {preview.errors.slice(0, 100).map((e, i) => (
                    <li key={i}>
                      Line {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
                {errorCount > 100 ? <p className="mt-1 text-xs text-ink-2">…and {errorCount - 100} more.</p> : null}
              </div>
            ) : null}
            {matched.length ? (
              <div className="mb-3">
                <p className="text-sm font-medium">
                  {matched.length} {matched.length === 1 ? "row matches an entry" : "rows match entries"} you made by hand
                </p>
                <p className="text-xs text-ink-2">
                  Ticked rows are linked to your entry instead of being added again.
                </p>
                <ul className="mt-2 divide-y divide-line text-sm">
                  {matched.map((r) => (
                    <li key={r.line} className="flex items-start justify-between gap-3 py-2">
                      <label className="flex min-w-0 cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          checked={!unlinked.has(r.line)}
                          onChange={(e) =>
                            setUnlinked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.delete(r.line);
                              else next.add(r.line);
                              return next;
                            })
                          }
                          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
                        />
                        <span className="min-w-0">
                          <span className="block truncate">{r.description}</span>
                          <span className="block text-xs text-ink-2">
                            Matches your entry from {formatDate(r.match!.date)}: {r.match!.description}
                          </span>
                          <span className="block text-xs font-medium">Same transaction</span>
                        </span>
                      </label>
                      <Money cents={r.amountCents} signed className={r.amountCents > 0 ? "shrink-0 text-good" : "shrink-0"} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto text-sm">
              {preview.rows.filter((r) => r.duplicate || !r.match).slice(0, 200).map((r) => {
                const out = rowOutcome(r);
                return (
                <li key={r.line} className={`flex items-center justify-between gap-3 py-2 ${r.duplicate ? "opacity-50" : ""}`}>
                  <span className="min-w-0">
                    <span className="block truncate">{r.description}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
                      {formatDate(r.date)}
                      {r.duplicate ? (
                        <Pill>Already imported</Pill>
                      ) : out.category ? (
                        <span>
                          · {out.stylist ? `${out.category} · ${out.stylist}` : out.category}
                          {out.isNew ? " (new)" : ""}
                        </span>
                      ) : (
                        <Pill tone="warn">Inbox</Pill>
                      )}
                    </span>
                  </span>
                  <Money cents={r.amountCents} signed className={r.amountCents > 0 ? "shrink-0 text-good" : "shrink-0"} />
                </li>
                );
              })}
            </ul>
            {preview.rows.length > 200 ? (
              <p className="mt-2 text-xs text-ink-2">Showing the first 200 of {preview.rows.length} rows.</p>
            ) : null}
          </Card>

          {errorCount ? (
            <label className="flex items-start gap-2 rounded-lg border border-warn/40 p-3 text-sm" role="group">
              <input
                type="checkbox"
                checked={ackErrors}
                onChange={(e) => setAckErrors(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span>
                <span className="font-medium text-warn">
                  {errorCount} {errorCount === 1 ? "row" : "rows"} couldn’t be read.
                </span>{" "}
                Import without these {errorCount} rows
              </span>
            </label>
          ) : null}

          <Button onClick={onCommit} disabled={!canImport} className="w-full">
            {preview.newCount === 0
              ? "Nothing new to import"
              : toInsert === 0
                ? `Link ${links.length} existing ${links.length === 1 ? "entry" : "entries"}`
                : links.length
                  ? `Import ${toInsert} transactions, link ${links.length}`
                  : `Import ${toInsert} transactions`}
          </Button>
        </>
      ) : null}
    </div>
  );
}
