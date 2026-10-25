/**
 * SimpleFIN Bridge client + pure mapping. No DB, no Next. `fetch` is injectable for tests.
 * Protocol: https://www.simplefin.org/protocol.html
 */
import { parseAmountToCents } from "./money";
import { addDays, type IsoDate } from "./dates";

export const SALON_TZ = "America/Indiana/Indianapolis";
/** SimpleFIN allows 90 days per request but recommends ≤ 45 (its API warns above that). */
export const MAX_WINDOW_DAYS = 45;
export const BRIDGE_URL = "https://beta-bridge.simplefin.org";

export class SimplefinError extends Error {}

/** Strips `https://user:pass@` credentials from any text before it is stored or shown. */
export function redactSecrets(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]*:[^\s/@]*@/gi, "$1[redacted]@");
}

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return h === "simplefin.org" || h.endsWith(".simplefin.org");
}

/** SSRF guard: https only, host simplefin.org or *.simplefin.org, no embedded credentials or port. */
export function assertSimplefinUrl(raw: string, opts: { allowCredentials?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SimplefinError("That doesn't look like a SimpleFIN setup token.");
  }
  if (u.protocol !== "https:") throw new SimplefinError("SimpleFIN URLs must use https.");
  if (!hostAllowed(u.hostname)) throw new SimplefinError("That token doesn't point at SimpleFIN.");
  if (u.port) throw new SimplefinError("SimpleFIN URLs can't use a custom port.");
  if (!opts.allowCredentials && (u.username || u.password)) {
    throw new SimplefinError("That token doesn't look right.");
  }
  return u;
}

