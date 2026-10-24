/**
 * Fabricated BMO business-checking export generator, plus the "truth" file describing what every
 * row is supposed to be. We don't have a real BMO CSV yet, so this produces realistic data in every
 * plausible export shape to exercise the importer and categorizer.
 *
 * Deterministic: the same options always give byte-identical output. Money is integer cents,
 * dates are YYYY-MM-DD strings, and day arithmetic is pure integer (no Date objects).
 */
import { DEFAULT_CATEGORIES } from "../db/defaults";
import { addMonths, monthEnd, monthRange, monthStart, type IsoDate, type MonthKey } from "./dates";

export type FakeBmoOptions = {
  /** Number of months to generate, ending at `endMonth` (inclusive). */
  months: number;
  /** Last month included, YYYY-MM. */
  endMonth: MonthKey;
  seed: number;
  /** "single": one signed Amount column. "split": unsigned Withdrawals + Deposits columns. */
  format: "single" | "split";
  /** Account-info lines before the header row. */
  preamble: boolean;
  /** Where the Zelle sender name appears: in the description, or in a separate Memo column. */
  zelleSender: "description" | "memo";
  order: "newest" | "oldest";
};

export const DEFAULT_FAKE_OPTIONS: FakeBmoOptions = {
  months: 12,
  endMonth: "2026-09",
  seed: 42,
  format: "single",
  preamble: true,
  zelleSender: "description",
  order: "newest",
};

export type FakeTruthRow = {
  date: IsoDate;
  amountCents: number;
  /** As written in the CSV Description column. */
  description: string;
  /** As written in the CSV Memo column ("" when there's no Memo column or it's blank). */
  memo: string;
  /** Intended category name (one of the seeded category names). */
  category: string;
  /** Intended stylist (roster name) or null. */
  stylist: string | null;
  /** Running balance after this row, in time order. */
  balanceCents: number;
  /** Which trap this row exercises, if any. Multiple traps are joined with "+". */
  trap?: string;
};

export type FakeRosterEntry = {
  name: string;
  /** What the owners would plausibly type as match text; null when the plain name should be enough. */
  matchText: string | null;
  cadence: "weekly" | "biweekly" | "monthly";
  rentCents: number;
  startDate: IsoDate;
  endDate: IsoDate | null;
  chairLabel: string;
};

export type FakeMonthRollup = {
  month: MonthKey;
  incomeCents: number;
  /** Positive number: money spent in expense categories, net of refunds. */
  expenseCents: number;
  netCents: number;
  /** Transfers (owner draw / contribution) are excluded from all of the above. */
  boothRentByStylist: Record<string, number>;
};

export type FakeTruth = {
  options: FakeBmoOptions;
  /** In the same order as the CSV rows. */
  rows: FakeTruthRow[];
  roster: FakeRosterEntry[];
  totalChairs: number;
  openingBalance: { cents: number; asOf: IsoDate };
  months: FakeMonthRollup[];
};

// ---------------------------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

