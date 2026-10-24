"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { isIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";

export type StylistFormState = { error?: string } | undefined;

const optionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => v || null);

const stylistForm = z.object({
  id: z
    .string()
    .optional()
    .transform((v) => v || null)
    .pipe(z.uuid().nullable()),
  name: z.string().trim().min(1, "Add their name.").max(100),
  matchText: optionalText,
  chairLabel: optionalText,
  rent: z.string().min(1, "Enter their rent."),
  rentCadence: z.enum(["weekly", "biweekly", "monthly"]),
  startDate: z.string().refine(isIsoDate, "Pick a start date."),
  endDate: z
    .string()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || isIsoDate(v), "End date isn't valid."),
  notes: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || null),
});

export async function saveStylist(_prev: StylistFormState, formData: FormData): Promise<StylistFormState> {
  await requireUser();
  const parsed = stylistForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const { id, rent, ...rest } = parsed.data;
  const rentCents = parseAmountToCents(rent);
  if (rentCents === null || rentCents <= 0) return { error: "Enter rent like 250.00." };
  if (rest.endDate && rest.endDate < rest.startDate) return { error: "End date is before the start date." };

  const db = await getDb();
  const values = { ...rest, rentCents };
  if (id) {
    await db.update(schema.stylists).set(values).where(eq(schema.stylists.id, id));
  } else {
    await db.insert(schema.stylists).values(values);
  }
  redirect("/stylists");
}

export async function deleteStylist(formData: FormData) {
  await requireUser();
  const id = z.uuid().parse(formData.get("id"));
  const db = await getDb();
  // Their past payments stay; they just lose the stylist link (FK is ON DELETE SET NULL).
  await db.delete(schema.stylists).where(eq(schema.stylists.id, id));
  redirect("/stylists");
}
