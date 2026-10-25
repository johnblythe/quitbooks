/**
 * The real sync core on PGlite (real migrations), the saved SimpleFIN demo fixture, and an injected fetch.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import {
  activeCutoverDate,
  connectBank,
  csvCutoverDate,
  disconnectBank,
  fetchStartDate,
  refreshBankAccounts,
  saveBankSelection,
  syncAllConnections,
  syncConnection,
  syncConnectionThrottled,
  type SyncDeps,
} from "./bank-sync-server";
import { defaultCutover } from "./bank-status";
import { decryptSecret } from "./bank-crypto";
import type { SfAccountSet } from "./simplefin";

const { transactions, bankConnections, bankAccounts, bankSyncRuns, rules, categories } = schema;

const fixture: SfAccountSet = JSON.parse(readFileSync("fixtures/simplefin-demo.json", "utf8"));
const TOKEN = Buffer.from("https://beta-bridge.simplefin.org/simplefin/claim/TEST").toString("base64");
const ACCESS = "https://uSeR:pAsS@beta-bridge.simplefin.org/simplefin";
const key = randomBytes(32);
const NOW = new Date("2026-10-26T15:00:00Z");

let client: PGlite;
let db: Db;

type Fake = { fetchFn: typeof fetch; gets: URL[]; posts: string[]; mode: { set: SfAccountSet; status?: number; throwMsg?: string } };

function fakeBank(set: SfAccountSet = fixture): Fake {
  const gets: URL[] = [];
  const posts: string[] = [];
  const mode: Fake["mode"] = { set };
  const fetchFn = (async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(String(input));
      return new Response(ACCESS);
    }
    const u = new URL(String(input));
    gets.push(u);
    if (mode.throwMsg) throw new Error(mode.throwMsg);
    if (mode.status) return new Response("nope", { status: mode.status });
    const s = Number(u.searchParams.get("start-date") ?? 0);
    const e = Number(u.searchParams.get("end-date") ?? 9e12);
    const body: SfAccountSet = {
      ...mode.set,
      accounts: mode.set.accounts.map((a) => ({
        ...a,
        transactions: u.searchParams.get("balances-only") ? undefined : (a.transactions ?? []).filter((t) => t.posted >= s && t.posted < e),
      })),
    };
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  return { fetchFn, gets, posts, mode };
}

const deps = (f: Fake, now = NOW): SyncDeps => ({ db, fetchFn: f.fetchFn, now, key });
const TODAY = "2026-10-26";

async function select(connectionId: string, cutover: string, include: string[]) {
  const accts = await db.select().from(bankAccounts).where(eq(bankAccounts.connectionId, connectionId));
  const ids = accts.filter((a) => include.includes(a.externalId)).map((a) => a.id);
  await saveBankSelection(db, connectionId, { includeAccountIds: ids, cutoverDate: cutover }, { today: TODAY });
}

async function setup(f: Fake, cutover = "2026-09-01", include = ["Demo Checking"]) {
  const { connectionId } = await connectBank(deps(f), TOKEN);
  await select(connectionId, cutover, include);
  return connectionId;
}

const startDay = (u: URL) => new Date(Number(u.searchParams.get("start-date")) * 1000).toISOString().slice(0, 10);
const savingsTxs = fixture.accounts.find((a) => a.id === "Demo Savings")!.transactions!;

const checkingTxs = fixture.accounts.find((a) => a.id === "Demo Checking")!.transactions!;
async function txCount() {
  const [r] = await db.select({ n: count() }).from(transactions);
  return r.n;
}

beforeAll(async () => {
  client = new PGlite();
  const pg = drizzle(client, { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  db = pg as unknown as Db;
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(transactions);
  await db.delete(bankConnections); // cascades runs; accounts are kept (detached)
  await db.delete(bankAccounts);
  await db.delete(rules);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connect", () => {
  it("claims, encrypts the Access URL, stores accounts as not-included, and defaults the start date", async () => {
    const f = fakeBank();
    const { connectionId } = await connectBank(deps(f), TOKEN, { label: "BMO" });
    const [conn] = await db.select().from(bankConnections).where(eq(bankConnections.id, connectionId));
    expect(conn.accessUrlEnc).not.toContain("pAsS");
    expect(decryptSecret(conn.accessUrlEnc, key)).toBe(ACCESS);
    const accts = await db.select().from(bankAccounts);
    expect(accts.map((a) => a.externalId).sort()).toEqual(["Demo Checking", "Demo Empty Account", "Demo Savings"]);
    expect(accts.every((a) => a.include === false)).toBe(true);
    expect(accts.find((a) => a.externalId === "Demo Checking")!.balanceCents).toBe(2448555);
    expect(f.gets[0].searchParams.get("balances-only")).toBe("1");
  });
  it("computes the default start date", () => {
    expect(defaultCutover("2026-10-10", "2026-10-24")).toBe("2026-10-11");
    expect(defaultCutover(null, "2026-10-24")).toBe("2026-07-26");
  });
  it("does nothing when no account is included", async () => {
    const f = fakeBank();
    const id = await setup(f, "2026-09-01", []);
    const gets = f.gets.length;
    expect(await syncConnection(deps(f), id)).toEqual({ inserted: 0, linked: 0, skipped: 0, errors: [], warnings: [] });
    expect(f.gets.length).toBe(gets);
    expect(await activeCutoverDate(db)).toBeNull();
  });
});

describe("syncConnection", () => {
  it("inserts posted rows, categorizes them, updates the balance, and is idempotent", async () => {
    const [cat] = await db.insert(categories).values({ name: "Test Supplies", kind: "expense" }).returning();
    await db.insert(rules).values({ pattern: "grocery", categoryId: cat.id });
    const f = fakeBank();
    const id = await setup(f);

    const r1 = await syncConnection(deps(f), id);
    expect(r1.errors).toEqual([]);
    expect(r1.inserted).toBe(checkingTxs.length);
    expect(r1.linked).toBe(0);
    expect(await txCount()).toBe(checkingTxs.length);

    const rows = await db.select().from(transactions);
    expect(rows.every((r) => r.source === "bank_sync" && r.externalId && r.bankAccountId)).toBe(true);
    const grocery = rows.filter((r) => /grocery/i.test(r.description));
    expect(grocery.length).toBeGreaterThan(0);
    expect(grocery.every((r) => r.categoryId === cat.id)).toBe(true);

    const [acct] = await db.select().from(bankAccounts).where(eq(bankAccounts.externalId, "Demo Checking"));
    expect(acct.balanceCents).toBe(2448555);
    expect(acct.balanceDate?.toISOString()).toBe(new Date(1792874959 * 1000).toISOString());
    const [conn] = await db.select().from(bankConnections);
    expect(conn.lastSyncedAt?.toISOString()).toBe(NOW.toISOString());
    expect(conn.lastError).toBeNull();

    const r2 = await syncConnection(deps(f, new Date(NOW.getTime() + 3600_000)), id);
    expect(r2.inserted).toBe(0);
    expect(r2.skipped).toBeGreaterThan(0);
    expect(await txCount()).toBe(checkingTxs.length);
  });

  it("only syncs included accounts", async () => {
    const f = fakeBank();
    const id = await setup(f);
    await syncConnection(deps(f), id);
    const rows = await db.select().from(transactions);
    const [chk] = await db.select().from(bankAccounts).where(eq(bankAccounts.externalId, "Demo Checking"));
    expect(new Set(rows.map((r) => r.bankAccountId))).toEqual(new Set([chk.id]));
  });

  it("drops rows dated before the cutover", async () => {
    const f = fakeBank();
    const id = await setup(f, "2026-10-20");
    const r = await syncConnection(deps(f), id);
    const rows = await db.select().from(transactions);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(checkingTxs.length);
    expect(rows.every((t) => t.date >= "2026-10-20")).toBe(true);
    expect(r.inserted).toBe(rows.length);
  });

  it("links a matching manual entry instead of inserting a duplicate", async () => {
    const f = fakeBank();
    const id = await setup(f);
    const target = checkingTxs.find((t) => t.amount === "2564.48")!;
    const [manual] = await db
      .insert(transactions)
      .values({ date: "2026-10-16", amountCents: 256448, description: "Jane rent (typed by hand)", source: "manual" })
      .returning();
    const unrelated = await db
      .insert(transactions)
      .values({ date: "2026-10-16", amountCents: 256449, description: "different amount", source: "manual" })
      .returning();

    const r = await syncConnection(deps(f), id);
    expect(r.linked).toBe(1);
    expect(r.inserted).toBe(checkingTxs.length - 1);
    const [after] = await db.select().from(transactions).where(eq(transactions.id, manual.id));
    expect(after.source).toBe("manual");
    expect(after.externalId).toBe(target.id);
    expect(after.bankAccountId).not.toBeNull();
    expect(after.description).toBe("Jane rent (typed by hand)");
    const [still] = await db.select().from(transactions).where(eq(transactions.id, unrelated[0].id));
    expect(still.externalId).toBeNull();
    expect(await txCount()).toBe(checkingTxs.length + 1);

    // second sync: no new link, no insert
    const r2 = await syncConnection(deps(f), id);
    expect(r2.inserted + r2.linked).toBe(0);
    expect(await txCount()).toBe(checkingTxs.length + 1);
  });

  it("windows the first fetch (<= 45 days each) and overlaps 7 days on later ones", async () => {
    const f = fakeBank();
    const id = await setup(f, "2026-06-01");
    const before = f.gets.length;
    await syncConnection(deps(f), id);
    const first = f.gets.slice(before);
    expect(first.length).toBe(Math.ceil((NOW.getTime() / 1000 - Number(first[0].searchParams.get("start-date"))) / (45 * 86400)));
    for (const u of first) expect(Number(u.searchParams.get("end-date")) - Number(u.searchParams.get("start-date"))).toBeLessThanOrEqual(45 * 86400);

    const later = new Date(NOW.getTime() + 86_400_000);
    f.gets.length = 0;
    await syncConnection(deps(f, later), id);
    expect(f.gets).toHaveLength(1);
    const startDay = new Date(Number(f.gets[0].searchParams.get("start-date")) * 1000).toISOString().slice(0, 10);
    expect(startDay).toBe("2026-10-18"); // lastSynced Oct 26 local, minus 7 days, minus the 1-day tz margin
    expect(fetchStartDate("2026-10-24", NOW)).toBe("2026-10-24");
  });

  it("records provider errors without advancing last_synced_at, and keeps the Access URL out", async () => {
    const f = fakeBank();
    const id = await setup(f);
    await syncConnection(deps(f), id);
    const [good] = await db.select().from(bankConnections);

    f.mode.set = { ...fixture, errlist: [{ code: "con.auth", msg: "Please re-authenticate with your bank.", conn_id: "CON-SIMPLEFIN-DEMO" }] };
    const r = await syncConnection(deps(f, new Date(NOW.getTime() + 86_400_000)), id);
    expect(r.errors).toEqual(["con.auth: Please re-authenticate with your bank."]);
    const [bad] = await db.select().from(bankConnections);
    expect(bad.lastError).toContain("re-authenticate");
    expect(bad.lastErrorAt).not.toBeNull();
    expect(bad.lastSyncedAt?.toISOString()).toBe(good.lastSyncedAt?.toISOString());

    f.mode.set = fixture;
    f.mode.status = 500;
    const r2 = await syncConnection(deps(f, new Date(NOW.getTime() + 2 * 86_400_000)), id);
    expect(r2.errors[0]).toMatch(/HTTP 500/);

    f.mode.status = undefined;
    f.mode.throwMsg = `socket hang up ${ACCESS}`;
    const r3 = await syncConnection(deps(f, new Date(NOW.getTime() + 3 * 86_400_000)), id);
    const [c3] = await db.select().from(bankConnections);
    expect(c3.lastError).toContain("[redacted]");
    expect(JSON.stringify([r3, c3.lastError])).not.toMatch(/pAsS|uSeR/);

    // recovery clears the error
    f.mode.throwMsg = undefined;
    await syncConnection(deps(f, new Date(NOW.getTime() + 4 * 86_400_000)), id);
    const [ok] = await db.select().from(bankConnections);
    expect(ok.lastError).toBeNull();
    expect(ok.lastErrorAt).toBeNull();
    const runs = await db.select().from(bankSyncRuns);
    expect(runs.some((r) => r.error)).toBe(true);
    expect(JSON.stringify(runs)).not.toMatch(/pAsS|uSeR/);
  });

  it("reports an included account SimpleFIN no longer returns", async () => {
    const f = fakeBank();
    const id = await setup(f);
    f.mode.set = { ...fixture, accounts: fixture.accounts.filter((a) => a.id !== "Demo Checking") };
    const r = await syncConnection(deps(f), id);
    expect(r.errors[0]).toMatch(/wasn't returned/);
  });

  it("skips pending rows", async () => {
    const f = fakeBank();
    const id = await setup(f);
    const pendingSet: SfAccountSet = {
      ...fixture,
      accounts: fixture.accounts.map((a) =>
        a.id === "Demo Checking"
          ? { ...a, transactions: [...(a.transactions ?? []), { id: "p1", posted: 0, amount: "-5.00", description: "pending", pending: true }, { id: "p2", posted: 1792800000, amount: "-6.00", description: "pending2", pending: true }] }
          : a,
      ),
    };
    f.mode.set = pendingSet;
    const r = await syncConnection(deps(f), id);
    expect(r.inserted).toBe(checkingTxs.length);
    expect((await db.select().from(transactions).where(eq(transactions.externalId, "p2"))).length).toBe(0);
  });
});

describe("throttle, cron, disconnect", () => {
  it("skips 'sync now' within 15 minutes", async () => {
    const f = fakeBank();
    const id = await setup(f);
    const first = await syncConnectionThrottled(deps(f), id);
    expect(first.throttled).toBe(false);
    const gets = f.gets.length;
    const again = await syncConnectionThrottled(deps(f, new Date(NOW.getTime() + 5 * 60_000)), id);
    expect(again).toMatchObject({ throttled: true, retryInMinutes: 10 });
    expect(f.gets.length).toBe(gets);
    expect((await syncConnectionThrottled(deps(f, new Date(NOW.getTime() + 16 * 60_000)), id)).throttled).toBe(false);
  });

  it("syncAll returns counts only", async () => {
    const f = fakeBank();
    await setup(f);
    const out = await syncAllConnections(deps(f));
    expect(out).toEqual({ connections: 1, inserted: checkingTxs.length, linked: 0, skipped: expect.any(Number), errors: 0, warnings: 0 });
  });

  it("reports the active cutover and disconnect keeps transactions", async () => {
    const f = fakeBank();
    const id = await setup(f, "2026-10-01");
    expect(await activeCutoverDate(db)).toBe("2026-10-01");
    await syncConnection(deps(f), id);
    await disconnectBank(db, id);
    expect(await txCount()).toBe(checkingTxs.length);
    // Accounts stay, detached and not included, so feed rows keep their account.
    const kept = await db.select().from(bankAccounts);
    expect(kept).toHaveLength(3);
    expect(kept.every((a) => a.connectionId === null && !a.include)).toBe(true);
    expect((await db.select({ n: count() }).from(bankConnections))[0].n).toBe(0);
    expect(await activeCutoverDate(db)).toBeNull();
  });
});

describe("start date and account changes after a sync (F1)", () => {
  it("an earlier start date makes the next sync fetch from it, even though it synced recently", async () => {
    const f = fakeBank();
    const id = await setup(f, "2026-10-20");
    await syncConnection(deps(f), id);
    const firstPass = await txCount();
    expect(firstPass).toBeLessThan(checkingTxs.length);

    await select(id, "2026-09-01", ["Demo Checking"]);
    expect((await db.select().from(bankConnections))[0].fullSyncPending).toBe(true);
    f.gets.length = 0;
    const r = await syncConnection(deps(f, new Date(NOW.getTime() + 3600_000)), id);
    expect(startDay(f.gets[0])).toBe("2026-08-31"); // the new start date, minus the 1-day tz margin
    expect(r.inserted).toBe(checkingTxs.length - firstPass);
    expect(await txCount()).toBe(checkingTxs.length);
    expect((await db.select().from(bankConnections))[0].fullSyncPending).toBe(false);

    // Back to the normal 7-day overlap afterwards.
    f.gets.length = 0;
    await syncConnection(deps(f, new Date(NOW.getTime() + 2 * 3600_000)), id);
    expect(startDay(f.gets[0])).toBe("2026-10-18");
  });

  it("a newly included account is fetched from the start date", async () => {
    const f = fakeBank();
    const id = await setup(f, "2026-09-01");
    await syncConnection(deps(f), id);
    await select(id, "2026-09-01", ["Demo Checking", "Demo Savings"]);
    f.gets.length = 0;
    const r = await syncConnection(deps(f, new Date(NOW.getTime() + 3600_000)), id);
    expect(startDay(f.gets[0])).toBe("2026-08-31");
    expect(r.inserted).toBe(savingsTxs.length);
    expect(await txCount()).toBe(checkingTxs.length + savingsTxs.length);
  });

  it("a later start date or dropping an account doesn't trigger a full fetch", async () => {
    const f = fakeBank();
    const id = await setup(f, "2026-09-01", ["Demo Checking", "Demo Savings"]);
    await syncConnection(deps(f), id);
    await select(id, "2026-09-15", ["Demo Checking"]);
    expect((await db.select().from(bankConnections))[0].fullSyncPending).toBe(false);
  });

  it("caps how far back a full fetch can start (SimpleFIN allows 24 requests a day)", async () => {
    const f = fakeBank();
    const { connectionId } = await connectBank(deps(f), TOKEN);
    await expect(select(connectionId, "2025-10-01", ["Demo Checking"])).rejects.toThrow(/at most a year back. Pick Oct 26, 2025 or later/);
    await select(connectionId, "2025-10-26", ["Demo Checking"]);
    f.gets.length = 0;
    await syncConnection(deps(f), connectionId);
    expect(f.gets.length).toBeLessThanOrEqual(9);
  });
});

describe("no duplicate feed rows (F2)", () => {
  it("disconnect then reconnect of the same SimpleFIN accounts doesn't import twice", async () => {
    const f = fakeBank();
    const id = await setup(f);
    await syncConnection(deps(f), id);
    const [before] = await db.select().from(bankAccounts).where(eq(bankAccounts.externalId, "Demo Checking"));
    await disconnectBank(db, id);

    const id2 = await setup(f, "2026-09-01");
    expect(id2).not.toBe(id);
    const [after] = await db.select().from(bankAccounts).where(eq(bankAccounts.externalId, "Demo Checking"));
    expect(after.id).toBe(before.id); // re-attached, not re-created
    expect(after.connectionId).toBe(id2);
    expect((await db.select({ n: count() }).from(bankAccounts))[0].n).toBe(3);

    const r = await syncConnection(deps(f, new Date(NOW.getTime() + 3600_000)), id2);
    expect(r.errors).toEqual([]);
    expect(r.inserted).toBe(0);
    expect(await txCount()).toBe(checkingTxs.length);
  });

  it("rejects a start date on or before the last CSV row", async () => {
    const f = fakeBank();
    const { connectionId } = await connectBank(deps(f), TOKEN);
    await db.insert(transactions).values({ date: "2026-08-31", amountCents: -100, description: "CSV ROW", source: "csv", dedupeHash: "h1" });
    await expect(select(connectionId, "2026-08-31", ["Demo Checking"])).rejects.toThrow(
      "Your imported CSV goes through Aug 31, 2026. Start the feed on Sep 1, 2026 or later.",
    );
    await expect(select(connectionId, "2026-08-01", ["Demo Checking"])).rejects.toThrow(/goes through Aug 31, 2026/);
    await select(connectionId, "2026-09-01", ["Demo Checking"]);
    expect(await activeCutoverDate(db)).toBe("2026-09-01");
  });

  it("the CSV guard covers feed rows from before a later-moved start date", async () => {
    const f = fakeBank();
    expect(await csvCutoverDate(db)).toBeNull();
    const id = await setup(f, "2026-09-01");
    expect(await csvCutoverDate(db)).toBe("2026-09-01");
    await syncConnection(deps(f), id);
    const [earliest] = (await db.select({ d: transactions.date }).from(transactions)).map((r) => r.d).sort();
    await select(id, "2026-10-20", ["Demo Checking"]);
    expect(await activeCutoverDate(db)).toBe("2026-10-20");
    expect(earliest < "2026-10-20").toBe(true);
    expect(await csvCutoverDate(db)).toBe(earliest);
  });
});

describe("connect never wastes the one-time token (F6)", () => {
  it("checks BANK_TOKEN_KEY before claiming", async () => {
    vi.stubEnv("BANK_TOKEN_KEY", "");
    const f = fakeBank();
    await expect(connectBank({ db, fetchFn: f.fetchFn, now: NOW }, TOKEN)).rejects.toThrow(/BANK_TOKEN_KEY/);
    expect(f.posts).toHaveLength(0);
    expect((await db.select({ n: count() }).from(bankConnections))[0].n).toBe(0);
  });

  it("keeps the claimed link when the account fetch fails, and a retry loads the accounts", async () => {
    const f = fakeBank();
    f.mode.status = 500;
    const out = await connectBank(deps(f), TOKEN);
    expect(out.accountsError).toMatch(/HTTP 500/);
    expect(f.posts).toHaveLength(1);
    const [conn] = await db.select().from(bankConnections).where(eq(bankConnections.id, out.connectionId));
    expect(decryptSecret(conn.accessUrlEnc, key)).toBe(ACCESS);
    expect(conn.lastError).toMatch(/HTTP 500/);
    expect((await db.select({ n: count() }).from(bankAccounts))[0].n).toBe(0);

    f.mode.status = undefined;
    await refreshBankAccounts(deps(f), out.connectionId);
    expect(f.posts).toHaveLength(1); // no second claim
    expect((await db.select({ n: count() }).from(bankAccounts).where(eq(bankAccounts.connectionId, out.connectionId)))[0].n).toBe(3);
    const [fixed] = await db.select().from(bankConnections).where(eq(bankConnections.id, out.connectionId));
    expect(fixed.lastError).toBeNull();
    expect(fixed.lastErrorAt).toBeNull();
  });
});

describe("errors about other connections are warnings (F10)", () => {
  it("still syncs and advances last_synced_at, and records the warning", async () => {
    const f = fakeBank();
    const id = await setup(f);
    f.mode.set = { ...fixture, errlist: [{ code: "con.auth", msg: "Chase needs re-authentication.", conn_id: "CON-CHASE" }] };
    const r = await syncConnection(deps(f), id);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(["con.auth: Chase needs re-authentication."]);
    expect(r.inserted).toBe(checkingTxs.length);
    const [conn] = await db.select().from(bankConnections);
    expect(conn.lastSyncedAt?.toISOString()).toBe(NOW.toISOString());
    expect(conn.lastError).toBeNull();
    expect(conn.lastWarning).toBe("con.auth: Chase needs re-authentication.");

    f.mode.set = fixture;
    await syncConnection(deps(f, new Date(NOW.getTime() + 3600_000)), id);
    expect((await db.select().from(bankConnections))[0].lastWarning).toBeNull();
  });
});

describe("a start date in the future (F13)", () => {
  it("fetches balances only, reports nothing missing, and counts as a good sync", async () => {
    const f = fakeBank();
    const id = await setup(f, "2026-11-15");
    f.gets.length = 0;
    const r = await syncConnection(deps(f), id);
    expect(f.gets).toHaveLength(1);
    expect(f.gets[0].searchParams.get("balances-only")).toBe("1");
    expect(r).toMatchObject({ inserted: 0, errors: [], warnings: [] });
    const [conn] = await db.select().from(bankConnections);
    expect(conn.lastError).toBeNull();
    expect(conn.lastSyncedAt?.toISOString()).toBe(NOW.toISOString());
    const [acct] = await db.select().from(bankAccounts).where(eq(bankAccounts.externalId, "Demo Checking"));
    expect(acct.balanceCents).toBe(2448555);
  });
});
