/** Money helpers. All amounts are integer cents. */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatCents(cents: number, opts: { whole?: boolean; signed?: boolean } = {}) {
  const fmt = opts.whole ? usdWhole : usd;
  const s = fmt.format(cents / 100);
  if (opts.signed && cents > 0) return `+${s}`;
  return s;
}

/** `amount_cents` is a Postgres `integer`; a larger magnitude would fail the whole insert. */
export const MAX_CENTS = 2_147_483_647;

/**
 * Parses a human or bank-formatted amount into cents. Returns null if |cents| > MAX_CENTS.
 * Handles "$1,234.56", "-12.5", "(45.00)" (accounting negative), "1 234,00" is NOT supported.
 * Returns null when the input isn't a number.
 */
export function parseAmountToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  // Numbers go through the string path so float error can't creep in (1.005 * 100 = 100.49999...).
  // String(1.005) is "1.005"; exponent forms like "1e-7" fail the digit check below and return null.
  let s = (typeof input === "number" ? (Number.isFinite(input) ? String(input) : "") : input).trim();
  if (!s) return null;

  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^\d*\.?\d+$/.test(s)) return null;

  // Avoid float error: split on the decimal point.
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  const roundUp = frac.length > 2 && Number(frac[2]) >= 5 ? 1 : 0;
  const total = cents + roundUp;
  if (!Number.isSafeInteger(total) || total > MAX_CENTS) return null;
  return negative ? -total : total;
}
