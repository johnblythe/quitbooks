import { chunk } from "./inbox";

/**
 * Client-side planning for lazy Inbox suggestions. Pure: no React, no I/O, so it is unit-tested
 * and the components stay thin.
 */

export type SuggestItem = {
  /** Group key, or the row id for a one-off. */
  key: string;
  ids: string[];
  /** Stored suggestion to start from (already validated server-side), if any. */
  categoryId: string | null;
  /** True when some row in the item has never been asked. */
  needsAsking: boolean;
};

export type SuggestStatus = "pending" | "done" | "error";
export type SuggestEntry = { status: SuggestStatus; categoryId: string | null };
export type SuggestMap = Record<string, SuggestEntry>;

export const FIRST_CHUNK = 4;
export const REST_CHUNK = 6;
export const CONCURRENCY = 2;

/** Splits keys (already in display order) into a small first chunk, then larger ones. */
export function planChunks<T>(items: T[], first = FIRST_CHUNK, rest = REST_CHUNK): T[][] {
  if (!items.length) return [];
  return [items.slice(0, first), ...chunk(items.slice(first), rest)].filter((c) => c.length);
}

/** Initial map: items needing a request are pending, everything else is done with what is stored. */
export function seedSuggestions(items: SuggestItem[]): SuggestMap {
  const out: SuggestMap = {};
  for (const i of items)
    out[i.key] = {
      status: i.needsAsking ? "pending" : "done",
      categoryId: i.categoryId,
    };
  return out;
}

export type ChunkOutcome = { results: Record<string, { categoryId: string | null }> } | { error: string };

/** Folds one chunk's outcome into the map. Keys the server did not answer count as done/none. */
export function applyOutcome(map: SuggestMap, keys: string[], outcome: ChunkOutcome): SuggestMap {
  const next = { ...map };
  for (const key of keys) {
    if ("error" in outcome) next[key] = { status: "error", categoryId: null };
    else
      next[key] = {
        status: "done",
        categoryId: outcome.results[key]?.categoryId ?? null,
      };
  }
  return next;
}

export function markPending(map: SuggestMap, keys: string[]): SuggestMap {
  const next = { ...map };
  for (const key of keys) next[key] = { status: "pending", categoryId: null };
  return next;
}

/** Progress for the header: how many of the tracked items have finished (done or error). */
export function progressOf(map: SuggestMap, keys: string[]): { settled: number; total: number; errors: number; pending: number } {
  let settled = 0;
  let errors = 0;
  let pending = 0;
  for (const k of keys) {
    const s = map[k]?.status;
    if (s === "pending") pending++;
    else {
      settled++;
      if (s === "error") errors++;
    }
  }
  return { settled, total: keys.length, errors, pending };
}

/** The select's value: whatever the user picked wins; otherwise the live suggestion. */
export function pickerValue(picked: string | null, suggested: string | null | undefined): string {
  return picked ?? suggested ?? "";
}
