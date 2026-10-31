"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser } from "@/lib/auth";
import { removeSplit, saveSplit } from "@/lib/split-server";
import { MAX_SPLIT_LINES } from "@/lib/splits";

export type SplitFormState = { error?: string } | undefined;

const optionalId = z
  .string()
  .optional()
  .transform((v) => (v ? v : null))
  .pipe(z.uuid().nullable());

const returnTo = z.enum(["inbox", "transaction"]).optional();

/** Lines arrive as JSON from the editor. Shapes are checked here; the invariants in saveSplit. */
const linesSchema = z
  .array(
    z.object({
      categoryId: z.string().max(64),
      stylistId: z.uuid().nullable(),
      amountCents: z.number(),
      memo: z.string().max(1000).nullable(),
    }),
  )
  .max(MAX_SPLIT_LINES);

function destination(id: string, to: "inbox" | "transaction" | undefined) {
  return to === "inbox" ? "/inbox" : `/transactions/${id}`;
}

/** Saves (or replaces) a transaction's split lines. */
export async function saveSplitAction(_prev: SplitFormState, formData: FormData): Promise<SplitFormState> {
  await requireUser();
  const input = z
    .object({ id: z.uuid(), lines: z.string().max(50_000), returnTo })
    .safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: "Missing transaction." };
  let raw: unknown;
  try {
    raw = JSON.parse(input.data.lines);
  } catch {
    return { error: "Couldn't read the lines. Reload and try again." };
  }
  const lines = linesSchema.safeParse(raw);
  if (!lines.success) return { error: "Couldn't read the lines. Reload and try again." };

  const result = await saveSplit(await getDb(), input.data.id, lines.data);
  if (!result.ok) return { error: result.error };
  redirect(destination(input.data.id, input.data.returnTo));
}

/** Turns a split row back into a single one: back to the Inbox, or straight into a category. */
export async function removeSplitAction(_prev: SplitFormState, formData: FormData): Promise<SplitFormState> {
  await requireUser();
  const input = z
    .object({ id: z.uuid(), categoryId: optionalId, stylistId: optionalId, returnTo })
    .safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: "Check the form." };
  const { id, categoryId, stylistId } = input.data;

  const result = await removeSplit(await getDb(), id, { categoryId, stylistId });
  if (!result.ok) return { error: result.error };
  redirect(destination(id, input.data.returnTo));
}