/** Days since 1970-01-01 (proleptic Gregorian), integer arithmetic only. */
function dayNumber(iso: IsoDate): number {
  const [y0, m, d] = iso.split("-").map(Number);
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDayNumber(n: number): IsoDate {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return isoOf(yoe + era * 400 + (m <= 2 ? 1 : 0), m, d);
}

function addDays(iso: IsoDate, days: number): IsoDate {
  return fromDayNumber(dayNumber(iso) + days);
}

/** 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday. */
function weekday(iso: IsoDate): number {
  return (((dayNumber(iso) + 4) % 7) + 7) % 7;
}

function firstOnOrAfter(iso: IsoDate, wd: number): IsoDate {
  return addDays(iso, (wd - weekday(iso) + 7) % 7);
}

/** `YYYY-MM` plus a day of month, clamped to the month's length. */
function dayOf(month: MonthKey, day: number): IsoDate {
  const last = Number(monthEnd(month).slice(8));
  return `${month}-${pad2(Math.min(Math.max(day, 1), last))}`;
}

/** Integer cents as "1234.56" (sign kept). */
function plainAmount(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${pad2(abs % 100)}`;
}

function usDate(iso: IsoDate): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CATEGORY_KIND = new Map(DEFAULT_CATEGORIES.map((c) => [c.name, c.kind]));

// ---------------------------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------------------------

type Party = { text: string } | { zelle: "in" | "out"; party: string };

type Ev = {
  seq: number;
  date: IsoDate;
  cents: number;
  category: string;
  stylist: string | null;
  party: Party;
  trap?: string;
};

const tags = (...t: (string | undefined)[]) => t.filter(Boolean).join("+") || undefined;

function dueDates(start: IsoDate, stepDays: number, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = start; d <= end; d = addDays(d, stepDays)) out.push(d);
  return out;
}

function buildScenario(o: FakeBmoOptions) {
  const rand = mulberry32(o.seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  const ref = (n: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789") =>
    Array.from({ length: n }, () => alphabet[int(0, alphabet.length - 1)]).join("");

  const firstMonth = addMonths(o.endMonth, -(o.months - 1));
  const first = monthStart(firstMonth);
  const last = monthEnd(o.endMonth);
  const months = monthRange(firstMonth, o.endMonth);
  const monthAt = (i: number) => months[Math.min(Math.max(i, 0), months.length - 1)];

  const events: Ev[] = [];
  let seq = 0;
  const add = (
    date: IsoDate,
    cents: number,
    category: string,
    party: Party,
    extra: { stylist?: string | null; trap?: string } = {},
  ) => {
    if (date < first || date > last) return;
    events.push({ seq: seq++, date, cents, category, stylist: extra.stylist ?? null, party, trap: extra.trap });
  };

  // Leaver / starter only make sense when there's room for both inside the window.
  const leaveIdx = Math.floor(o.months * 0.55);
  const hasTurnover = o.months >= 3 && leaveIdx + 1 <= o.months - 1;
  const moniqueEnd = hasTurnover ? dayOf(monthAt(leaveIdx), 20) : null;
  const jordanStart = hasTurnover ? dayOf(monthAt(leaveIdx + 1), 3) : null;

  const roster: FakeRosterEntry[] = [];

  // --- Ann: weekly, plain name match. Short first name is a substring of unrelated deposits. -----
  {
    const start = firstOnOrAfter(first, 5);
    roster.push({ name: "Ann", matchText: null, cadence: "weekly", rentCents: 27500, startDate: start, endDate: null, chairLabel: "Chair 1" });
    const dues = dueDates(start, 7, last);
    const missed = Math.floor(dues.length * 0.4);
    dues.forEach((due, i) => {
      if (dues.length >= 4 && i === missed) return; // missed week...
      const doubled = dues.length >= 4 && i === missed + 1; // ...then paid for two weeks at once
      add(addDays(due, int(0, 1)), doubled ? 55000 : 27500, "Booth Rent", { zelle: "in", party: "ANN WHITAKER" }, {
        stylist: "Ann",
        trap: doubled ? "missed-week-then-double" : undefined,
      });
    });
  }

  // --- Dana: weekly; two payments arrive as Venmo cashouts instead of Zelle. ---------------------
  {
    const start = firstOnOrAfter(first, 1);
    roster.push({ name: "Dana Fisk", matchText: null, cadence: "weekly", rentCents: 17500, startDate: start, endDate: null, chairLabel: "Chair 5" });
    const dues = dueDates(start, 7, last);
    const venmo = new Set(dues.length >= 6 ? [Math.floor(dues.length * 0.25), Math.floor(dues.length * 0.7)] : []);
    dues.forEach((due, i) => {
      const date = addDays(due, int(0, 1));
      if (venmo.has(i)) {
        add(date, 17500, "Booth Rent", { text: `VENMO DES:CASHOUT ID:ST-${ref(12)} INDN:EXAMPLE SALON COLLECTIVE CO ID:1453728806 CCD` }, { trap: "venmo-cashout" });
      } else {
        add(date, 17500, "Booth Rent", { zelle: "in", party: "DANA FISK" }, { stylist: "Dana Fisk" });
      }
    });
  }

  // --- Kelsey: biweekly, her husband sends the Zelle. One short payment. -------------------------
  {
    const start = firstOnOrAfter(first, 2);
    roster.push({
      name: "Kelsey Ortiz",
      matchText: "MARCUS ORTIZ, KELSEY ORTIZ",
      cadence: "biweekly",
      rentCents: 47500,
      startDate: start,
      endDate: null,
      chairLabel: "Chair 2",
    });
    const dues = dueDates(start, 14, last);
    const short = dues.length >= 4 ? Math.floor(dues.length * 0.6) : -1;
    dues.forEach((due, i) => {
      add(addDays(due, int(0, 2)), i === short ? 42500 : 47500, "Booth Rent", { zelle: "in", party: "MARCUS ORTIZ" }, {
        stylist: "Kelsey Ortiz",
        trap: tags("payer-differs-from-name", i === short ? "short-payment" : undefined),
      });
    });
  }

  // --- Tasha: monthly, pays from her LLC. One short month. ---------------------------------------
  {
    roster.push({ name: "Tasha Greer", matchText: "TG BEAUTY", cadence: "monthly", rentCents: 105000, startDate: first, endDate: null, chairLabel: "Chair 3" });
    const short = months.length >= 4 ? Math.floor(months.length * 0.3) : -1;
    months.forEach((m, i) => {
      add(dayOf(m, int(1, 3)), i === short ? 95000 : 105000, "Booth Rent", { zelle: "in", party: "TG BEAUTY LLC" }, {
        stylist: "Tasha Greer",
        trap: tags("payer-llc", i === short ? "short-payment" : undefined),
      });
    });
  }

  // --- Monique: weekly, leaves mid-period. One catch-up with two identical same-day Zelles. ------
  {
    const start = firstOnOrAfter(first, 3);
    roster.push({ name: "Monique Dale", matchText: null, cadence: "weekly", rentCents: 25000, startDate: start, endDate: moniqueEnd, chairLabel: "Chair 4" });
    const dues = dueDates(start, 7, moniqueEnd ?? last);
    const catchUp = dues.length >= 5 ? Math.floor(dues.length * 0.35) : -1;
    dues.forEach((due, i) => {
      if (i === catchUp - 1) return; // skipped; paid next week along with that week's rent
      const date = addDays(due, int(0, 1));
      const pay = { zelle: "in", party: "MONIQUE DALE" } as const;
      if (i === catchUp) {
        add(date, 25000, "Booth Rent", pay, { stylist: "Monique Dale", trap: "same-day-identical" });
        add(date, 25000, "Booth Rent", pay, { stylist: "Monique Dale", trap: "same-day-identical" });
      } else {
        add(date, 25000, "Booth Rent", pay, { stylist: "Monique Dale", trap: i === dues.length - 1 && moniqueEnd ? "stylist-leaves" : undefined });
      }
    });
  }

  // --- Jordan: monthly, starts mid-period in Monique's chair. ------------------------------------
  if (jordanStart) {
    roster.push({ name: "Jordan Pike", matchText: null, cadence: "monthly", rentCents: 90000, startDate: jordanStart, endDate: null, chairLabel: "Chair 4" });
    months.forEach((m) => {
      const date = dayOf(m, 3);
      if (date < jordanStart) return;
      add(date, 90000, "Booth Rent", { zelle: "in", party: "JORDAN PIKE" }, { stylist: "Jordan Pike", trap: date === jordanStart ? "stylist-starts" : undefined });
    });
  }

  // --- Monthly expenses ---------------------------------------------------------------------------
  const cancelIdx = Math.floor(o.months * 0.45); // last month QuickBooks is billed
  const equipmentIdx = Math.floor(o.months * 0.4);
  const refundIdx = Math.floor(o.months * 0.5);
  const joanneIdx = Math.floor(o.months * 0.3);
  const annualIdx = Math.floor(o.months * 0.2);
  const shannonIdx = Math.floor(o.months * 0.7);

  months.forEach((m, i) => {
    const cal = Number(m.slice(5));
    const yy = m.slice(2, 4);
    const mmdd = (date: IsoDate) => date.slice(5, 7) + date.slice(8, 10);

    add(dayOf(m, 1), -300000, "Rent & Lease", { text: "ACH DEBIT MERIDIAN PROPERTY GROUP RENT" });
    add(dayOf(m, int(8, 14)), -(11000 + (cal >= 6 && cal <= 8 ? 9000 : 0) + int(0, 4000)), "Utilities", { text: "AES INDIANA UTILITY PMT" });
    add(dayOf(m, int(12, 18)), -(6500 + int(0, 6000)), "Utilities", { text: "CITIZENS ENERGY GROUP GAS WATER" });
    add(dayOf(m, 20), -10990, "Utilities", { text: "COMCAST BUSINESS INTERNET" });
    if (cal === 3) add(dayOf(m, 5), -138600, "Insurance", { text: "HISCOX INC LIABILITY INS PREMIUM" });

    // Supplies: card purchases, with store numbers and dates between the words.
    const buys = int(5, 8);
    for (let k = 0; k < buys; k++) {
      const date = dayOf(m, int(2, 27));
      const cents = -int(1800, 16000);
      const store = pick(["sally", "salon", "cosmo", "amazon", "costco"] as const);
      const trapPos = "pos-ref-between-words";
      if (store === "sally") add(date, cents, "Supplies", { text: `POS PURCHASE ${mmdd(date)} SALLY BEAUTY #${int(1000, 1999)} INDIANAPOLIS IN` }, { trap: trapPos });
      else if (store === "salon") add(date, cents, "Supplies", { text: `DEBIT CARD PURCHASE SALONCENTRIC #0${int(400, 499)} CARMEL IN ${mmdd(date)}${yy}` }, { trap: trapPos });
      else if (store === "cosmo") add(date, cents, "Supplies", { text: `POS DEBIT ${mmdd(date)} COSMOPROF ${int(1100, 1199)} INDIANAPOLIS IN` }, { trap: trapPos });
      else if (store === "amazon") add(date, cents, "Supplies", { text: `AMAZON MKTPL*${ref(9)} AMZN.COM/BILL WA` });
      else add(date, cents, "Supplies", { text: "COSTCO WHSE #0653 INDIANAPOLIS IN" });
    }
    if (i % 3 === 1) {
      add(dayOf(m, int(5, 24)), -int(9000, 24000), "Supplies", { text: "ACH DEBIT SALLY BEAUTY SUPPLY, LLC ONLINE ORDER" }, { trap: "comma-in-description" });
    }

    add(dayOf(m, 25), -(14500 + int(0, 3000)), "Cleaning & Laundry", { text: `ACH DEBIT METRO LINEN SERVICE INV ${int(48000, 49999)}` });
    add(dayOf(m, 15), -24000, "Cleaning & Laundry", { zelle: "out", party: "BRIGHT SIDE CLEANING" });

    add(dayOf(m, 3), -3000, "Software & Subscriptions", { text: "VAGARO*SALON SOFTWARE 855-555-0142 CA" });
    add(dayOf(m, 14), -1440, "Software & Subscriptions", { text: "GOOGLE *WORKSPACE EXAMPLESALON.COM" });
    add(dayOf(m, 22), -1499, "Software & Subscriptions", { text: `CANVA* I0${int(4000, 4999)}-${int(10000, 99999)}` });
    if (i <= cancelIdx && cancelIdx < months.length - 1) {
      add(dayOf(m, 17), -8500, "Software & Subscriptions", { text: "INTUIT *QBooks Online 800-446-8848 CA" }, { trap: i === cancelIdx ? "subscription-cancelled-after-this" : undefined });
    }

    add(dayOf(m, 6), -int(7000, 15000), "Marketing & Advertising", { text: `FACEBK *${ref(10)}` });
    add(dayOf(m, 21), -int(7000, 15000), "Marketing & Advertising", { text: `FACEBK *${ref(10)}` });
    add(monthEnd(m), -1500, "Bank & Payment Fees", { text: "MONTHLY MAINTENANCE FEE" });
    add(monthEnd(m), int(100, 400), "Other Income", { text: "INTEREST PAYMENT" });

    if (i === equipmentIdx) add(dayOf(m, 10), -286000, "Equipment & Furniture", { text: "DEBIT CARD PURCHASE SALON INTERIORS OF INDY INDIANAPOLIS IN" });
    if (cal === 1 || cal === 4 || cal === 6 || cal === 9) add(dayOf(m, 15), -80000, "Taxes", { text: `IRS USATAXPYMT 2703${int(10000000, 99999999)}` });

    add(dayOf(m, 25), -(i % 2 === 0 ? 80000 : 60000), "Owner Draw", { text: "ONLINE BANKING TRANSFER TO SAV 8847" });
    if (i % 5 === 3) add(dayOf(m, 9), 100000, "Owner Contribution", { text: "ONLINE BANKING TRANSFER FROM SAV 8847" });

    // One-off deposits that are not booth rent (and contain a stylist's short name).
    if (i === annualIdx) add(dayOf(m, 4), 2500, "Other Income", { text: "ANNUAL REWARDS CREDIT" }, { trap: "name-substring-annual" });
    if (i === shannonIdx) add(dayOf(m, 11), 150000, "Owner Contribution", { text: "ONLINE TRANSFER FROM SHANNON KELLER SAVINGS" }, { trap: "name-substring-shannon" });
    if (i === joanneIdx) add(dayOf(m, 16), 4500, "Product Sales", { zelle: "in", party: "JOANNE MERCER" }, { trap: "name-substring-joanne" });
    if (i === refundIdx) {
      const date = dayOf(m, 12);
      add(date, 3499, "Supplies", { text: `POS RETURN ${mmdd(date)} SALLY BEAUTY #1234 INDIANAPOLIS IN` }, { trap: "supply-refund" });
    }
  });

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  return { events, roster, first, last, months };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function render(party: Party, memoMode: boolean): { description: string; memo: string } {
  if ("text" in party) return { description: party.text, memo: "" };
  const verb = party.zelle === "in" ? "RECEIVED" : "SENT";
  const dir = party.zelle === "in" ? "FROM" : "TO";
  return memoMode
    ? { description: `ZELLE PAYMENT ${verb}`, memo: `${dir} ${party.party}` }
    : { description: `ZELLE PAYMENT ${dir} ${party.party}`, memo: "" };
}

