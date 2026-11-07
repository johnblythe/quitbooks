/**
 * Pure state rules for the import screen, kept out of the component so they can be tested.
 */
import { guessKind, type CategoryGroup, type CategoryOption, type FileCategoryChoice } from "./import-categories";

/**
 * The choices to show after a (re-)preview. Start from the server's defaults, and keep the user's
 * earlier pick only for groups they actually edited (`touched`) that still exist in the new preview.
 * An "existing" pick whose category is no longer offered (hidden or deleted meanwhile) falls back to
 * the default instead of being sent and rejected.
 * A kept "Create new" choice keeps the user's name, but its kind is guessed again from the new
 * preview's rows (the "money out as positive" toggle flips signs, and with them the guess) unless
 * the user picked the kind themselves (`kindEdited`), whatever the new default is.
 */
export function reconcileChoices(
  groups: Pick<CategoryGroup, "key" | "value" | "inCount" | "outCount" | "netCents">[],
  defaults: Record<string, FileCategoryChoice>,
  prev: Record<string, FileCategoryChoice>,
  touched: ReadonlySet<string>,
  categories: Pick<CategoryOption, "id">[],
  kindEdited: ReadonlySet<string> = new Set(),
): Record<string, FileCategoryChoice> {
  const offered = new Set(categories.map((c) => c.id));
  const out: Record<string, FileCategoryChoice> = {};
  for (const g of groups) {
    const kept = prev[g.key];
    const keep = touched.has(g.key) && kept && (kept.type !== "existing" || offered.has(kept.categoryId));
    if (!keep) out[g.key] = defaults[g.key];
    else if (kept.type === "new" && !kindEdited.has(g.key)) out[g.key] = { ...kept, kind: guessKind(g) };
    else out[g.key] = kept;
  }
  return out;
}

/**
 * The choice to show and send for a group: the user's pick, unless it is an "existing" category that
 * is no longer offered (hidden or deleted after the preview), in which case the server default.
 */
export function effectiveChoice(
  choice: FileCategoryChoice | undefined,
  fallback: FileCategoryChoice,
  categories: Pick<CategoryOption, "id">[],
): FileCategoryChoice {
  if (!choice) return fallback;
  if (choice.type === "existing" && !categories.some((c) => c.id === choice.categoryId)) return fallback;
  return choice;
}

/** How many "Create new" choices have a blank name; each would fail the import. */
export function unnamedNewCount(
  groups: (Pick<CategoryGroup, "key"> & { choice: FileCategoryChoice })[],
  choices: Record<string, FileCategoryChoice>,
  categories?: Pick<CategoryOption, "id">[],
): number {
  let n = 0;
  for (const g of groups) {
    const c = categories ? effectiveChoice(choices[g.key], g.choice, categories) : (choices[g.key] ?? g.choice);
    if (c.type === "new" && !c.name.trim()) n++;
  }
  return n;
}

export const UNNAMED_CATEGORY_HINT = "Name each new category or pick another option.";

/** "1 row" / "3 rows". */
export function rowsLabel(n: number): string {
  return `${n} ${n === 1 ? "row" : "rows"}`;
}

/** "was" / "were" to agree with a count: "1 row was skipped", "3 rows were skipped". */
export function wasWere(n: number): string {
  return n === 1 ? "was" : "were";
}

/** Only offer to import without unreadable rows when something is left to import. */
export function canAcknowledgeErrors(errorCount: number, newCount: number): boolean {
  return errorCount > 0 && newCount > 0;
}
