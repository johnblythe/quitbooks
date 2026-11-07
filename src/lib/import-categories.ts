/**
 * Mapping the categories a file already carries (a QuickBooks "Split" column, a card export's
 * "Category") onto ours. Pure and free of server imports, so the import screen can use the same code
 * the commit does.
 */

export type CategoryKind = "income" | "expense" | "transfer";

/**
 * Name of the saved column mapping (`csv_mappings.name`) for files that carry their own category
 * column (QuickBooks, card exports). Its `categoryMap` holds the remembered choices, which
 * `npm run qbo:compare` also reads to map QuickBooks accounts onto our categories.
 */
export const CATEGORIZED_MAPPING_NAME = "BMO:categories";

/** What to do with one distinct value from the file's category column. */
export type FileCategoryChoice =
  | { type: "existing"; categoryId: string }
  | { type: "new"; name: string; kind: CategoryKind }
  | { type: "inbox" };

/** What we remember between imports. A "new" choice is remembered as the category it created. */
export type SavedCategoryChoice = { type: "existing"; categoryId: string } | { type: "inbox" };

export type CategoryGroup = {
  /** `categoryKey(value)`; what choices and the saved map are keyed by. */
  key: string;
  /** The first spelling seen in the file. */
  value: string;
  count: number;
  /** Sum of the signed amounts, in cents. */
  netCents: number;
  inCount: number;
  outCount: number;
  /** Rows whose automatic categorization is Booth Rent with a stylist (the file may call it anything). */
  stylistRentCount: number;
};

export type CategoryOption = { id: string; name: string; kind: CategoryKind; archived?: boolean };

export function categoryKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

const PLACEHOLDERS = new Set([
  "uncategorized income",
  "uncategorized expense",
  "uncategorized asset",
  "ask my accountant",
]);

/** QuickBooks' stand-ins for "not categorized": splits, uncategorized buckets, and nothing at all. */
export function isPlaceholderCategory(value: string): boolean {
  const k = categoryKey(value);
  return k === "" || PLACEHOLDERS.has(k) || /^-+\s*split\s*-+$/.test(k);
}

// Whole words only: "ATM Withdrawal Fees" has "draw", "Charitable Contributions" has "contribution".
const NOT_TRANSFER = /\b(fees?|charges?|charitable|shortage)\b/i;
const TRANSFERISH =
  /\b(owner'?s?|draws?|drawings|equity|distributions?)\b|\b(owner|capital|member)'?s? contributions?\b|\btransfers?\b/i;

/** Owner equity and money moved between accounts aren't income or expense. */
export function looksLikeTransfer(value: string): boolean {
  return !NOT_TRANSFER.test(value) && TRANSFERISH.test(value);
}

/** Distinct non-blank values with their row counts and net totals, most-used first. */
export function summarizeFileCategories(
  rows: { category: string; amountCents: number; stylistRent?: boolean }[],
): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();
  for (const r of rows) {
    const key = categoryKey(r.category);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, value: r.category.replace(/\s+/g, " ").trim(), count: 0, netCents: 0, inCount: 0, outCount: 0, stylistRentCount: 0 };
      groups.set(key, g);
    }
    g.count++;
    g.netCents += r.amountCents;
    if (r.stylistRent) g.stylistRentCount++;
    if (r.amountCents > 0) g.inCount++;
    else if (r.amountCents < 0) g.outCount++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Kind for a brand-new category: owner-equity looking names are transfers, else by which way most rows went. */
export function guessKind(g: Pick<CategoryGroup, "value" | "inCount" | "outCount" | "netCents">): CategoryKind {
  if (looksLikeTransfer(g.value)) return "transfer";
  if (g.inCount !== g.outCount) return g.inCount > g.outCount ? "income" : "expense";
  return g.netCents > 0 ? "income" : "expense";
}

