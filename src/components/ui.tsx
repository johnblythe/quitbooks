import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { formatCents } from "@/lib/money";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="mb-5 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-serif text-2xl leading-tight text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-2">{subtitle}</p> : null}
      </div>
      {action ? <div className="no-print shrink-0">{action}</div> : null}
    </header>
  );
}

export function Card({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("rounded-2xl border border-line bg-surface p-4", className)}>
      {title || action ? (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title ? <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-2">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Money({
  cents,
  className,
  colored,
  whole,
  signed,
}: {
  cents: number;
  className?: string;
  colored?: boolean;
  whole?: boolean;
  signed?: boolean;
}) {
  return (
    <span
      className={cx(
        "tabular-nums",
        colored && (cents > 0 ? "text-good" : cents < 0 ? "text-bad" : "text-ink-2"),
        className,
      )}
    >
      {formatCents(cents, { whole, signed })}
    </span>
  );
}

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const buttonVariants = {
  primary: "bg-accent text-accent-ink hover:opacity-90",
  secondary: "border border-line bg-surface text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "border border-line bg-surface text-bad hover:bg-bad-bg",
};

export type ButtonVariant = keyof typeof buttonVariants;

export function buttonClass(variant: ButtonVariant = "primary", extra?: string) {
  return cx(buttonBase, buttonVariants[variant], extra);
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return <button className={buttonClass(variant, className)} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return <Link className={buttonClass(variant, className)} {...props} />;
}

export const inputClass =
  "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-ink placeholder:text-ink-2/60 focus:border-accent focus:outline-none";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-2">{hint}</span> : null}
    </label>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "good" | "bad" | "warn"; children: ReactNode }) {
  const tones = {
    neutral: "bg-surface-2 text-ink-2",
    good: "bg-good-bg text-good",
    bad: "bg-bad-bg text-bad",
    warn: "bg-warn-bg text-warn",
  };
  return (
    <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-2">{children}</p>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-2xl bg-surface-2" />
      ))}
    </div>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-xl bg-bad-bg px-3 py-2 text-sm text-bad">
      {children}
    </p>
  );
}
