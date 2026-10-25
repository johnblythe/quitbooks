"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { getCategorizer } from "@/lib/data";
import { isIsoDate, monthOf } from "@/lib/dates";
import { chunk } from "@/lib/inbox";
import { parseAmountToCents } from "@/lib/money";
import { IN_ARRAY_CHUNK, applyRules, rememberPattern } from "@/lib/rules-server";
import { deleteTransactionRow } from "@/lib/transaction-delete";

const { transactions } = schema;

export type TxFormState = { error?: string } | undefined;

const optionalId = z
  .string()
  .optional()
  .transform((v) => (v ? v : null))
  .pipe(z.uuid().nullable());

const txForm = z.object({
  date: z.string().refine(isIsoDate, "Pick a valid date."),
  direction: z.enum(["in", "out"]),
  amount: z.string().min(1, "Enter an amount."),
  description: z.string().trim().min(1, "Add a short description.").max(300),
  categoryId: optionalId,
  stylistId: optionalId,
  note: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || null),
});

function parseTxForm(formData: FormData) {
  const parsed = txForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." } as const;
  const cents = parseAmountToCents(parsed.data.amount);
  if (cents === null || cents === 0) return { error: "Enter an amount like 125.00." } as const;
  const amountCents = Math.abs(cents) * (parsed.data.direction === "in" ? 1 : -1);
  return { data: { ...parsed.data, amountCents } } as const;
}

export async function createTransaction(_prev: TxFormState, formData: FormData): Promise<TxFormState> {
  const user = await requireUser();
  const result = parseTxForm(formData);
  if ("error" in result) return { error: result.error };
  const { date, amountCents, description, note } = result.data;
  let { categoryId, stylistId } = result.data;

  // Nothing picked? Let rules and stylist matching have a go.
  if (!categoryId) {
    const auto = (await getCategorizer())({ date, amountCents, description });
    categoryId = auto.categoryId;
    stylistId = stylistId ?? auto.stylistId;
  }

  const db = await getDb();
  await db.insert(transactions).values({
    date,
    amountCents,
    description,
    note,
    categoryId,
    stylistId,
    source: "manual",
    createdBy: user.userId,
  });
  redirect(`/transactions?month=${monthOf(date)}`);
}

export async function updateTransaction(_prev: TxFormState, formData: FormData): Promise<TxFormState> {
  await requireUser();
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) return { error: "Missing transaction." };
  const result = parseTxForm(formData);
  if ("error" in result) return { error: result.error };
  const { date, amountCents, description, note, categoryId, stylistId } = result.data;

  const db = await getDb();
  await db
    .update(transactions)
    .set({ date, amountCents, description, note, categoryId, stylistId, updatedAt: new Date() })
    .where(eq(transactions.id, id.data));
  redirect(`/transactions?month=${monthOf(date)}`);
}

/** Bank feed rows are refused (see deleteTransactionRow); the edit page doesn't offer Delete for them. */
export async function deleteTransaction(formData: FormData) {
  await requireUser();
  const id = z.uuid().parse(formData.get("id"));
  const month = String(formData.get("month") ?? "");
  if (!(await deleteTransactionRow(await getDb(), id))) redirect(`/transactions/${id}`);
  redirect(month ? `/transactions?month=${month}` : "/transactions");
}

/** Inbox quick-categorize. Optionally saves a rule so similar transactions sort themselves next time. */
export async function categorizeTransaction(formData: FormData) {
  await requireUser();
  const input = z
    .object({
      id: z.uuid(),
      categoryId: z.uuid(),
      stylistId: optionalId,
      remember: z.string().optional(),
      pattern: z.string().trim().max(100).optional(),
      direction: z.enum(["in", "out"]).optional(),
    })
    .safeParse(Object.fromEntries(formData));
  if (!input.success) return;
  const { id, categoryId, stylistId, remember, pattern, direction } = input.data;

  const db = await getDb();
  await db
    .update(transactions)
    .set({ categoryId, stylistId, updatedAt: new Date() })
    .where(eq(transactions.id, id));

  if (remember && pattern && pattern.length >= 3) {
    const [tx] = await db
      .select({ date: transactions.date, amountCents: transactions.amountCents, description: transactions.description })
      .from(transactions)
      .where(eq(transactions.id, id));
    const saved = await rememberPattern({
      pattern,
      categoryId,
      stylistId,
      direction: direction ?? "any",
      samples: tx ? [tx] : [],
    });
    if (saved) await applyRules();
  }
  refresh();
}

/**
 * Inbox group sort: one category (and optional stylist) for many rows at once. Only rows still
 * uncategorized are touched, so it never clobbers something categorized in the meantime.
 */
export async function categorizeGroup(formData: FormData) {
  await requireUser();
  const input = z
    .object({
      ids: z
        .string()
        .transform((v) => v.split(",").filter(Boolean))
        .pipe(z.array(z.uuid()).min(1).max(2000)),
      categoryId: z.uuid(),
      stylistId: optionalId,
      remember: z.string().optional(),
      pattern: z.string().trim().max(100).optional(),
      direction: z.enum(["in", "out"]),
    })
    .safeParse(Object.fromEntries(formData));
  if (!input.success) return;
  const { ids, categoryId, remember, pattern, direction } = input.data;
  // Stylists only make sense for money in.
  const stylistId = direction === "in" ? input.data.stylistId : null;

  const db = await getDb();
  for (const part of chunk(ids, IN_ARRAY_CHUNK)) {
    await db
      .update(transactions)
      .set({ categoryId, stylistId, updatedAt: new Date() })
      .where(and(inArray(transactions.id, part), isNull(transactions.categoryId)));
  }

  if (remember && pattern && pattern.length >= 3) {
    const samples: { date: string; amountCents: number; description: string }[] = [];
    for (const part of chunk(ids, IN_ARRAY_CHUNK)) {
      samples.push(
        ...(await db
          .select({ date: transactions.date, amountCents: transactions.amountCents, description: transactions.description })
          .from(transactions)
          .where(inArray(transactions.id, part))),
      );
    }
    await rememberPattern({ pattern, categoryId, stylistId, direction, samples });
  }
  await applyRules();
  refresh();
}

export async function applyRulesToUncategorized() {
  await requireUser();
  await applyRules();
  refresh();
}
