"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { removeSplitAction, saveSplitAction } from "@/app/actions/splits";
import { Button, Card, ErrorText, Money, buttonClass, cx, inputClass } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import {
  addEditorLine,
  initialEditorLines,
  resolveEditor,
  setEditorAmount,
  toggleEditorDir,
  type EditorLine,
} from "@/lib/split-editor";
import { validateSplit } from "@/lib/splits";

type Kind = "income" | "expense" | "transfer";
export type SplitCategoryOption = { id: string; name: string; kind: Kind; archived: boolean };
type Option = { id: string; name: string };

const GROUPS: { label: string; kind: Kind }[] = [
  { label: "Money in", kind: "income" },
  { label: "Money out", kind: "expense" },
  { label: "Transfers (not profit or loss)", kind: "transfer" },
];

export function SplitEditor({
  tx,
  existing,
  categories,
  stylists,
  boothRentId,
  returnTo,
}: {
  tx: {
    id: string;
    date: string;
    description: string;
    amountCents: number;
    categoryId: string | null;
    stylistId: string | null;
    isSplit: boolean;
  };
  existing: { categoryId: string; stylistId: string | null; amountCents: number; memo: string | null }[];
  categories: SplitCategoryOption[];
  stylists: Option[];
  boothRentId: string | null;
  returnTo: "inbox" | "transaction";
}) {
  const usable = useMemo(() => new Set(categories.filter((c) => !c.archived).map((c) => c.id)), [categories]);
  const [lines, setLines] = useState<EditorLine[]>(() => initialEditorLines(tx, existing, usable));
  const [saveState, saveAction, saving] = useActionState(saveSplitAction, undefined);

  const parent = tx.amountCents;
  const resolved = resolveEditor(parent, lines, boothRentId);
  const check = validateSplit(resolved.payload, {
    parentAmountCents: parent,
    categories,
    boothRentCategoryId: boothRentId,
    stylistIds: stylists.map((s) => s.id),
  });

  const update = (key: string, patch: Partial<EditorLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{tx.description}</p>
            <p className="mt-0.5 text-xs text-ink-2">{formatDate(tx.date)}</p>
          </div>
          <Money cents={parent} signed className={cx("shrink-0", parent > 0 && "text-good")} />
        </div>
      </Card>

      <form action={saveAction} className="space-y-3">
        <input type="hidden" name="id" value={tx.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="lines" value={JSON.stringify(resolved.payload)} />

        <ol className="space-y-3">
          {resolved.lines.map((l, i) => {
            const isBooth = !!boothRentId && l.categoryId === boothRentId;
            return (
              <li key={l.key} className="space-y-2 rounded-2xl border border-line bg-surface p-3">
                <div className="flex items-center gap-2">
                  <select
                    value={l.categoryId}
                    onChange={(e) =>
                      update(l.key, {
                        categoryId: e.target.value,
                        stylistId: e.target.value === boothRentId ? l.stylistId : "",
                      })
                    }
                    className={cx(inputClass, "min-w-0 flex-1")}
                    aria-label={`Line ${i + 1} category`}
                  >
                    <option value="">Category…</option>
                    {GROUPS.map((g) => (
                      <optgroup key={g.kind} label={g.label}>
                        {categories
                          .filter((c) => c.kind === g.kind && (!c.archived || c.id === l.categoryId))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                              {c.archived ? " (hidden)" : ""}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  <div className="w-28 shrink-0">
                    <input
                      value={l.shownText}
                      onChange={(e) => setLines((ls) => setEditorAmount(ls, l.key, e.target.value))}
                      onFocus={(e) => e.currentTarget.select()}
                      inputMode="decimal"
                      placeholder={l.auto ? "What's left" : "0.00"}
                      className={cx(inputClass, "text-right tabular-nums")}
                      aria-label={`Line ${i + 1} amount`}
                    />
                  </div>
                </div>

                {isBooth ? (
                  <select
                    value={l.stylistId}
                    onChange={(e) => update(l.key, { stylistId: e.target.value })}
                    className={inputClass}
                    aria-label={`Line ${i + 1} stylist`}
                  >
                    <option value="">Which stylist?</option>
                    {stylists.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                ) : null}

                <div className="flex items-center gap-2">
                  <div className="grid shrink-0 grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label={`Line ${i + 1} direction`}>
                    {([1, -1] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        role="radio"
                        aria-checked={l.shownDir === d}
                        onClick={() => {
                          if (l.shownDir !== d) setLines((ls) => toggleEditorDir(ls, l.key, parent, boothRentId));
                        }}
                        className={cx(
                          "min-h-8 rounded-lg px-2.5 text-xs font-medium",
                          l.shownDir === d ? "bg-surface text-ink shadow-sm" : "text-ink-2",
                        )}
                      >
                        {d === 1 ? "In" : "Out"}
                      </button>
                    ))}
                  </div>
                  <input
                    value={l.memo}
                    onChange={(e) => update(l.key, { memo: e.target.value })}
                    maxLength={200}
                    placeholder="Memo (optional)"
                    className={cx(inputClass, "min-w-0 flex-1")}
                    aria-label={`Line ${i + 1} memo`}
                  />
                  {lines.length > 2 ? (
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      className="flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 hover:text-ink"
                      aria-label={`Remove line ${i + 1}`}
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
                {l.auto ? <p className="text-xs text-ink-2">Fills what&apos;s left until you type an amount.</p> : null}
              </li>
            );
          })}
        </ol>

        <Button type="button" variant="secondary" className="w-full" onClick={() => setLines((ls) => addEditorLine(ls, parent))}>
          Add line
        </Button>

        <div className="sticky bottom-[calc(4rem_+_env(safe-area-inset-bottom))] z-10 space-y-2 rounded-2xl border border-line bg-surface/95 p-3 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm" aria-live="polite">
              <span className="text-ink-2">Left to assign: </span>
              <Money
                cents={Math.abs(resolved.left)}
                className={cx("font-semibold", resolved.left === 0 ? "text-good" : resolved.left < 0 ? "text-bad" : "text-warn")}
              />
              {resolved.left < 0 ? <span className="text-xs text-bad"> over</span> : null}
            </p>
            <Button type="submit" disabled={!check.ok || saving} className="min-h-10 shrink-0">
              {saving ? "Saving…" : "Save split"}
            </Button>
          </div>
          {!check.ok ? <p className="text-xs text-ink-2">{check.error}</p> : null}
          <ErrorText>{saveState?.error}</ErrorText>
        </div>
      </form>

      {tx.isSplit ? <RemoveSplit txId={tx.id} categories={categories} stylists={stylists} boothRentId={boothRentId} returnTo={returnTo} /> : null}

      <Link
        href={returnTo === "inbox" ? "/inbox" : `/transactions/${tx.id}`}
        className={buttonClass("ghost", "w-full")}
      >
        Cancel
      </Link>
    </div>
  );
}

function RemoveSplit({
  txId,
  categories,
  stylists,
  boothRentId,
  returnTo,
}: {
  txId: string;
  categories: SplitCategoryOption[];
  stylists: Option[];
  boothRentId: string | null;
  returnTo: "inbox" | "transaction";
}) {
  const [state, action, pending] = useActionState(removeSplitAction, undefined);
  const [categoryId, setCategoryId] = useState("");
  const [stylistId, setStylistId] = useState("");
  return (
    <Card title="Remove split">
      <form action={action} className="space-y-2">
        <input type="hidden" name="id" value={txId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <p className="text-sm text-ink-2">Turns this back into one transaction. With no category it goes back to the Inbox.</p>
        <select
          name="categoryId"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            if (e.target.value !== boothRentId) setStylistId("");
          }}
          className={inputClass}
          aria-label="Category after removing the split"
        >
          <option value="">Uncategorized (back to the Inbox)</option>
          {GROUPS.map((g) => (
            <optgroup key={g.kind} label={g.label}>
              {categories
                .filter((c) => c.kind === g.kind && !c.archived)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        {boothRentId && categoryId === boothRentId && stylists.length ? (
          <select
            name="stylistId"
            value={stylistId}
            onChange={(e) => setStylistId(e.target.value)}
            className={inputClass}
            aria-label="Stylist (for booth rent)"
          >
            <option value="">No stylist</option>
            {stylists.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
        <ErrorText>{state?.error}</ErrorText>
        <Button type="submit" variant="danger" disabled={pending} className="w-full">
          {pending ? "Removing…" : "Remove split"}
        </Button>
      </form>
    </Card>
  );
}
