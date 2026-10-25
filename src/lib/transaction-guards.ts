/**
 * What may change on a transaction. Free of Next imports so it runs against any `Db` (PGlite in tests).
 * A feed-linked row (it has a bank `externalId`, whatever its source: a feed row, or a manual entry the
 * feed matched) is real bank activity: its amount and date can't change and it can't be deleted, or
 * the next sync would bring it back. Its description, category, stylist and note stay editable.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

const { transactions } = schema;

export const FEED_LOCKED_NOTE = "From your bank feed, so the amount and date come from the bank.";
export const FEED_EDIT_ERROR = "This came from your bank feed, so its amount and date can't change.";

export function isFeedLinked(tx: { externalId: string | null }): boolean {
  return tx.externalId !== null;
}

type Outcome = "ok" | "feed_linked" | "missing";

async function why(db: Pick<Db, "select">, id: string): Promise<Exclude<Outcome, "ok">> {
  const [row] = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, id));
  return row ? "feed_linked" : "missing";
}

/** Deletes a row that isn't feed-linked, in one guarded statement. */
export async function deleteTransactionRow(db: Pick<Db, "delete" | "select">, id: string): Promise<Outcome> {
  const gone = await db
    .delete(transactions)
    .where(and(eq(transactions.id, id), isNull(transactions.externalId)))
    .returning({ id: transactions.id });
  return gone.length ? "ok" : why(db, id);
}

export type TransactionEdit = Pick<
  schema.NewTransaction,
  "date" | "amountCents" | "description" | "note" | "categoryId" | "stylistId"
>;

/** Saves an edit, refusing one that changes a feed-linked row's amount or date (same statement). */
export async function updateTransactionRow(db: Pick<Db, "update" | "select">, id: string, edit: TransactionEdit): Promise<Outcome> {
  const saved = await db
    .update(transactions)
    .set({ ...edit, updatedAt: new Date() })
    .where(
      and(
        eq(transactions.id, id),
        or(isNull(transactions.externalId), and(eq(transactions.date, edit.date), eq(transactions.amountCents, edit.amountCents))),
      ),
    )
    .returning({ id: transactions.id });
  return saved.length ? "ok" : why(db, id);
}
