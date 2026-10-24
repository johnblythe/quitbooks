"use server";

import { and, eq, isNull } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { SETTING_KEYS } from "@/db/defaults";
import { requireUser } from "@/lib/auth";
import { isIsoDate } from "@/lib/dates";
import { parseAmountToCents } from "@/lib/money";

const { categories, rules, settings } = schema;

export type SettingsState = { error?: string; ok?: string } | undefined;

async function setSetting(key: string, value: unknown) {
  const db = await getDb();
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function saveBusinessSettings(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  await requireUser();
  const chairs = Number(formData.get("totalChairs"));
  if (!Number.isInteger(chairs) || chairs < 0 || chairs > 100) return { error: "Chairs should be a whole number." };

  const balanceRaw = String(formData.get("openingBalance") ?? "").trim();
  const asOf = String(formData.get("openingBalanceAsOf") ?? "").trim();
  if (balanceRaw || asOf) {
    const cents = parseAmountToCents(balanceRaw);
    if (cents === null) return { error: "Enter the opening balance like 5,000.00." };
    if (!isIsoDate(asOf)) return { error: "Pick the date that balance was as of." };
    await setSetting(SETTING_KEYS.openingBalance, { cents, asOf });
  }
  await setSetting(SETTING_KEYS.totalChairs, chairs);
  refresh();
  return { ok: "Saved." };
}

export async function addCategory(formData: FormData) {
  await requireUser();
  const input = z
    .object({ name: z.string().trim().min(1).max(60), kind: z.enum(["income", "expense", "transfer"]) })
    .safeParse(Object.fromEntries(formData));
  if (!input.success) return;
  const db = await getDb();
  await db.insert(categories).values({ ...input.data, sortOrder: 1000 });
  refresh();
}

export async function renameCategory(formData: FormData) {
  await requireUser();
  const input = z
    .object({ id: z.uuid(), name: z.string().trim().min(1).max(60) })
    .safeParse(Object.fromEntries(formData));
  if (!input.success) return;
  const db = await getDb();
  await db.update(categories).set({ name: input.data.name }).where(eq(categories.id, input.data.id));
  refresh();
}

/** Archive hides a category from pickers but keeps history intact. System categories can't be archived. */
export async function toggleCategoryArchived(formData: FormData) {
  await requireUser();
  const id = z.uuid().parse(formData.get("id"));
  const archived = formData.get("archived") === "true";
  const db = await getDb();
  await db
    .update(categories)
    .set({ archived })
    .where(and(eq(categories.id, id), isNull(categories.systemKey)));
  refresh();
}

export async function addRule(formData: FormData) {
  await requireUser();
  const input = z
    .object({
      pattern: z.string().trim().min(3).max(100),
      categoryId: z.uuid(),
      direction: z.enum(["any", "in", "out"]),
    })
    .safeParse(Object.fromEntries(formData));
  if (!input.success) return;
  const db = await getDb();
  await db.insert(rules).values(input.data);
  refresh();
}

export async function deleteRule(formData: FormData) {
  await requireUser();
  const id = z.uuid().parse(formData.get("id"));
  const db = await getDb();
  await db.delete(rules).where(eq(rules.id, id));
  refresh();
}
