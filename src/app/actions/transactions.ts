"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { matchRule, norm } from "@/lib/categorize";
import { getBoothRentCategoryId, getCategorizer } from "@/lib/data";
import { isIsoDate, monthOf } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";

const { transactions, rules, stylists } = schema;

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

export async function deleteTransaction(formData: FormData) {
  await requireUser();
  const id = z.uuid().parse(formData.get("id"));
  const month = String(formData.get("month") ?? "");
  const db = await getDb();
  await db.delete(transactions).where(eq(transactions.id, id));
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
    // Only remember patterns that actually match this transaction (same semantics as rules).
    const matchesSelf =
      !!tx &&
      matchRule(tx, [{ id: "self", pattern, categoryId, direction: "any", priority: 0 }]) !== null;
    if (matchesSelf) {
      const boothRentId = await getBoothRentCategoryId();
      if (stylistId && boothRentId && categoryId === boothRentId) {
        // Booth rent: teach the stylist's match text instead of creating a rule.
        const [st] = await db.select().from(stylists).where(eq(stylists.id, stylistId));
        if (st) {
          const split = (t: string | null) =>
            (t ?? "")
              .split(/[,;\n]/)
              .map((x) => x.trim())
              .filter(Boolean);
          // No explicit match text means the full name was the implicit term; keep it.
          const existing = split(st.matchText);
          const base = existing.length ? existing : split(st.name);
          if (!base.some((t) => norm(t) === norm(pattern))) {
            await db
              .update(stylists)
              .set({ matchText: [...base, pattern].join(", ") })
              .where(eq(stylists.id, stylistId));
          }
        }
      } else {
        await db.insert(rules).values({ pattern, categoryId, direction: direction ?? "any" });
      }
      await applyRules();
    }
  }
  refresh();
}

/** Re-runs stylist matching and rules over everything still uncategorized. Returns how many were sorted. */
async function applyRules(): Promise<number> {
  const db = await getDb();
  const categorizer = await getCategorizer();
  const open = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      description: transactions.description,
    })
    .from(transactions)
    .where(isNull(transactions.categoryId));

  // Group updates by (category, stylist) so it's a handful of queries, not one per row.
  const groups = new Map<string, { categoryId: string; stylistId: string | null; ids: string[] }>();
  for (const tx of open) {
    const r = categorizer(tx);
    if (!r.categoryId) continue;
    const key = `${r.categoryId}|${r.stylistId ?? ""}`;
    const g = groups.get(key) ?? { categoryId: r.categoryId, stylistId: r.stylistId, ids: [] };
    g.ids.push(tx.id);
    groups.set(key, g);
  }
  let count = 0;
  for (const g of groups.values()) {
    await db
      .update(transactions)
      .set({ categoryId: g.categoryId, stylistId: g.stylistId, updatedAt: new Date() })
      .where(and(inArray(transactions.id, g.ids), isNull(transactions.categoryId)));
    count += g.ids.length;
  }
  return count;
}

export async function applyRulesToUncategorized() {
  await requireUser();
  await applyRules();
  refresh();
}
