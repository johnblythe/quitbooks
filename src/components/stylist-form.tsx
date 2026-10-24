"use client";

import { useActionState } from "react";
import { saveStylist } from "@/app/actions/stylists";
import type { Stylist } from "@/db/schema";
import { Button, ErrorText, Field, inputClass } from "./ui";

export function StylistForm({ stylist, today }: { stylist?: Stylist; today: string }) {
  const [state, action, pending] = useActionState(saveStylist, undefined);
  return (
    <form action={action} className="space-y-4">
      {stylist ? <input type="hidden" name="id" value={stylist.id} /> : null}
      <Field label="Name">
        <input name="name" required maxLength={100} defaultValue={stylist?.name} className={inputClass} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Rent">
          <input
            name="rent"
            inputMode="decimal"
            required
            placeholder="250.00"
            defaultValue={stylist ? (stylist.rentCents / 100).toFixed(2) : ""}
            className={inputClass}
          />
        </Field>
        <Field label="Paid">
          <select name="rentCadence" defaultValue={stylist?.rentCadence ?? "weekly"} className={inputClass}>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Monthly</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Started">
          <input name="startDate" type="date" required defaultValue={stylist?.startDate ?? today} className={inputClass} />
        </Field>
        <Field label="Left (optional)">
          <input name="endDate" type="date" defaultValue={stylist?.endDate ?? ""} className={inputClass} />
        </Field>
      </div>
      <Field label="Chair" hint="Optional label, e.g. “Chair 3”.">
        <input name="chairLabel" maxLength={200} defaultValue={stylist?.chairLabel ?? ""} className={inputClass} />
      </Field>
      <Field
        label="How their name shows on the bank statement"
        hint="Used to match their Zelle payments. Separate several with commas. Blank = use their name."
      >
        <input
          name="matchText"
          maxLength={200}
          placeholder="e.g. JANE DOE, J DOE"
          defaultValue={stylist?.matchText ?? ""}
          className={inputClass}
        />
      </Field>
      <Field label="Notes">
        <textarea name="notes" rows={2} maxLength={1000} defaultValue={stylist?.notes ?? ""} className={inputClass} />
      </Field>
      <ErrorText>{state?.error}</ErrorText>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : stylist ? "Save changes" : "Add stylist"}
      </Button>
    </form>
  );
}
