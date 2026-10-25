import { addDays } from "./dates";

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
  /** Tie-break: older rules win. Date or ISO string; missing sorts last. */
  createdAt?: Date | string | null;
};

export type CategorizeInput = { date: string; amountCents: number; description: string };

export type CategorizeResult = {
  categoryId: string | null;
  stylistId: string | null;
  reason: "stylist" | "rule" | null;
  ruleId?: string;
};

/** Days before a stylist's start date that their deposits still count (early rent). */
export const STYLIST_GRACE_BEFORE_START_DAYS = 14;
/** Days after a stylist's end date that their deposits still count (back rent). */
export const STYLIST_GRACE_AFTER_END_DAYS = 45;

export function norm(s: string) {
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

/** Separators between a stylist's match-text terms. */
const TERM_SEPARATORS = /[,;\n]/g;

/** Terms used to recognize a stylist in a bank description: their match text, else their full name. */
export function stylistTerms(s: MatchableStylist): string[] {
  const terms = (s.matchText ?? "")
    .split(TERM_SEPARATORS)
    .map(norm)
    .filter((t) => t.length >= 3);
  if (terms.length) return terms;
  const name = norm(s.name);
  return name.length >= 3 ? [name] : [];
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word containment: the term is bounded by string edges or non-alphanumerics. */
function containsWord(desc: string, term: string): boolean {
  return new RegExp(`(?:^|[^A-Z0-9])${escapeRegex(term)}(?:$|[^A-Z0-9])`).test(desc);
}

/** Is `date` inside the stylist's active window, including the grace periods? */
export function stylistActiveOn(s: MatchableStylist, date: string): boolean {
  if (date < addDays(s.startDate, -STYLIST_GRACE_BEFORE_START_DAYS)) return false;
  if (s.endDate && date > addDays(s.endDate, STYLIST_GRACE_AFTER_END_DAYS)) return false;
  return true;
}

/**
 * Finds the stylist whose Zelle payment this is (money in only). Whole-word match, only
 * stylists active on the transaction date (with grace). Longest matching term wins.
 */
export function matchStylist(
  tx: CategorizeInput,
  stylists: MatchableStylist[],
): MatchableStylist | null {
  if (tx.amountCents <= 0) return null;
  // Separators read as spaces, so a remembered "ZELLE FROM DOE JANE" matches "ZELLE FROM DOE, JANE".
  const desc = norm(tx.description.replace(TERM_SEPARATORS, " "));
  let best: { s: MatchableStylist; len: number } | null = null;
  for (const s of stylists) {
    if (!stylistActiveOn(s, tx.date)) continue;
    for (const term of stylistTerms(s)) {
      if ((!best || term.length > best.len) && containsWord(desc, term)) best = { s, len: term.length };
    }
  }
  return best?.s ?? null;
}

/**
 * The stylist's match text after "remembering" `pattern` for them, or null if it's already there.
 * Keeps the existing terms (or the full name, which was the implicit term). Separators in the
 * pattern become spaces, so "ZELLE FROM DOE, JANE" stays one term instead of leaving a bare "JANE"
 * that would match any other Jane's deposit.
 */
export function addStylistTerm(s: Pick<MatchableStylist, "name" | "matchText">, pattern: string): string | null {
  const split = (t: string | null) =>
    (t ?? "")
      .split(TERM_SEPARATORS)
      .map((x) => x.trim())
      .filter(Boolean);
  const existing = split(s.matchText);
  const base = existing.length ? existing : split(s.name);
  const term = pattern.replace(TERM_SEPARATORS, " ").replace(/\s+/g, " ").trim();
  if (term.length < 3 || base.some((t) => norm(t) === norm(term))) return null;
  return [...base, term].join(", ");
}

function time(d: Date | string | null | undefined): number {
  if (d == null) return Number.MAX_SAFE_INTEGER;
  const t = typeof d === "string" ? Date.parse(d) : d.getTime();
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

/** Applies rules by priority (lower first), then longer pattern, then older createdAt, then id. */
export function matchRule(tx: CategorizeInput, rules: MatchableRule[]): MatchableRule | null {
  const desc = norm(tx.description);
  const sorted = [...rules].sort(
    (a, b) =>
      a.priority - b.priority ||
      norm(b.pattern).length - norm(a.pattern).length ||
      time(a.createdAt) - time(b.createdAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const r of sorted) {
    if (r.direction === "in" && tx.amountCents <= 0) continue;
    if (r.direction === "out" && tx.amountCents >= 0) continue;
    const p = norm(r.pattern);
    if (p && desc.includes(p)) return r;
  }
  return null;
}

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
);

/** Words that introduce the other party of a transfer or P2P payment ("ZELLE PAYMENT FROM DANA FISK"). */
const COUNTERPARTY_MARKERS = new Set(["FROM", "TO"]);
const MAX_PATTERN_WORDS = 5;

/** A word that can be part of a pattern: no digits, `#` or `*`, longer than 1 char. */
function cleanWord(w: string) {
  return w.length > 1 && !/[\d#*]/.test(w);
}

/**
 * Suggests a "remember" pattern: the longest contiguous run (by characters) of clean words, capped
 * at 5 words; ties go to the later run. A trailing "CITY ST" is dropped first.
 * Transfers and P2P payments are different: when FROM or TO is followed by a clean word, the pattern
 * ends with the words after the last FROM/TO (the payer or payee, up to 5 words) so two stylists'
 * Zelle payments don't share a pattern, and no "CITY ST" is dropped from them ("TO ACME CO").
 * Always a substring of the normalized description, or "" if shorter than 3 characters.
 */
export function suggestPattern(description: string): string {
  let words = norm(description).split(" ");

  let marker = -1;
  for (let i = words.length - 2; i >= 0; i--) {
    if (COUNTERPARTY_MARKERS.has(words[i])) {
      marker = i;
      break;
    }
  }
  if (marker >= 0 && cleanWord(words[marker + 1])) {
    let start = marker;
    while (start > 0 && cleanWord(words[start - 1])) start--;
    let end = marker + 1;
    while (end + 1 < words.length && end - marker < MAX_PATTERN_WORDS && cleanWord(words[end + 1])) end++;
    const cand = words.slice(Math.max(start, end - MAX_PATTERN_WORDS + 1), end + 1).join(" ");
    if (cand.length >= 3) return cand;
  }

  // Card descriptions end with "CITY ST"; that is location noise, not the merchant.
  if (words.length >= 5 && US_STATES.has(words[words.length - 1])) words = words.slice(0, -2);
  let best = "";
  let run: string[] = [];
  const flush = () => {
    if (!run.length) return;
    const cand = run.slice(0, MAX_PATTERN_WORDS).join(" ");
    if (cand.length >= best.length) best = cand;
    run = [];
  };
  for (const w of words) {
    if (cleanWord(w)) run.push(w);
    else flush();
  }
  flush();
  return best.length >= 3 ? best : "";
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
