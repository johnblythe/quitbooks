/**
 * Undoing a CSV import, free of Next/auth imports so tests can run it against PGlite. The server
 * actions in `src/app/actions/import-undo.ts` authenticate, validate the id and call into here.
 *
 * An undo deletes the rows the import inserted (source 'csv', tagged with the batch id; their split
 * lines cascade) and stamps the batch `undone_at`. It deliberately leaves alone:
 * - manual entries the import linked: they're the user's own rows, and the dedupe hash the import
 *   put on them is still right (it keeps that bank line from being imported a second time);
 * - categories the import created, the saved column mapping and its remembered choices;
 * - the batch row itself, so Recent imports keeps a history.
 * If any of the batch's rows has since been matched to the bank feed, the whole undo is refused:
 * feed-linked rows are real bank activity and are never deleted (see `transaction-guards.ts`).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

const { transactions, importBatches } = schema;

export type UndoBatch = { id: string; filename: string; createdAt: Date; undoneAt: Date | null };

export type UndoRow = {
  id: string;
  amountCents: number;
  categoryId: string | null;
  isSplit: boolean;
  externalId: string | null;
  updatedAt: Date;
};

export type UndoCounts = {
  filename: string;
  /** Transactions the undo deletes. */
  removed: number;
  /** Of those, how many have a category, are split, or were edited after the import. */
  touched: number;
  /** Sum of the removed amounts, in cents (signed: positive = money in). */
  netCents: number;
};

export type UndoPlan = ({ ok: true; ids: string[] } & UndoCounts) | { ok: false; error: string };

export const UNDO_MISSING = "That import no longer exists.";
export const UNDO_ALREADY = "That import was already undone.";

export function feedLinkedError(n: number): string {
  return n === 1
    ? "1 transaction from this import is matched to your bank feed, so the import can't be undone. Nothing was changed."
    : `${n} transactions from this import are matched to your bank feed, so the import can't be undone. Nothing was changed.`;
}

/**
 * Decides what an undo would do, from the batch and its csv rows. Pure, so the preview and the
 * undo can't disagree. A row inserted by the import has `updatedAt` equal to the batch's
 * `createdAt` (both are the import transaction's `now()`); any later edit bumps `updatedAt`.
 */
export function planImportUndo(batch: UndoBatch | undefined, rows: UndoRow[]): UndoPlan {
  if (!batch) return { ok: false, error: UNDO_MISSING };
  if (batch.undoneAt) return { ok: false, error: UNDO_ALREADY };
  const linked = rows.filter((r) => r.externalId !== null).length;
  if (linked) return { ok: false, error: feedLinkedError(linked) };
  const since = batch.createdAt.getTime();
  return {
    ok: true,
    filename: batch.filename,
    ids: rows.map((r) => r.id),
    removed: rows.length,
    touched: rows.filter((r) => r.categoryId !== null || r.isSplit || r.updatedAt.getTime() > since).length,
    netCents: rows.reduce((sum, r) => sum + r.amountCents, 0),
  };
}

export type UndoResult = ({ ok: true } & UndoCounts) | { ok: false; error: string };

type Reader = Pick<Db, "select">;

const rowColumns = {
  id: transactions.id,
  amountCents: transactions.amountCents,
  categoryId: transactions.categoryId,
  isSplit: transactions.isSplit,
  externalId: transactions.externalId,
  updatedAt: transactions.updatedAt,
};

const batchColumns = {
  id: importBatches.id,
  filename: importBatches.filename,
  createdAt: importBatches.createdAt,
  undoneAt: importBatches.undoneAt,
};

const batchRows = (batchId: string) => and(eq(transactions.importBatchId, batchId), eq(transactions.source, "csv"));

function counts(plan: Extract<UndoPlan, { ok: true }>): UndoCounts {
  return { filename: plan.filename, removed: plan.removed, touched: plan.touched, netCents: plan.netCents };
}

/** What undoing the batch would remove, for the confirmation step. Changes nothing. */
export async function previewImportUndo(db: Reader, batchId: string): Promise<UndoResult> {
  const [batch] = await db.select(batchColumns).from(importBatches).where(eq(importBatches.id, batchId));
  const rows = batch ? await db.select(rowColumns).from(transactions).where(batchRows(batchId)) : [];
  const plan = planImportUndo(batch, rows);
  return plan.ok ? { ok: true, ...counts(plan) } : plan;
}

/** Thrown inside the transaction to roll it back when a row changed under the undo. */
class UndoRaceError extends Error {}

/**
 * Undoes the batch in ONE transaction. The batch row and its csv rows are locked first, so a second
 * undo (or a bank sync matching one of the rows) waits and then sees the outcome. Refusals change
 * nothing.
 */
export async function undoImport(db: Db, batchId: string, userId: string): Promise<UndoResult> {
  try {
    return await db.transaction(async (tx) => {
      const [batch] = await tx
        .select(batchColumns)
        .from(importBatches)
        .where(eq(importBatches.id, batchId))
        .for("update");
      const rows = batch
        ? await tx.select(rowColumns).from(transactions).where(batchRows(batchId)).for("update")
        : [];
      const plan = planImportUndo(batch, rows);
      if (!plan.ok) return plan;

      let deleted = 0;
      for (let i = 0; i < plan.ids.length; i += 500) {
        const gone = await tx
          .delete(transactions)
          .where(and(inArray(transactions.id, plan.ids.slice(i, i + 500)), isNull(transactions.externalId)))
          .returning({ id: transactions.id });
        deleted += gone.length;
      }
      if (deleted !== plan.removed) throw new UndoRaceError();

      await tx
        .update(importBatches)
        .set({ undoneAt: new Date(), undoneBy: userId })
        .where(eq(importBatches.id, batchId));
      return { ok: true, ...counts(plan) } as const;
    });
  } catch (e) {
    if (e instanceof UndoRaceError) {
      return { ok: false, error: "Some of these transactions changed while undoing. Nothing was changed; try again." };
    }
    throw e;
  }
}
