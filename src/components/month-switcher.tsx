import Link from "next/link";
import { addMonths, formatMonth, type MonthKey } from "@/lib/dates";

export function MonthSwitcher({ month, basePath, current }: { month: MonthKey; basePath: string; current: MonthKey }) {
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const link = (m: MonthKey) => (m === current ? basePath : `${basePath}?month=${m}`);
  const arrow = "flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2 hover:text-ink";
  return (
    <div className="flex items-center gap-2">
      <Link href={link(prev)} className={arrow} aria-label={`Previous month, ${formatMonth(prev)}`}>
        ‹
      </Link>
      <span className="min-w-28 text-center text-sm font-medium">{formatMonth(month)}</span>
      {next <= current ? (
        <Link href={link(next)} className={arrow} aria-label={`Next month, ${formatMonth(next)}`}>
          ›
        </Link>
      ) : (
        <span className={`${arrow} opacity-30`} aria-hidden="true">
          ›
        </span>
      )}
    </div>
  );
}

/** Validates a ?month= value, falling back to the current month. */
export function resolveMonth(raw: string | string[] | undefined, current: MonthKey): MonthKey {
  const m = Array.isArray(raw) ? raw[0] : raw;
  return m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) && m <= current ? m : current;
}
