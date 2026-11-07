"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser } from "@/lib/auth";
import { previewImportUndo, undoImport, type UndoResult } from "@/lib/import-undo";

export type UndoImportState = { ok: boolean; message: string };

const BAD_ID = "That import couldn't be found. Reload and try again.";

function plural(n: number) {
  return `${n} transaction${n === 1 ? "" : "s"}`;
}

/** The counts for the confirmation step. Changes nothing. */
export async function previewImportUndoAction(batchId: string): Promise<UndoResult> {
  await requireUser();
  const id = z.uuid().safeParse(batchId);
  if (!id.success) return { ok: false, error: BAD_ID };
  const result = await previewImportUndo(await getDb(), id.data);
  // A refusal ("already undone" in another tab, or gone) means the row's Undo button is stale.
  if (!result.ok) refresh();
  return result;
}

/** Deletes the batch's imported rows and marks it undone. */
export async function undoImportAction(batchId: string): Promise<UndoImportState> {
  const user = await requireUser();
  const id = z.uuid().safeParse(batchId);
  if (!id.success) return { ok: false, message: BAD_ID };
  const result = await undoImport(await getDb(), id.data, user.userId);
  // Refresh on a refusal too: "already undone" / "gone" means the row's Undo button is stale.
  refresh();
  if (!result.ok) return { ok: false, message: result.error };
  return {
    ok: true,
    message: result.removed
      ? `Removed ${plural(result.removed)} from ${result.filename}.`
      : `Marked ${result.filename} as undone. None of its transactions were left to remove.`,
  };
}