/** Setup token (base64 of a claim URL) -> validated claim URL. */
export function decodeSetupToken(token: string): string {
  const cleaned = token.trim().replace(/\s+/g, "");
  if (!cleaned || !/^[A-Za-z0-9+/_=-]+$/.test(cleaned)) {
    throw new SimplefinError("That doesn't look like a SimpleFIN setup token.");
  }
  const claim = Buffer.from(cleaned.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return assertSimplefinUrl(claim).toString();
}

type FetchFn = typeof fetch;

/** POSTs the claim URL once; returns the Access URL (contains credentials: encrypt it, never log it). */
export async function claimSetupToken(token: string, fetchFn: FetchFn = fetch): Promise<string> {
  const claimUrl = decodeSetupToken(token);
  let res: Response;
  try {
    res = await fetchFn(claimUrl, { method: "POST", redirect: "error" });
  } catch (e) {
    throw new SimplefinError(`Couldn't reach SimpleFIN: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
  }
  if (res.status === 403) throw new SimplefinError("That setup token was already used or is invalid. Make a new one.");
  if (!res.ok) throw new SimplefinError(`SimpleFIN refused the token (HTTP ${res.status}).`);
  const accessUrl = (await res.text()).trim();
  assertSimplefinUrl(accessUrl, { allowCredentials: true });
  return accessUrl;
}

// ---------- fetching ----------

export type SfTransaction = {
  id: string;
  posted: number;
  amount: string;
  description?: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
};
export type SfAccount = {
  id: string;
  name: string;
  currency?: string;
  balance: string;
  "available-balance"?: string;
  "balance-date": number;
  conn_id?: string;
  org?: { name?: string; domain?: string };
  transactions?: SfTransaction[];
};
export type SfAccountSet = {
  accounts: SfAccount[];
  errors?: string[];
  errlist?: { code?: string; msg?: string; conn_id?: string; account_id?: string }[];
  connections?: { conn_id: string; name?: string; org_name?: string }[];
};

export type FetchOptions = { startUnix?: number; endUnix?: number; balancesOnly?: boolean };

/** GET {access}/accounts?version=2. Credentials go in a Basic header, never in a logged URL. */
export async function fetchAccountSet(
  accessUrl: string,
  opts: FetchOptions = {},
  fetchFn: FetchFn = fetch,
): Promise<SfAccountSet> {
  const u = assertSimplefinUrl(accessUrl, { allowCredentials: true });
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`;
  u.username = "";
  u.password = "";
  u.pathname = `${u.pathname.replace(/\/$/, "")}/accounts`;
  u.searchParams.set("version", "2");
  if (opts.startUnix !== undefined) u.searchParams.set("start-date", String(opts.startUnix));
  if (opts.endUnix !== undefined) u.searchParams.set("end-date", String(opts.endUnix));
  if (opts.balancesOnly) u.searchParams.set("balances-only", "1");
  let res: Response;
  try {
    res = await fetchFn(u.toString(), { headers: { Authorization: auth }, redirect: "error" });
  } catch (e) {
    throw new SimplefinError(`Couldn't reach SimpleFIN: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
  }
  if (res.status === 402) throw new SimplefinError("SimpleFIN says the subscription needs payment (HTTP 402).");
  if (res.status === 403) throw new SimplefinError("SimpleFIN rejected the connection (HTTP 403). Re-link it at the Bridge.");
  if (!res.ok) throw new SimplefinError(`SimpleFIN returned HTTP ${res.status}.`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new SimplefinError("SimpleFIN returned an unreadable response.");
  }
  if (!json || typeof json !== "object" || !Array.isArray((json as SfAccountSet).accounts)) {
    throw new SimplefinError("SimpleFIN returned an unexpected response.");
  }
  return json as SfAccountSet;
}

/**
 * A response's error messages, redacted and split in two. `errors`: errlist entries that name one of
 * our accounts (`ours`: SimpleFIN account ids) or the connection one of them is under. `warnings`:
 * everything else, such as another bank on the same Bridge account, or a message that names nothing.
 * Only `errors` should fail a sync.
 */
export function classifyErrors(
  set: Pick<SfAccountSet, "accounts" | "errors" | "errlist">,
  ours: ReadonlySet<string>,
): { errors: string[]; warnings: string[] } {
  const connIds = new Set(set.accounts.flatMap((a) => (ours.has(String(a.id)) && a.conn_id ? [String(a.conn_id)] : [])));
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const e of set.errlist ?? []) {
    const msg = redactSecrets([e.code, e.msg].filter(Boolean).join(": "));
    if (!msg) continue;
    const mine = (e.account_id != null && ours.has(String(e.account_id))) || (e.conn_id != null && connIds.has(String(e.conn_id)));
    (mine ? errors : warnings).push(msg);
  }
  for (const e of set.errors ?? []) {
    if (typeof e !== "string" || !e) continue;
    const msg = redactSecrets(e);
    // The legacy list can repeat an errlist message; don't show it twice.
    if (![...errors, ...warnings].some((m) => m.includes(msg))) warnings.push(msg);
  }
  return { errors, warnings };
}

// ---------- pure mapping ----------

/** Unix seconds -> YYYY-MM-DD in the salon's time zone. */
export function unixToLocalDate(unix: number, timeZone: string = SALON_TZ): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(unix * 1000),
  );
}

export type MappedAccount = {
  externalId: string;
  name: string;
  orgName: string;
  currency: string;
  balanceCents: number | null;
  availableCents: number | null;
  balanceDate: Date | null;
};

export function mapAccount(a: SfAccount, set?: Pick<SfAccountSet, "connections">): MappedAccount {
  const conn = set?.connections?.find((c) => c.conn_id === a.conn_id);
  const balanceDate = Number.isFinite(a["balance-date"]) && a["balance-date"] > 0 ? new Date(a["balance-date"] * 1000) : null;
  const balanceCents = parseAmountToCents(a.balance);
  return {
    externalId: String(a.id),
    name: a.name,
    orgName: conn?.org_name ?? a.org?.name ?? conn?.name ?? "",
    currency: a.currency ?? "USD",
    balanceCents,
    // SimpleFIN may omit available-balance when it equals balance.
    availableCents: a["available-balance"] != null ? parseAmountToCents(a["available-balance"]) : balanceCents,
    balanceDate,
  };
}

export type MappedTx = { externalId: string; date: IsoDate; amountCents: number; description: string };

/** description + payee/memo, each added only if not already contained (case-insensitive). */
export function buildDescription(t: Pick<SfTransaction, "description" | "payee" | "memo">): string {
  const parts: string[] = [];
  for (const raw of [t.description, t.payee, t.memo]) {
    const p = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!p) continue;
    const lower = p.toLowerCase();
    if (parts.some((x) => x.toLowerCase().includes(lower))) continue;
    parts.push(p);
  }
  return parts.join(" · ");
}

/** Null for pending, unposted or unparseable rows. */
export function mapTransaction(t: SfTransaction, timeZone: string = SALON_TZ): MappedTx | null {
  if (t.pending === true) return null;
  if (!Number.isFinite(t.posted) || t.posted <= 0) return null;
  const amountCents = parseAmountToCents(t.amount);
  if (amountCents === null || t.id === undefined || t.id === null || String(t.id) === "") return null;
  return {
    externalId: String(t.id),
    date: unixToLocalDate(t.posted, timeZone),
    amountCents,
    description: buildDescription(t) || "(no description)",
  };
}

/** Splits [startUnix, endUnix) into consecutive windows of at most `maxDays`. */
export function splitWindows(startUnix: number, endUnix: number, maxDays: number = MAX_WINDOW_DAYS): [number, number][] {
  if (endUnix <= startUnix) return [];
  const step = maxDays * 86_400;
  const out: [number, number][] = [];
  for (let s = startUnix; s < endUnix; s += step) out.push([s, Math.min(s + step, endUnix)]);
  return out;
}

/** Local date -> unix seconds at UTC midnight, minus a day, so any time-zone offset is covered. */
export function dateToFetchStartUnix(date: IsoDate): number {
  const [y, m, d] = addDays(date, -1).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}
