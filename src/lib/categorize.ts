/**
 * Auto-categorization. Pure functions so they're easy to test and reuse
 * (CSV import, manual entry, and a future bank sync all go through here).
 */

export type MatchableStylist = {
  id: string;
  name: string;
  matchText: string | null;
  startDate: string;
  endDate: string | null;
};

export type MatchableRule = {
  id: string;
  pattern: string;
  categoryId: string;
  direction: "any" | "in" | "out";
  priority: number;
};

export type CategorizeInput = { date: string; amountCents: number; description: string };

export type CategorizeResult = {
  categoryId: string | null;
  stylistId: string | null;
  reason: "stylist" | "rule" | null;
  ruleId?: string;
};

function norm(s: string) {
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

/** Terms used to recognize a stylist in a bank description: their match text, else their full name. */
export function stylistTerms(s: MatchableStylist): string[] {
  const terms = (s.matchText ?? "")
    .split(/[,;\n]/)
    .map(norm)
    .filter((t) => t.length >= 3);
  if (terms.length) return terms;
  const name = norm(s.name);
  return name.length >= 3 ? [name] : [];
}

/** Finds the stylist whose Zelle payment this is (money in only). Longest matching term wins. */
export function matchStylist(
  tx: CategorizeInput,
  stylists: MatchableStylist[],
): MatchableStylist | null {
  if (tx.amountCents <= 0) return null;
  const desc = norm(tx.description);
  let best: { s: MatchableStylist; len: number } | null = null;
  for (const s of stylists) {
    for (const term of stylistTerms(s)) {
      if (desc.includes(term) && (!best || term.length > best.len)) best = { s, len: term.length };
    }
  }
  return best?.s ?? null;
}

/** Applies rules in priority order (lower number first), then longest pattern first. */
export function matchRule(tx: CategorizeInput, rules: MatchableRule[]): MatchableRule | null {
  const desc = norm(tx.description);
  const sorted = [...rules].sort(
    (a, b) => a.priority - b.priority || b.pattern.length - a.pattern.length,
  );
  for (const r of sorted) {
    if (r.direction === "in" && tx.amountCents <= 0) continue;
    if (r.direction === "out" && tx.amountCents >= 0) continue;
    const p = norm(r.pattern);
    if (p && desc.includes(p)) return r;
  }
  return null;
}

/**
 * Stylist match wins (it's tagged as Booth Rent and linked to the stylist);
 * otherwise the first matching rule; otherwise uncategorized (goes to the Inbox).
 */
export function categorize(
  tx: CategorizeInput,
  ctx: { stylists: MatchableStylist[]; rules: MatchableRule[]; boothRentCategoryId: string | null },
): CategorizeResult {
  const stylist = ctx.boothRentCategoryId ? matchStylist(tx, ctx.stylists) : null;
  if (stylist) {
    return { categoryId: ctx.boothRentCategoryId, stylistId: stylist.id, reason: "stylist" };
  }
  const rule = matchRule(tx, ctx.rules);
  if (rule) return { categoryId: rule.categoryId, stylistId: null, reason: "rule", ruleId: rule.id };
  return { categoryId: null, stylistId: null, reason: null };
}
