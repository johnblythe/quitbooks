/**
 * Mapping the categories a file already carries (a QuickBooks "Split" column, a card export's
 * "Category") onto ours. Pure and free of server imports, so the import screen can use the same code
 * the commit does.
 */

export type CategoryKind = "income" | "expense" | "transfer";

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

const TRANSFERISH = /owner|draw|equity|contribution|distribution|transfer/i;

/** Owner equity and money moved between accounts aren't income or expense. */
export function looksLikeTransfer(value: string): boolean {
  return TRANSFERISH.test(value);
}

/** Distinct non-blank values with their row counts and net totals, most-used first. */
export function summarizeFileCategories(rows: { category: string; amountCents: number }[]): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();
  for (const r of rows) {
    const key = categoryKey(r.category);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, value: r.category.replace(/\s+/g, " ").trim(), count: 0, netCents: 0, inCount: 0, outCount: 0 };
      groups.set(key, g);
    }
    g.count++;
    g.netCents += r.amountCents;
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
 * otherwise create it.
 */
export function defaultChoice(
  g: CategoryGroup,
  categories: CategoryOption[],
  saved?: Record<string, SavedCategoryChoice>,
): FileCategoryChoice {
  const remembered = saved?.[g.key];
  if (remembered?.type === "inbox") return remembered;
  if (remembered?.type === "existing" && categories.some((c) => c.id === remembered.categoryId && !c.archived)) {
    return remembered;
  }
  const exact = categories.find((c) => !c.archived && categoryKey(c.name) === g.key);
  if (exact) return { type: "existing", categoryId: exact.id };
  if (isPlaceholderCategory(g.value)) return { type: "inbox" };
  return { type: "new", name: g.value.slice(0, 60), kind: guessKind(g) };
}

export function defaultChoices(
  groups: CategoryGroup[],
  categories: CategoryOption[],
  saved?: Record<string, SavedCategoryChoice>,
): Record<string, FileCategoryChoice> {
  return Object.fromEntries(groups.map((g) => [g.key, defaultChoice(g, categories, saved)]));
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
