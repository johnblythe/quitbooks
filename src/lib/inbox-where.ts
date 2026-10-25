import { and, eq, isNull, type SQL } from "drizzle-orm";
import { transactions } from "@/db/schema";

/**
 * "In the Inbox" = no category AND not split. A split parent also has a null category (its lines
 * carry the categories), so `isNull(category_id)` alone would pull it back into the Inbox, rules,
 * and AI suggestions. Use this everywhere instead.
 */
export function inInbox(): SQL {
  return and(isNull(transactions.categoryId), eq(transactions.isSplit, false))!;
}
