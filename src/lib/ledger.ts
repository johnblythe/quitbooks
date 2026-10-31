/**
 * Ledger lines: the unit everything that groups by category works on. An unsplit transaction is
 * one line; a split transaction is one line per split, each carrying the parent's date. Lines of a
 * split sum to the parent amount, so totals and the bank balance are unchanged by splitting.
 * Pure, so the dashboard, reports, CSV exports and tests share one expansion.
 */
import type { IsoDate } from "./dates";
import type { MetricTx } from "./metrics";

/** The fields of a stored transaction the expansion needs. Split parents have no category. */
export type LedgerTx = {
  id: string;
  date: IsoDate;
  amountCents: number;
  categoryId: string | null;
  stylistId: string | null;
  isSplit: boolean;
};

/** One stored split line. */
export type LedgerSplit = {
  transactionId: string;
  position: number;
  categoryId: string;
  stylistId: string | null;
  amountCents: number;
  memo: string | null;
};

export type LedgerLine<T extends LedgerTx = LedgerTx, S extends LedgerSplit = LedgerSplit> = {
  tx: T;
  /** The split this line came from, or null when the line is the whole (unsplit) transaction. */
  split: S | null;
  /** 1-based line number within its split, and how many lines the split has (1 of 1 if unsplit). */
  index: number;
  count: number;
  date: IsoDate;
  amountCents: number;
  categoryId: string | null;
  stylistId: string | null;
  memo: string | null;
};

/**
 * Expands transactions into ledger lines, keeping the transactions' order and each split's line
 * order. A row flagged split with no lines (shouldn't happen) stays one uncategorized line, so
 * totals still tie out to the bank instead of silently dropping money.
 */
export function expandLedgerLines<T extends LedgerTx, S extends LedgerSplit>(txs: T[], splits: S[]): LedgerLine<T, S>[] {
  const byTx = new Map<string, S[]>();
  for (const s of splits) {
    const list = byTx.get(s.transactionId);
    if (list) list.push(s);
    else byTx.set(s.transactionId, [s]);
  }
  for (const list of byTx.values()) list.sort((a, b) => a.position - b.position);

  const out: LedgerLine<T, S>[] = [];
  for (const tx of txs) {
    const lines = tx.isSplit ? byTx.get(tx.id) : undefined;
    if (!lines?.length) {
      out.push({
        tx,
        split: null,
        index: 1,
        count: 1,
        date: tx.date,
        amountCents: tx.amountCents,
        categoryId: tx.isSplit ? null : tx.categoryId,
        stylistId: tx.isSplit ? null : tx.stylistId,
        memo: null,
      });
      continue;
    }
    lines.forEach((s, i) =>
      out.push({
        tx,
        split: s,
        index: i + 1,
        count: lines.length,
        date: tx.date,
        amountCents: s.amountCents,
        categoryId: s.categoryId,
        stylistId: s.stylistId,
        memo: s.memo,
      }),
    );
  }
  return out;
}

/** The plain shape `src/lib/metrics.ts` works on. */
export function toMetricTxs(lines: LedgerLine[]): MetricTx[] {
  return lines.map((l) => ({ date: l.date, amountCents: l.amountCents, categoryId: l.categoryId, stylistId: l.stylistId }));
}

/**
 * Money in and money out for a list, leaving transfers out (they aren't income or spending).
 * Pass ledger lines, so a split's transfer portion is excluded and a net deposit's fees count as
 * money out. `kind` is the line's category kind (null = uncategorized).
 */
export function inOutTotals(items: { amountCents: number; kind: "income" | "expense" | "transfer" | null }[]): {
  moneyIn: number;
  moneyOut: number;
} {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const l of items) {
    if (l.kind === "transfer") continue;
    if (l.amountCents > 0) moneyIn += l.amountCents;
    else moneyOut -= l.amountCents;
  }
  return { moneyIn, moneyOut };
}
