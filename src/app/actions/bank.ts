"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { connectBank, disconnectBank, saveBankSelection, syncConnectionThrottled } from "@/lib/bank-sync-server";
import { redactSecrets } from "@/lib/simplefin";

export type BankState = { error?: string; ok?: string } | undefined;

/** Error text that is safe to show: credentials stripped (messages never include secrets by construction). */
function safeMessage(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : "Something went wrong.");
}

function syncMessage(r: Awaited<ReturnType<typeof syncConnectionThrottled>>): BankState {
  if (r.throttled) {
    return { ok: `Synced a moment ago. Try again in about ${r.retryInMinutes} minute${r.retryInMinutes === 1 ? "" : "s"}.` };
  }
  if (r.errors.length) return { error: redactSecrets(r.errors.join("; ")) };
  return { ok: `Synced: ${r.inserted} new, ${r.linked} matched to entries you typed in.` };
}

/** Claims the one-time setup token and stores the accounts. The next step picks accounts and a start date. */
export async function connectBankAction(_prev: BankState, formData: FormData): Promise<BankState> {
  await requireUser();
  const token = z.string().trim().min(10).max(2000).safeParse(formData.get("token"));
  if (!token.success) return { error: "Paste the setup token from SimpleFIN." };
  const db = await getDb();
  const [existing] = await db.select({ id: schema.bankConnections.id }).from(schema.bankConnections).limit(1);
  if (existing) return { error: "A bank is already connected. Disconnect it first." };
  try {
    await connectBank({ db }, token.data);
  } catch (e) {
    return { error: safeMessage(e) };
  }
  refresh();
  return { ok: "Connected. Pick the account to sync." };
}

/** Saves the chosen accounts and start date, then runs the first sync. */
export async function saveBankSetupAction(_prev: BankState, formData: FormData): Promise<BankState> {
  await requireUser();
  const input = z
    .object({
      connectionId: z.uuid(),
      cutoverDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      accountIds: z.array(z.uuid()).min(1, "Tick at least one account."),
    })
    .safeParse({
      connectionId: formData.get("connectionId"),
      cutoverDate: formData.get("cutoverDate"),
      accountIds: formData.getAll("accountId"),
    });
  if (!input.success) return { error: input.error.issues[0]?.message ?? "Check the form." };
  const db = await getDb();
  try {
    await saveBankSelection(db, input.data.connectionId, {
      includeAccountIds: input.data.accountIds,
      cutoverDate: input.data.cutoverDate,
    });
    const r = await syncConnectionThrottled({ db }, input.data.connectionId);
    refresh();
    return syncMessage(r);
  } catch (e) {
    return { error: safeMessage(e) };
  }
}

export async function syncBankNowAction(_prev: BankState, formData: FormData): Promise<BankState> {
  await requireUser();
  const id = z.uuid().safeParse(formData.get("connectionId"));
  if (!id.success) return { error: "Unknown connection." };
  try {
    const r = await syncConnectionThrottled({ db: await getDb() }, id.data);
    refresh();
    return syncMessage(r);
  } catch (e) {
    return { error: safeMessage(e) };
  }
}

/** Deletes the connection, accounts and encrypted URL. Imported transactions stay. */
export async function disconnectBankAction(formData: FormData) {
  await requireUser();
  const id = z.uuid().safeParse(formData.get("connectionId"));
  if (!id.success) return;
  await disconnectBank(await getDb(), id.data);
  refresh();
}
