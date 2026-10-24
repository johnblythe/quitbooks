import { addMonths, isIsoDate, monthEnd, monthOf, monthStart, type IsoDate } from "./dates";

export type RangePreset = { key: string; label: string; from: IsoDate; to: IsoDate };

/** Common reporting ranges relative to today. */
export function rangePresets(today: IsoDate): RangePreset[] {
  const month = monthOf(today);
  const year = Number(today.slice(0, 4));
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const qStart = `${year}-${String(q * 3 + 1).padStart(2, "0")}`;
  const lastMonth = addMonths(month, -1);
  return [
    { key: "month", label: "This month", from: monthStart(month), to: monthEnd(month) },
    { key: "last-month", label: "Last month", from: monthStart(lastMonth), to: monthEnd(lastMonth) },
    { key: "quarter", label: "This quarter", from: monthStart(qStart), to: monthEnd(addMonths(qStart, 2)) },
    { key: "ytd", label: "This year", from: `${year}-01-01`, to: `${year}-12-31` },
    { key: "last-year", label: `${year - 1}`, from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
  ];
}

/** Reads ?from=&to= (or ?range=preset), defaulting to this year. */
export function resolveRange(
  params: { from?: string; to?: string; range?: string },
  today: IsoDate,
): { from: IsoDate; to: IsoDate; preset: string | null } {
  const presets = rangePresets(today);
  const preset = presets.find((p) => p.key === params.range);
  if (preset) return { from: preset.from, to: preset.to, preset: preset.key };
  if (params.from && params.to && isIsoDate(params.from) && isIsoDate(params.to) && params.from <= params.to) {
    const match = presets.find((p) => p.from === params.from && p.to === params.to);
    return { from: params.from, to: params.to, preset: match?.key ?? null };
  }
  const ytd = presets.find((p) => p.key === "ytd")!;
  return { from: ytd.from, to: ytd.to, preset: "ytd" };
}
