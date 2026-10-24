"use client";

import { useEffect, useState } from "react";
import { addRule, deleteRule, testRule, updateRule } from "@/app/actions/settings";
import { Button, Money, Pill, cx, inputClass } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import type { RuleTestResult } from "@/lib/rules-server";

type Direction = "any" | "in" | "out";
type CategoryOption = { id: string; name: string; kind: "income" | "expense" | "transfer" };

export type RuleView = { id: string; pattern: string; categoryId: string; categoryName: string; direction: Direction };

const kindLabel = { income: "Money in", expense: "Money out", transfer: "Transfers" } as const;
const directions: { value: Direction; label: string }[] = [
  { value: "out", label: "Out" },
  { value: "in", label: "In" },
  { value: "any", label: "Any" },
];

/** "Matches N past · M in Inbox" with a few examples, refreshed ~300 ms after the last keystroke. */
function TestPanel({ pattern, direction }: { pattern: string; direction: Direction }) {
  const trimmed = pattern.trim();
  const ready = trimmed.length >= 3;
  const [result, setResult] = useState<{ key: string; data: RuleTestResult } | null>(null);
  const key = `${direction}|${trimmed}`;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const t = setTimeout(() => {
      testRule(trimmed, direction)
        .then((data) => {
          if (!cancelled) setResult({ key, data });
        })
        .catch(() => {});
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [ready, trimmed, direction, key]);

  const fresh = ready && result?.key === key ? result.data : null;
  const shown = ready ? (fresh ?? result?.data ?? null) : null;

  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2 text-sm" aria-live="polite">
      {!ready ? (
        <p className="text-ink-2">Type at least 3 characters to test the rule.</p>
      ) : !shown ? (
        <p className="text-ink-2">Testing…</p>
      ) : (
        <div className={cx(!fresh && "opacity-60")}>
          <p className="font-medium">
            Matches {shown.matches} past · {shown.inbox} in Inbox
          </p>
          {shown.samples.length ? (
            <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
              {shown.samples.map((s, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate" title={`${formatDate(s.date)} ${s.description}`}>
                    {s.description}
                  </span>
                  <Money cents={s.amountCents} className="shrink-0" />
                </li>
              ))}
              {shown.matches > shown.samples.length ? <li>+{shown.matches - shown.samples.length} more</li> : null}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

function RuleForm({
  rule,
  categories,
  onDone,
  onCancel,
}: {
  rule?: RuleView;
  categories: CategoryOption[];
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [direction, setDirection] = useState<Direction>(rule?.direction ?? "any");
  const editing = !!rule;

  async function submit(formData: FormData) {
    await (editing ? updateRule(formData) : addRule(formData));
    if (!editing) setPattern("");
    onDone();
  }

  return (
    <form action={submit} className="space-y-3">
      {rule ? <input type="hidden" name="id" value={rule.id} /> : null}
      <label className="block">
        <span className="mb-1 block text-xs text-ink-2">Contains</span>
        <input
          name="pattern"
          required
          minLength={3}
          maxLength={100}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="Text to match, e.g. SALLY BEAUTY"
          className={inputClass}
          autoComplete="off"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-ink-2">Category</span>
        <select name="categoryId" required defaultValue={rule?.categoryId ?? ""} className={inputClass}>
          <option value="" disabled>
            Category…
          </option>
          {(["expense", "income", "transfer"] as const).map((k) => (
            <optgroup key={k} label={kindLabel[k]}>
              {categories
                .filter((c) => c.kind === k)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <fieldset>
        <legend className="mb-1 text-xs text-ink-2">Applies to</legend>
        <div className="flex gap-2">
          {directions.map((d) => (
            <label
              key={d.value}
              className={cx(
                "flex min-h-10 flex-1 cursor-pointer items-center justify-center rounded-xl border px-3 text-sm",
                direction === d.value ? "border-accent bg-surface-2 font-medium" : "border-line",
              )}
            >
              <input
                type="radio"
                name="direction"
                value={d.value}
                checked={direction === d.value}
                onChange={() => setDirection(d.value)}
                className="sr-only"
              />
              {d.label}
            </label>
          ))}
        </div>
      </fieldset>
      <TestPanel pattern={pattern} direction={direction} />
      {editing ? (
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" name="sortInbox" value="1" className="h-4 w-4 accent-[var(--accent)]" />
          Also sort matching Inbox items
        </label>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant={editing ? "primary" : "secondary"} className="min-h-10">
          {editing ? "Save" : "Add rule"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" className="min-h-10" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {rule ? (
          <Button
            type="submit"
            variant="danger"
            className="ml-auto min-h-10"
            formAction={async (fd) => {
              await deleteRule(fd);
            }}
            formNoValidate
          >
            Delete
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function AddRuleForm({ categories }: { categories: CategoryOption[] }) {
  // Remount after a successful add so the category select resets too.
  const [n, setN] = useState(0);
  return <RuleForm key={n} categories={categories} onDone={() => setN((v) => v + 1)} />;
}

export function RuleRow({ rule, categories }: { rule: RuleView; categories: CategoryOption[] }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li className="py-3">
        <RuleForm rule={rule} categories={categories} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="flex items-center justify-between gap-3 py-1.5">
      <span className="min-w-0 break-words">
        <span className="font-mono text-xs">{rule.pattern}</span>
        <span className="text-ink-2"> → {rule.categoryName}</span>
        {rule.direction !== "any" ? (
          <span className="ml-1">
            <Pill>{rule.direction === "in" ? "money in" : "money out"}</Pill>
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="min-h-10 shrink-0 px-2 text-sm text-accent"
        aria-label={`Edit rule ${rule.pattern}`}
      >
        Edit
      </button>
    </li>
  );
}
