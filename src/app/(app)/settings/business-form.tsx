"use client";

import { useActionState } from "react";
import { saveBusinessSettings } from "@/app/actions/settings";
import { Button, ErrorText, Field, inputClass } from "@/components/ui";

export function BusinessForm({
  totalChairs,
  opening,
}: {
  totalChairs: number;
  opening: { cents: number; asOf: string } | null;
}) {
  const [state, action, pending] = useActionState(saveBusinessSettings, undefined);
  return (
    <form action={action} className="space-y-4">
      <Field label="Total chairs" hint="Including empty ones. Used for the “chairs filled” number.">
        <input name="totalChairs" type="number" min={0} max={100} required defaultValue={totalChairs} className={inputClass} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="BMO balance">
          <input
            name="openingBalance"
            inputMode="decimal"
            placeholder="5,000.00"
            defaultValue={opening ? (opening.cents / 100).toFixed(2) : ""}
            className={inputClass}
          />
        </Field>
        <Field label="As of the start of">
          <input name="openingBalanceAsOf" type="date" defaultValue={opening?.asOf ?? ""} className={inputClass} />
        </Field>
      </div>
      <p className="-mt-2 text-xs text-ink-2">
        The account balance on a date, before that day’s transactions. Everything recorded from then on is added to it to
        estimate today’s balance.
      </p>
      <ErrorText>{state?.error}</ErrorText>
      {state?.ok ? <p className="text-sm text-good">{state.ok}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
