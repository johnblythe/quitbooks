"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Button, inputClass } from "@/components/ui";
import {
  CONCURRENCY,
  applyOutcome,
  markPending,
  pickerValue,
  planChunks,
  progressOf,
  seedSuggestions,
  type ChunkOutcome,
  type SuggestItem,
  type SuggestMap,
} from "@/lib/inbox-suggest";

export type PickerCategory = {
  id: string;
  name: string;
  kind: "income" | "expense" | "transfer";
};

type Action = { type: "settle"; keys: string[]; outcome: ChunkOutcome } | { type: "pending"; keys: string[] };

function reducer(map: SuggestMap, a: Action): SuggestMap {
  return a.type === "settle" ? applyOutcome(map, a.keys, a.outcome) : markPending(map, a.keys);
}

type Ctx = {
  map: SuggestMap;
  /** Keys the runner is responsible for, in display order. */
  tracked: string[];
  categories: PickerCategory[];
  retry: (keys: string[]) => void;
};

const SuggestionsContext = createContext<Ctx | null>(null);

function useSuggestions() {
  const ctx = useContext(SuggestionsContext);
  if (!ctx) throw new Error("Suggestions components must be inside <SuggestionsProvider>");
  return ctx;
}

/**
 * Holds the per-item suggestion state for the Inbox and fills it in lazily: on mount it asks for
 * the items that need it, in display order, in small chunks (2 in flight). Each chunk's result
 * updates only its own cards. It never refreshes the page.
 */
export function SuggestionsProvider({
  items,
  categories,
  children,
}: {
  items: SuggestItem[];
  categories: PickerCategory[];
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, items, seedSuggestions);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const mounted = useRef(false);

  const controllers = useRef(new Set<AbortController>());

  const runChunks = useCallback((keyChunks: string[][], alive: () => boolean) => {
    const idsByKey = new Map(itemsRef.current.map((i) => [i.key, i.ids]));
    let next = 0;
    const worker = async () => {
      while (alive() && next < keyChunks.length) {
        const keys = keyChunks[next++].filter((k) => idsByKey.has(k));
        if (!keys.length) continue;
        let outcome: ChunkOutcome;
        const ac = new AbortController();
        controllers.current.add(ac);
        try {
          const res = await fetch("/api/inbox/suggest", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(keys.map((key) => ({ key, ids: idsByKey.get(key)! }))),
            signal: ac.signal,
          });
          outcome = res.ok ? ((await res.json()) as ChunkOutcome) : { error: "request_failed" };
        } catch {
          outcome = { error: "request_failed" };
        } finally {
          controllers.current.delete(ac);
        }
        if (!alive()) return;
        dispatch({ type: "settle", keys, outcome });
      }
    };
    for (let i = 0; i < CONCURRENCY; i++) void worker();
  }, []);

  // Mount only: later re-renders (e.g. after sorting a card) must not restart the run.
  useEffect(() => {
    mounted.current = true;
    const run = { stopped: false };
    const inflight = controllers.current;
    const keys = itemsRef.current.filter((i) => i.needsAsking).map((i) => i.key);
    runChunks(planChunks(keys), () => !run.stopped);
    return () => {
      run.stopped = true;
      mounted.current = false;
      for (const ac of inflight) ac.abort();
      inflight.clear();
    };
  }, [runChunks]);

  const retry = useCallback(
    (keys: string[]) => {
      if (!keys.length) return;
      dispatch({ type: "pending", keys });
      runChunks(planChunks(keys), () => mounted.current);
    },
    [runChunks],
  );

  // Items that appeared after mount (page refreshed with new rows) show what the server stored.
  const map = useMemo(() => {
    const out: SuggestMap = {};
    for (const i of items) out[i.key] = { status: "done", categoryId: i.categoryId };
    return { ...out, ...state };
  }, [items, state]);
  // Fixed at mount so the header count stays stable while cards are sorted away.
  const [tracked] = useState(() => items.filter((i) => i.needsAsking).map((i) => i.key));
  const value = useMemo(() => ({ map, tracked, categories, retry }), [map, tracked, categories, retry]);
  return <SuggestionsContext.Provider value={value}>{children}</SuggestionsContext.Provider>;
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin"
    />
  );
}

/** Header status: visible only while the runner works, plus "Suggest again" if something failed. */
export function SuggestStatus() {
  const { map, tracked, retry } = useSuggestions();
  const p = progressOf(map, tracked);
  const failed = tracked.filter((k) => map[k]?.status === "error");
  if (!p.pending && !failed.length) return null;
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2" role="status" aria-live="polite">
      {p.pending ? (
        <span className="inline-flex items-center gap-2">
          <Spinner />
          Suggesting categories… {p.settled} / {p.total}
        </span>
      ) : null}
      {failed.length ? (
        <Button type="button" variant="secondary" className="min-h-10" onClick={() => retry(failed)}>
          Suggest again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Category select, controlled. Shows the live suggestion until the user picks something; after
 * that their choice is never overridden. `name="categoryId"` keeps the existing forms working.
 */
export function CategoryPicker({ itemKey, direction }: { itemKey: string; direction: "in" | "out" }) {
  const { map, categories, retry } = useSuggestions();
  const entry = map[itemKey];
  const [picked, setPicked] = useState<string | null>(null);
  const value = pickerValue(picked, entry?.categoryId);
  const suggestedKind = direction === "in" ? "income" : "expense";
  const name = entry?.categoryId ? categories.find((c) => c.id === entry.categoryId)?.name : undefined;

  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1 flex min-h-4 items-center gap-1.5 text-xs font-medium text-accent">
        {entry?.status === "pending" ? (
          <span className="inline-flex items-center gap-1.5 text-ink-2">
            <Spinner />
            Suggesting…
          </span>
        ) : entry?.status === "error" ? (
          <span className="inline-flex items-center gap-1 text-ink-2">
            Couldn’t suggest ·
            <button
              type="button"
              onClick={() => retry([itemKey])}
              className="-my-3 min-h-10 px-1 font-medium text-accent underline"
            >
              Retry
            </button>
          </span>
        ) : name ? (
          <>✨ Suggested: {name}</>
        ) : null}
      </p>
      <select
        name="categoryId"
        required
        value={value}
        onChange={(e) => setPicked(e.target.value)}
        className={inputClass}
        aria-label="Category"
      >
        <option value="" disabled>
          Pick a category…
        </option>
        {[suggestedKind, suggestedKind === "income" ? "expense" : "income", "transfer"].map((kind) => (
          <optgroup key={kind} label={kind === "income" ? "Money in" : kind === "expense" ? "Money out" : "Transfers"}>
            {categories
              .filter((c) => c.kind === kind)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