const OPENING_BALANCE_CENTS = 1_500_000;

export function generateFakeBmo(partial: Partial<FakeBmoOptions> = {}): { csv: string; truth: FakeTruth } {
  const o: FakeBmoOptions = { ...DEFAULT_FAKE_OPTIONS, ...partial };
  if (!Number.isInteger(o.months) || o.months < 1) throw new Error("months must be a positive integer");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.endMonth)) throw new Error("endMonth must be YYYY-MM");

  const { events, roster, first, last, months } = buildScenario(o);
  const memoMode = o.zelleSender === "memo";

  // Rows in time order, with running balance.
  let balance = OPENING_BALANCE_CENTS;
  const chrono: FakeTruthRow[] = events.map((e) => {
    balance += e.cents;
    const { description, memo } = render(e.party, memoMode);
    const row: FakeTruthRow = {
      date: e.date,
      amountCents: e.cents,
      description,
      memo,
      category: e.category,
      stylist: e.stylist,
      balanceCents: balance,
    };
    if (e.trap) row.trap = e.trap;
    return row;
  });
  const rows = o.order === "oldest" ? chrono : [...chrono].reverse();

  // CSV
  const headerCols =
    o.format === "single"
      ? ["Posted Date", "Description", ...(memoMode ? ["Memo"] : []), "Amount", "Balance"]
      : ["Date", "Description", ...(memoMode ? ["Memo"] : []), "Withdrawals", "Deposits", "Balance"];
  const lines: string[] = [];
  if (o.preamble) {
    lines.push(
      "Account Name: EXAMPLE SALON COLLECTIVE LLC",
      "Account Number: XXXXXX4821, Business Checking",
      `Activity date range: ${usDate(first)} to ${usDate(last)}, all transactions`,
      "",
    );
  }
  lines.push(headerCols.join(","));
  for (const r of rows) {
    const cells = [usDate(r.date), r.description];
    if (memoMode) cells.push(r.memo);
    if (o.format === "single") cells.push(plainAmount(r.amountCents));
    else cells.push(r.amountCents < 0 ? plainAmount(-r.amountCents) : "", r.amountCents > 0 ? plainAmount(r.amountCents) : "");
    cells.push(plainAmount(r.balanceCents));
    lines.push(cells.map(csvField).join(","));
  }
  const csv = lines.join("\r\n") + "\r\n";

  // Monthly rollups (transfers excluded).
  const rollups: FakeMonthRollup[] = months.map((month) => ({
    month,
    incomeCents: 0,
    expenseCents: 0,
    netCents: 0,
    boothRentByStylist: {},
  }));
  const byMonth = new Map(rollups.map((r) => [r.month, r]));
  for (const r of chrono) {
    const kind = CATEGORY_KIND.get(r.category);
    if (!kind) throw new Error(`Unknown category in fake data: ${r.category}`);
    const roll = byMonth.get(r.date.slice(0, 7));
    if (!roll || kind === "transfer") continue;
    if (kind === "income") roll.incomeCents += r.amountCents;
    else roll.expenseCents -= r.amountCents;
    if (r.category === "Booth Rent" && r.stylist) {
      roll.boothRentByStylist[r.stylist] = (roll.boothRentByStylist[r.stylist] ?? 0) + r.amountCents;
    }
  }
  for (const r of rollups) r.netCents = r.incomeCents - r.expenseCents;

  return {
    csv,
    truth: {
      options: o,
      rows,
      roster,
      totalChairs: 5,
      openingBalance: { cents: OPENING_BALANCE_CENTS, asOf: first },
      months: rollups,
    },
  };
}
