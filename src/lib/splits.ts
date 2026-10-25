/**
 * Split transactions: one bank row divided into category lines (e.g. a deposit covering two
 * stylists' rent, or a Square deposit net of fees: +$103 sales and -$3 fees on +$100).
 * Pure: the editor uses it for live feedback and the server action re-checks with it.
 */
import { MAX_CENTS } from "./money";

export const MIN_SPLIT_LINES = 2;
export const MAX_SPLIT_LINES = 30;
export const MAX_SPLIT_MEMO = 200;

export type SplitLineInput = {
  categoryId: string;
  stylistId: string | null;
  amountCents: number;
  memo: string | null;
};

export type SplitCategoryRef = { id: string; archived: boolean };

export type SplitContext = {
  parentAmountCents: number;
  /** Every category (archived included); a line can only use one that exists and isn't archived. */
  categories: SplitCategoryRef[];
  boothRentCategoryId: string | null;
  /** Known stylist ids; a line's stylist must be one of them. */
  stylistIds: Iterable<string>;
};

export type SplitValidation =
  | { ok: true; lines: SplitLineInput[] }
  | { ok: false; error: string; line?: number };

/** Sum of line amounts in cents. */
export function splitTotal(lines: { amountCents: number }[]): number {
  return lines.reduce((s, l) => s + l.amountCents, 0);
}

/**
 * What's left to assign, measured in the parent's direction: positive = still unassigned,
 * negative = the lines are over. For a -$50 purchase with a -$40 line that's +$10 left.
 */
export function leftToAssign(parentAmountCents: number, lines: { amountCents: number }[]): number {
  const left = parentAmountCents - splitTotal(lines);
  return parentAmountCents < 0 ? -left : left;
}

/**
 * Checks every invariant of a split and returns the normalized lines (memo trimmed, empty → null).
 * `line` in an error is 1-based, for messages like "Line 2 needs a stylist".
 * - at least 2 lines (and a sane maximum);
 * - every amount is a nonzero integer number of cents within the column's range;
 * - the amounts sum exactly to the parent amount;
 * - every category exists and isn't archived;
 * - Booth Rent lines have a stylist, and any stylist given exists.
 */
export function validateSplit(lines: SplitLineInput[], ctx: SplitContext): SplitValidation {
  if (lines.length < MIN_SPLIT_LINES) return { ok: false, error: "A split needs at least 2 lines." };
  if (lines.length > MAX_SPLIT_LINES) return { ok: false, error: `A split can have at most ${MAX_SPLIT_LINES} lines.` };

  const cats = new Map(ctx.categories.map((c) => [c.id, c]));
  const stylists = new Set(ctx.stylistIds);
  const out: SplitLineInput[] = [];

  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    if (!Number.isSafeInteger(l.amountCents) || l.amountCents === 0) {
      return { ok: false, error: `Line ${n} needs an amount.`, line: n };
    }
    if (Math.abs(l.amountCents) > MAX_CENTS) return { ok: false, error: `Line ${n} is too large.`, line: n };
    const cat = l.categoryId ? cats.get(l.categoryId) : undefined;
    if (!cat) return { ok: false, error: `Line ${n} needs a category.`, line: n };
    if (cat.archived) return { ok: false, error: `Line ${n} uses a hidden category. Pick another.`, line: n };
    if (l.stylistId && !stylists.has(l.stylistId)) {
      return { ok: false, error: `Line ${n} has a stylist that no longer exists.`, line: n };
    }
    if (ctx.boothRentCategoryId && cat.id === ctx.boothRentCategoryId && !l.stylistId) {
      return { ok: false, error: `Line ${n} is Booth Rent, so pick the stylist.`, line: n };
    }
    const memo = (l.memo ?? "").trim();
    if (memo.length > MAX_SPLIT_MEMO) return { ok: false, error: `Line ${n}'s memo is too long.`, line: n };
    out.push({ categoryId: cat.id, stylistId: l.stylistId || null, amountCents: l.amountCents, memo: memo || null });
  }

  const left = leftToAssign(ctx.parentAmountCents, out);
  if (left !== 0) {
    const abs = (Math.abs(left) / 100).toFixed(2);
    return {
      ok: false,
      error: `The lines must add up to the transaction: ${left > 0 ? `$${abs} is still unassigned.` : `they're $${abs} over.`}`,
    };
  }
  return { ok: true, lines: out };
}
