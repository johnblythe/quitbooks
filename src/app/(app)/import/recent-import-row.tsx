"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { previewImportUndoAction, undoImportAction, type UndoImportState } from "@/app/actions/import-undo";
import { Button, ErrorText, Pill } from "@/components/ui";
import type { UndoCounts } from "@/lib/import-undo";
import { formatCents } from "@/lib/money";

export type RecentImport = {
  id: string;
  filename: string;
  insertedCount: number;
  skippedCount: number;
  /** Preformatted date the import was undone, or null while it stands. */
  undoneOn: string | null;
};

function plural(n: number) {
  return `${n} transaction${n === 1 ? "" : "s"}`;
}

/** Stable, so the panel takes focus once when it opens rather than on every render. */
function focusOnMount(el: HTMLElement | null) {
  el?.focus();
}

function ConfirmText({ counts }: { counts: UndoCounts }) {
  if (!counts.removed) {
    return (
      <p>
        Nothing from <strong>{counts.filename}</strong> is left to remove. Mark it as undone?
      </p>
    );
  }
  return (
    <p>
      Remove {plural(counts.removed)} ({formatCents(counts.netCents, { signed: true })} net) from{" "}
      <strong className="break-all">{counts.filename}</strong>?{" "}
      {counts.touched
        ? `${counts.touched} of them ${counts.touched === 1 ? "has" : "have"} been sorted, split or edited since the import. `
        : ""}
      Entries you typed in that it matched, bank-feed rows and categories it created are kept. This can&apos;t be
      reversed.
    </p>
  );
}

/** One line of Recent imports, with an inline, two-step Undo. */
export function RecentImportRow({ batch }: { batch: RecentImport }) {
  const [confirm, setConfirm] = useState<UndoCounts | null>(null);
  const [status, setStatus] = useState<UndoImportState | null>(null);
  const [pending, startTransition] = useTransition();
  const undoButton = useRef<HTMLButtonElement>(null);
  const statusRegion = useRef<HTMLDivElement>(null);
  // Where focus goes once the panel has closed: the panel's buttons unmount, which would drop it to <body>.
  const focusNext = useRef<"undo" | "status" | null>(null);

  useEffect(() => {
    if (confirm) return;
    const target = focusNext.current === "undo" ? undoButton.current : focusNext.current === "status" ? statusRegion.current : null;
    focusNext.current = null;
    target?.focus();
  }, [confirm, status]);

  function askUndo() {
    setStatus(null);
    startTransition(async () => {
      try {
        const p = await previewImportUndoAction(batch.id);
        if (p.ok) setConfirm(p);
        else setStatus({ ok: false, message: p.error });
      } catch {
        setStatus({ ok: false, message: "Couldn't check that import. Try again." });
      }
    });
  }

  function runUndo() {
    focusNext.current = "status";
    startTransition(async () => {
      try {
        setStatus(await undoImportAction(batch.id));
      } catch {
        setStatus({ ok: false, message: "Couldn't undo that import. Try again." });
      }
      setConfirm(null);
    });
  }

  function cancel() {
    focusNext.current = "undo";
    setConfirm(null);
  }

  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">{batch.filename}</span>
        <span className="flex shrink-0 items-center gap-2 text-ink-2">
          {batch.insertedCount} added · {batch.skippedCount} skipped
          {batch.undoneOn ? (
            <Pill>Undone {batch.undoneOn}</Pill>
          ) : confirm ? null : (
            <button
              ref={undoButton}
              type="button"
              onClick={askUndo}
              disabled={pending}
              className="min-h-10 px-2 text-sm text-accent disabled:opacity-50"
              aria-label={`Undo import of ${batch.filename}`}
            >
              {pending ? "Checking…" : "Undo"}
            </button>
          )}
        </span>
      </div>
      {confirm && !batch.undoneOn ? (
        <div
          ref={focusOnMount}
          tabIndex={-1}
          className="mt-2 space-y-3 rounded-xl bg-surface-2 p-3 focus:outline-none"
          aria-live="polite"
        >
          <ConfirmText counts={confirm} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="danger" className="min-h-10" onClick={runUndo} disabled={pending}>
              {pending ? "Removing…" : confirm.removed ? `Remove ${plural(confirm.removed)}` : "Mark as undone"}
            </Button>
            <Button type="button" variant="ghost" className="min-h-10" onClick={cancel} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <div ref={statusRegion} tabIndex={-1} className={`focus:outline-none${status ? " mt-2" : ""}`} aria-live="polite">
        {status ? (
          status.ok ? <p className="text-sm text-good">{status.message}</p> : <ErrorText>{status.message}</ErrorText>
        ) : null}
      </div>
    </li>
  );
}
