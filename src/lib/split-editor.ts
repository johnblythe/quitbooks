/**
 * State helpers for the split editor (pure, so the arithmetic is tested and the component stays
 * a thin shell). Amounts are typed unsigned with an In/Out toggle per line, because the iOS
 * decimal keypad has no minus key.
 *
 * At most one line is "auto": it fills whatever the other lines leave, until you type in it.
 * A fresh split starts as [current category, full amount] + [auto], so a 2-way split is one edit:
 * change the first amount and the second line follows.
 */
import { parseAmountToCents } from "./money";
import { leftToAssign, type SplitLineInput } from "./splits";

export type Dir = 1 | -1;

export type EditorLine = {
  key: string;
  /** "" = not picked yet. */
  categoryId: string;
  /** "" = none. Only used when the category is Booth Rent. */
  stylistId: string;
  /** Unsigned amount as typed. Ignored while `auto`. */
  amountText: string;
  /** 1 = money in, -1 = money out. Ignored while `auto`. */
  dir: Dir;
  memo: string;
  auto: boolean;
};

export type ResolvedLine = EditorLine & {
  /** Signed cents, or null when the amount is blank/unreadable (or an auto line with nothing left). */
  cents: number | null;
  /** What the amount box shows (the remainder for an auto line). */
  shownText: string;
  shownDir: Dir;
};

export type ResolvedEditor = {
  lines: ResolvedLine[];
  /** Left to assign in the parent's direction: positive = unassigned, negative = over. */
  left: number;
  /** What the server action receives. */
  payload: SplitLineInput[];
};

const dirOf = (cents: number): Dir => (cents < 0 ? -1 : 1);
const unsigned = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

let seq = 0;
export function newKey(): string {
  seq += 1;
  return `l${seq}`;
}

/** Signed cents for a typed line, or null if blank, unreadable or zero. */
export function typedCents(line: Pick<EditorLine, "amountText" | "dir">): number | null {
  const c = parseAmountToCents(line.amountText);
  if (c === null || c === 0) return null;
  return Math.abs(c) * line.dir;
}

export function resolveEditor(parentCents: number, lines: EditorLine[], boothRentId: string | null): ResolvedEditor {
  const typed = lines.map((l) => (l.auto ? null : typedCents(l)));
  const others = typed.reduce<number>((s, c) => s + (c ?? 0), 0);
  const remainder = parentCents - others;

  const resolved: ResolvedLine[] = lines.map((l, i) => {
    if (l.auto) {
      return {
        ...l,
        cents: remainder === 0 ? null : remainder,
        shownText: remainder === 0 ? "" : unsigned(remainder),
        shownDir: remainder === 0 ? dirOf(parentCents) : dirOf(remainder),
      };
    }
    return { ...l, cents: typed[i], shownText: l.amountText, shownDir: l.dir };
  });

  const payload: SplitLineInput[] = resolved.map((l) => ({
    categoryId: l.categoryId,
    stylistId: boothRentId && l.categoryId === boothRentId && l.stylistId ? l.stylistId : null,
    amountCents: l.cents ?? 0,
    memo: l.memo.trim() || null,
  }));
  return { lines: resolved, left: leftToAssign(parentCents, payload), payload };
}

/**
 * Opening state. An existing split loads as-is. Otherwise: line 1 = the row's current category
 * (if it's still usable) and stylist with the full amount, line 2 = auto.
 */
export function initialEditorLines(
  parent: { amountCents: number; categoryId: string | null; stylistId: string | null },
  existing: { categoryId: string; stylistId: string | null; amountCents: number; memo: string | null }[],
  usableCategoryIds: Set<string>,
): EditorLine[] {
  if (existing.length) {
    return existing.map((s) => ({
      key: newKey(),
      categoryId: s.categoryId,
      stylistId: s.stylistId ?? "",
      amountText: unsigned(s.amountCents),
      dir: dirOf(s.amountCents),
      memo: s.memo ?? "",
      auto: false,
    }));
  }
  const dir = dirOf(parent.amountCents);
  const categoryId = parent.categoryId && usableCategoryIds.has(parent.categoryId) ? parent.categoryId : "";
  return [
    {
      key: newKey(),
      categoryId,
      stylistId: categoryId ? (parent.stylistId ?? "") : "",
      amountText: unsigned(parent.amountCents),
      dir,
      memo: "",
      auto: false,
    },
    { key: newKey(), categoryId: "", stylistId: "", amountText: "", dir, memo: "", auto: true },
  ];
}

/** Adds a blank line. It becomes the auto line if no line is filling what's left. */
export function addEditorLine(lines: EditorLine[], parentCents: number): EditorLine[] {
  return [
    ...lines,
    {
      key: newKey(),
      categoryId: "",
      stylistId: "",
      amountText: "",
      dir: dirOf(parentCents),
      memo: "",
      auto: !lines.some((l) => l.auto),
    },
  ];
}

/** Typing in a line's amount makes it an ordinary line. */
export function setEditorAmount(lines: EditorLine[], key: string, text: string): EditorLine[] {
  return lines.map((l) => (l.key === key ? { ...l, amountText: text, auto: false } : l));
}

/** Flips In/Out. On the auto line it first freezes the shown amount, then flips it. */
export function toggleEditorDir(lines: EditorLine[], key: string, parentCents: number, boothRentId: string | null): EditorLine[] {
  const shown = resolveEditor(parentCents, lines, boothRentId).lines;
  return lines.map((l, i) => {
    if (l.key !== key) return l;
    const s = shown[i];
    return { ...l, amountText: s.shownText, dir: s.shownDir === 1 ? -1 : 1, auto: false };
  });
}

