import { formatMonth } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import type { MonthSummary } from "@/lib/metrics";

/** Monthly profit bars: above the line = profit, below = loss. Plain SVG, no chart library. */
export function ProfitBars({ months, highlight }: { months: MonthSummary[]; highlight?: string }) {
  const max = Math.max(1, ...months.map((m) => Math.abs(m.profit)));
  const hasLoss = months.some((m) => m.profit < 0);
  const W = 100 / months.length;
  const H = 120;
  const zero = hasLoss ? H / 2 : H - 4;
  const scale = hasLoss ? H / 2 - 6 : H - 10;

  return (
    <figure>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="Monthly profit">
        <line x1="0" x2="100" y1={zero} y2={zero} stroke="var(--line)" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
        {months.map((m, i) => {
          const h = (Math.abs(m.profit) / max) * scale;
          const y = m.profit >= 0 ? zero - h : zero;
          const isHi = m.month === highlight;
          return (
            <rect
              key={m.month}
              x={i * W + W * 0.18}
              width={W * 0.64}
              y={y}
              height={Math.max(h, 0.8)}
              rx="1"
              fill={m.profit >= 0 ? "var(--good)" : "var(--bad)"}
              opacity={isHi ? 1 : 0.55}
            >
              <title>{`${formatMonth(m.month)}: ${formatCents(m.profit)}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="mt-1 grid text-center text-[11px] text-ink-2" style={{ gridTemplateColumns: `repeat(${months.length}, 1fr)` }}>
        {months.map((m) => (
          <span key={m.month} className={m.month === highlight ? "font-semibold text-ink" : undefined}>
            {formatMonth(m.month, "short").split(" ")[0]}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** A thin horizontal meter, e.g. rent collected vs expected. */
export function Meter({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "good" | "bad" }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = { accent: "bg-accent", good: "bg-good", bad: "bg-bad" }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
