"use client";

import { useActionState, useState } from "react";
import type { TxFormState } from "@/app/actions/transactions";
import { Button, ErrorText, Field, cx, inputClass } from "./ui";

type Option = { id: string; name: string };
type CategoryOption = Option & { kind: "income" | "expense" | "transfer" };

export type TxFormDefaults = {
  id?: string;
  date: string;
  amountCents?: number;
  description?: string;
  categoryId?: string | null;
  stylistId?: string | null;
  note?: string | null;
};

export function TransactionForm({
  action,
  defaults,
  categories,
  stylists,
  submitLabel,
  split = false,
}: {
  action: (prev: TxFormState, formData: FormData) => Promise<TxFormState>;
  defaults: TxFormDefaults;
  categories: CategoryOption[];
  stylists: Option[];
  submitLabel: string;
  /** A split row: its lines own the categories, and its amount is locked so they keep adding up. */
  split?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [direction, setDirection] = useState<"in" | "out">((defaults.amountCents ?? -1) > 0 ? "in" : "out");

  const groups: { label: string; kind: CategoryOption["kind"] }[] = [
    { label: "Money in", kind: "income" },
    { label: "Money out", kind: "expense" },
    { label: "Transfers (not profit or loss)", kind: "transfer" },
  ];

  return (
    <form action={formAction} className="space-y-4">
      {defaults.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <input type="hidden" name="direction" value={direction} />

      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Direction">
        {(["out", "in"] as const).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={direction === d}
            disabled={split}
            onClick={() => setDirection(d)}
            className={cx(
              "rounded-lg py-2 text-sm font-medium",
              direction === d ? "bg-surface text-ink shadow-sm" : "text-ink-2",
            )}
          >
            {d === "in" ? "Money in" : "Money out"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount" hint={split ? "Locked while split. Remove the split to change it." : undefined}>
          {split ? (
            <input type="hidden" name="amount" value={(Math.abs(defaults.amountCents ?? 0) / 100).toFixed(2)} />
          ) : null}
          <input
            name={split ? undefined : "amount"}
            inputMode="decimal"
            placeholder="0.00"
            required={!split}
            disabled={split}
            defaultValue={defaults.amountCents ? (Math.abs(defaults.amountCents) / 100).toFixed(2) : ""}
            className={cx(inputClass, split && "opacity-60")}
          />
        </Field>
        <Field label="Date">
          <input name="date" type="date" required defaultValue={defaults.date} className={inputClass} />
        </Field>
      </div>

      <Field label="Description">
        <input name="description" required maxLength={300} defaultValue={defaults.description} className={inputClass} placeholder="e.g. Sally Beauty supplies" />
      </Field>

      {split ? null : (
        <Field label="Category" hint={defaults.id ? undefined : "Leave blank and saved rules will try to sort it."}>
          <select name="categoryId" defaultValue={defaults.categoryId ?? ""} className={inputClass}>
            <option value="">Uncategorized</option>
            {groups.map((g) => (
              <optgroup key={g.kind} label={g.label}>
                {categories
                  .filter((c) => c.kind === g.kind)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
      )}

      {stylists.length && !split ? (
        <Field label="Stylist" hint="For booth rent payments.">
          <select name="stylistId" defaultValue={defaults.stylistId ?? ""} className={inputClass}>
            <option value="">None</option>
            {stylists.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <Field label="Note">
        <textarea name="note" rows={2} maxLength={1000} defaultValue={defaults.note ?? ""} className={inputClass} />
      </Field>

      <ErrorText>{state?.error}</ErrorText>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
