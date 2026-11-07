/**
 * Pure state rules for the import screen, kept out of the component so they can be tested.
 */
import type { CategoryGroup, CategoryOption, FileCategoryChoice } from "./import-categories";

/**
 * The choices to show after a (re-)preview. Start from the server's defaults, and keep the user's
 * earlier pick only for groups they actually edited (`touched`) that still exist in the new preview.
 * An "existing" pick whose category is no longer offered (hidden or deleted meanwhile) falls back to
 * the default instead of being sent and rejected.
 */
export function reconcileChoices(
  groups: Pick<CategoryGroup, "key">[],
  defaults: Record<string, FileCategoryChoice>,
  prev: Record<string, FileCategoryChoice>,
  touched: ReadonlySet<string>,
  categories: Pick<CategoryOption, "id">[],
): Record<string, FileCategoryChoice> {
  const offered = new Set(categories.map((c) => c.id));
  const out: Record<string, FileCategoryChoice> = {};
  for (const g of groups) {
    const kept = prev[g.key];
    const keep = touched.has(g.key) && kept && (kept.type !== "existing" || offered.has(kept.categoryId));
    out[g.key] = keep ? kept : defaults[g.key];
  }
  return out;
}

/** How many "Create new" choices have a blank name; each would fail the import. */
export function unnamedNewCount(
  groups: (Pick<CategoryGroup, "key"> & { choice: FileCategoryChoice })[],
  choices: Record<string, FileCategoryChoice>,
): number {
  let n = 0;
  for (const g of groups) {
    const c = choices[g.key] ?? g.choice;
    if (c.type === "new" && !c.name.trim()) n++;
  }
  return n;
}

export const UNNAMED_CATEGORY_HINT = "Name each new category or pick another option.";

/** "1 row" / "3 rows". */
export function rowsLabel(n: number): string {
  return `${n} ${n === 1 ? "row" : "rows"}`;
}

/** Only offer to import without unreadable rows when something is left to import. */
export function canAcknowledgeErrors(errorCount: number, newCount: number): boolean {
  return errorCount > 0 && newCount > 0;
}