/**
 * The starting choice for a value, in order: what was remembered from an earlier import (if that
 * category still exists), an exact case-insensitive name match, QuickBooks placeholders -> Inbox,
 * Booth Rent when most of the rows already match a stylist's rent (QuickBooks may call it "Rental
 * Income" or "Chair Rent"), otherwise create it.
 */
export function defaultChoice(
  g: CategoryGroup,
  categories: CategoryOption[],
  saved?: Record<string, SavedCategoryChoice>,
  boothRentId?: string | null,
): FileCategoryChoice {
  const remembered = saved?.[g.key];
  if (remembered?.type === "inbox") return remembered;
  if (remembered?.type === "existing" && categories.some((c) => c.id === remembered.categoryId && !c.archived)) {
    return remembered;
  }
  const exact = categories.find((c) => !c.archived && categoryKey(c.name) === g.key);
  if (exact) return { type: "existing", categoryId: exact.id };
  if (isPlaceholderCategory(g.value)) return { type: "inbox" };
  if (boothRentId && g.stylistRentCount * 2 > g.count && categories.some((c) => c.id === boothRentId && !c.archived)) {
    return { type: "existing", categoryId: boothRentId };
  }
  return { type: "new", name: g.value.slice(0, 60), kind: guessKind(g) };
}

export function defaultChoices(
  groups: CategoryGroup[],
  categories: CategoryOption[],
  saved?: Record<string, SavedCategoryChoice>,
  boothRentId?: string | null,
): Record<string, FileCategoryChoice> {
  return Object.fromEntries(groups.map((g) => [g.key, defaultChoice(g, categories, saved, boothRentId)]));
}

/**
 * The category and stylist a row gets once the file's own category is taken into account.
 * `fileCategoryId` is the id the row's value resolved to (undefined for Leave for Inbox, a blank
 * value, or no category column), `auto` what rules and stylist matching say.
 * - A file category beats rules: it is the owner's own earlier decision.
 * - Booth Rent still needs a stylist: take the one stylist matching finds, and if there is none the
 *   row goes to the Inbox rather than into Booth Rent with nobody attached.
 */
export function resolveRowCategory(
  fileCategoryId: string | undefined,
  auto: { categoryId: string | null; stylistId: string | null },
  boothRentCategoryId: string | null,
): { categoryId: string | null; stylistId: string | null } {
  if (!fileCategoryId) return auto;
  if (fileCategoryId === boothRentCategoryId) {
    return auto.stylistId ? { categoryId: fileCategoryId, stylistId: auto.stylistId } : { categoryId: null, stylistId: null };
  }
  return { categoryId: fileCategoryId, stylistId: null };
}

/**
 * The category groups shown on the mapping step, each with its starting choice. `rows` carries each
 * row's automatic categorization (rules and stylist matching) so it is computed once, not twice.
 * Rows already in the ledger are left out of the counts, and only money in that the categorizer
 * sent to Booth Rent with a stylist counts as stylist rent. Remembered choices beat the Booth Rent default.
 */
export function buildCategoryGroups(input: {
  rows: { category: string; amountCents: number; duplicate: boolean; auto: { categoryId: string | null; stylistId: string | null } }[];
  options: CategoryOption[];
  remembered?: Record<string, SavedCategoryChoice>;
  boothRentCategoryId: string | null;
}): (CategoryGroup & { choice: FileCategoryChoice })[] {
  const { rows, options, remembered, boothRentCategoryId } = input;
  const groups = summarizeFileCategories(
    rows
      .filter((r) => !r.duplicate)
      .map((r) => ({
        category: r.category,
        amountCents: r.amountCents,
        stylistRent: r.amountCents > 0 && !!boothRentCategoryId && r.auto.categoryId === boothRentCategoryId && !!r.auto.stylistId,
      })),
  );
  const choices = defaultChoices(groups, options, remembered, boothRentCategoryId);
  return groups.map((g) => ({ ...g, choice: choices[g.key] }));
}
