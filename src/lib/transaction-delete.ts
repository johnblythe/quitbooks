/**
 * Deleting transactions. Free of Next imports so it runs against any `Db` (PGlite in tests).
 * Bank feed rows can't be deleted: they are real bank activity, and the next sync would bring them
 * back anyway. Manual and CSV rows can.
 */
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

const { transactions } = schema;

export function canDeleteTransaction(source: schema.Transaction["source"]): boolean {
  return source !== "bank_sync";
}

/** Deletes the row unless it came from the bank feed. Returns whether anything was deleted. */
export async function deleteTransactionRow(db: Pick<Db, "delete">, id: string): Promise<boolean> {
  const gone = await db
    .delete(transactions)
    .where(and(eq(transactions.id, id), ne(transactions.source, "bank_sync")))
    .returning({ id: transactions.id });
  return gone.length > 0;
}
