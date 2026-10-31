/**
 * suggestCategories on PGlite (real migrations) with an injected fake client. No network.
 */
import { PGlite } from "@electric-sql/pglite";
import Anthropic from "@anthropic-ai/sdk";
import { eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { MAX_GROUPS_PER_REQUEST } from "./ai-suggest";
import {
  MAX_BATCHES_PER_RUN,
  SUGGEST_MAX_TOKENS,
  SUGGEST_MODEL,
  SUGGEST_ROW_LIMIT,
  suggestCategories,
  suggestForGroups,
  type SuggestClient,
} from "./ai-suggest-server";
import { INBOX_LIMIT } from "./inbox";

const { transactions, categories } = schema;

let pg: PGlite;
let db: Db;
let supplies: string;
let rent: string;
let draw: string;
let oldCat: string;

type Group = { key: string; direction: "in" | "out" };
type Call = Parameters<SuggestClient["messages"]["parse"]>[0];

const groupsOf = (call: Call): Group[] => {
  const content = String((call.messages[0] as { content: string }).content);
  return JSON.parse(content.slice(content.indexOf("{"))).groups;
};
const groupCount = (call: Call) => groupsOf(call).length;

/**
 * Fake model: answers every group with a fixed kind-appropriate category (or per-test override).
 * `stop` is the stop_reason, or a function of the request's groups and the call number.
 */
function fake(
  over?: (groups: Group[], call: number) => unknown,
  stop: string | ((groups: Group[], call: number) => string) = "end_turn",
) {
  const calls: Call[] = [];
  const client: SuggestClient = {
    messages: {
      parse: async (params) => {
        calls.push(params);
        const groups = groupsOf(params);
        const parsed = over
          ? await over(groups, calls.length)
          : { suggestions: groups.map((g) => ({ key: g.key, categoryId: g.direction === "in" ? rent : supplies })) };
        return { stop_reason: typeof stop === "function" ? stop(groups, calls.length) : stop, parsed_output: parsed };
      },
    },
  };
  return { client, calls };
}

async function add(description: string, amountCents: number, extra: Partial<typeof transactions.$inferInsert> = {}) {
  const [r] = await db
    .insert(transactions)
    .values({ date: "2026-10-01", amountCents, description, source: "csv", ...extra })
    .returning({ id: transactions.id });
  return r.id;
}
/** `n` one-off vendors with distinct patterns, all on the same date. */
async function addVendors(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`;
    ids.push(await add(`VENDOR${w} SHOP`, -100 - i));
  }
  return ids;
}
const suggestionOf = async (id: string) =>
  (
    await db
      .select({ s: transactions.suggestedCategoryId, at: transactions.suggestedAt })
      .from(transactions)
      .where(eq(transactions.id, id))
  )[0];

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: "./drizzle" });
  db = d as unknown as Db;
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await db.delete(transactions);
  await db.delete(categories);
  const rows = await db
    .insert(categories)
    .values([
      { name: "Supplies", kind: "expense" },
      { name: "Booth Rent", kind: "income" },
      { name: "Owner Draw", kind: "transfer" },
      { name: "Old", kind: "expense", archived: true },
    ])
    .returning({ id: categories.id, name: categories.name });
  const id = (n: string) => rows.find((r) => r.name === n)!.id;
  supplies = id("Supplies");
  rent = id("Booth Rent");
  draw = id("Owner Draw");
  oldCat = id("Old");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("suggestCategories", () => {
  it("writes suggestions to uncategorized rows only, never a real category", async () => {
    const a = await add("AMAZON MKTPLACE 1", -1000);
    const b = await add("AMAZON MKTPLACE 2", -2000);
    const z = await add("ZELLE FROM BOB SMITH", 15000);
    const done = await add("ALREADY SORTED STORE", -500, { categoryId: supplies });
    const { client, calls } = fake();
    const r = await suggestCategories({ db, client });
    expect(r).toEqual({ requested: 3, suggested: 3, batches: 1 });
    expect((await suggestionOf(a)).s).toBe(supplies);
    expect((await suggestionOf(b)).s).toBe(supplies);
    expect((await suggestionOf(z)).s).toBe(rent);
    expect((await suggestionOf(a)).at).toBeInstanceOf(Date);
    expect((await suggestionOf(done)).s).toBeNull();
    // Suggestions are never applied.
    const withCategory = await db.select({ id: transactions.id }).from(transactions).where(isNotNull(transactions.categoryId));
    expect(withCategory.map((x) => x.id)).toEqual([done]);
    // Request shape.
    expect(calls).toHaveLength(1);
    const p = calls[0] as unknown as Record<string, unknown>;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(SUGGEST_MODEL).toBe("claude-haiku-5-5");
    expect(SUGGEST_ROW_LIMIT).toBe(INBOX_LIMIT);
    expect(p.max_tokens).toBe(SUGGEST_MAX_TOKENS);
    expect((p.output_config as { effort: string }).effort).toBe("low");
    expect((p.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    for (const banned of ["temperature", "top_p", "top_k"]) expect(p).not.toHaveProperty(banned);
    expect(p).not.toHaveProperty("thinking");
  });

  it("groups merchants (2 rows -> 1 group) and skips rows that already have a suggestion", async () => {
    const a = await add("AMAZON MKTPLACE 1", -1000);
    const b = await add("AMAZON MKTPLACE 2", -2000);
    const had = await add("OLD SUGGESTED SHOP", -300, { suggestedCategoryId: draw, suggestedAt: new Date("2026-01-01") });
    const { client, calls } = fake();
    const r = await suggestCategories({ db, client });
    expect(r.requested).toBe(2);
    const content = String((calls[0].messages[0] as { content: string }).content);
    expect(JSON.parse(content.slice(content.indexOf("{"))).groups).toHaveLength(1);
    expect((await suggestionOf(had)).s).toBe(draw);
    expect((await suggestionOf(a)).s).toBe(supplies);
    expect((await suggestionOf(b)).s).toBe(supplies);
    // A second run has nothing left to do and makes no request.
    const again = fake();
    expect(await suggestCategories({ db, client: again.client })).toEqual({ requested: 0, suggested: 0, batches: 0 });
    expect(again.calls).toHaveLength(0);
  });

  it("does not overwrite a row that was categorized after it was read", async () => {
    const a = await add("RACE VENDOR ONE", -1000);
    const { client } = fake((groups) => {
      // The owner sorts the row while the model is thinking.
      return db
        .update(transactions)
        .set({ categoryId: draw })
        .where(eq(transactions.id, a))
        .then(() => ({ suggestions: groups.map((g) => ({ key: g.key, categoryId: supplies })) }));
    });
    const r = await suggestCategories({ db, client });
    expect(r.suggested).toBe(0);
    expect((await suggestionOf(a)).s).toBeNull();
  });

  it("batches at 16 groups per request, at most 8 requests a run; the next run picks up the rest", async () => {
    await addVendors(130);
    const { client, calls } = fake();
    const r = await suggestCategories({ db, client });
    expect(MAX_GROUPS_PER_REQUEST).toBe(16);
    expect(MAX_BATCHES_PER_RUN).toBe(8);
    expect(r).toEqual({ requested: 130, suggested: 128, batches: 8 });
    expect(calls.map(groupCount)).toEqual([16, 16, 16, 16, 16, 16, 16, 16]);
    const next = fake();
    expect(await suggestCategories({ db, client: next.client })).toEqual({ requested: 2, suggested: 2, batches: 1 });
  });

  it("splits a batch that hits max_tokens and retries the halves", async () => {
    await addVendors(10);
    const { client, calls } = fake(undefined, (groups) => (groups.length > 3 ? "max_tokens" : "end_turn"));
    const r = await suggestCategories({ db, client });
    expect(r).toEqual({ requested: 10, suggested: 10, batches: 7 });
    expect(calls.map(groupCount)).toEqual([10, 5, 3, 2, 5, 3, 2]);
  });

  it("gives up on one group that never fits (marked asked), without blocking the rest", async () => {
    // Newest row, so it lands in the first batch.
    const poison = await add("POISON VENDOR", -999, { date: "2026-10-05" });
    const ids = await addVendors(19);
    const poisonKey = (groups: Group[]) => groups.some((g) => g.key === `row|${poison}`);
    const { client, calls } = fake(undefined, (groups) => (poisonKey(groups) ? "max_tokens" : "end_turn"));
    const r = await suggestCategories({ db, client });
    // 16 -> 8 -> 4 -> 2 -> the poison alone (given up) -> its siblings 1, 2, 4: the 8-request cap.
    expect(calls.map(groupCount)).toEqual([16, 8, 4, 2, 1, 1, 2, 4]);
    expect(r).toMatchObject({ requested: 20, suggested: 7, batches: 8, error: "model_max_tokens" });
    const p = await suggestionOf(poison);
    expect(p.s).toBeNull();
    expect(p.at).toBeInstanceOf(Date); // asked: not sent again
    // The next run gets everything else in one request and never re-sends the poison group.
    const next = fake();
    expect(await suggestCategories({ db, client: next.client })).toMatchObject({ suggested: 12, batches: 1 });
    expect(poisonKey(groupsOf(next.calls[0]))).toBe(false);
    for (const id of ids) expect((await suggestionOf(id)).s).toBe(supplies);
  });

  it("skips a refused batch and carries on; the refused rows aren't sent again", async () => {
    await addVendors(20);
    const { client, calls } = fake(undefined, (_groups, call) => (call === 1 ? "refusal" : "end_turn"));
    const r = await suggestCategories({ db, client });
    expect(r).toEqual({ requested: 20, suggested: 4, batches: 2, error: "model_refusal" });
    expect(calls.map(groupCount)).toEqual([16, 4]);
    const next = fake();
    expect(await suggestCategories({ db, client: next.client })).toEqual({ requested: 0, suggested: 0, batches: 0 });
  });

  it("stops after 2 failed batches in a row", async () => {
    await addVendors(40);
    const { client, calls } = fake(undefined, "refusal");
    const r = await suggestCategories({ db, client });
    expect(calls).toHaveLength(2);
    expect(r).toMatchObject({ requested: 40, suggested: 0, batches: 2, error: "model_refusal" });
  });

  it("stops at the first API error (it would repeat for every batch)", async () => {
    await addVendors(20);
    vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const client: SuggestClient = {
      messages: {
        parse: async () => {
          n++;
          throw Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "x" } }, "x", new Headers());
        },
      },
    };
    expect(await suggestCategories({ db, client })).toMatchObject({ batches: 1, suggested: 0, error: "api_error_401" });
    expect(n).toBe(1);
  });

  it("drops invalid model answers (wrong kind, archived, unknown)", async () => {
    const out = await add("SOME STORE ALPHA", -100);
    const out2 = await add("SOME STORE BETA", -200);
    const inn = await add("ZELLE FROM CAROL", 5000);
    const { client } = fake((groups) => ({
      suggestions: groups.map((g) => {
        const k = g.direction === "in" ? supplies : rent; // wrong kind for the direction
        return { key: g.key, categoryId: k };
      }),
    }));
    expect((await suggestCategories({ db, client })).suggested).toBe(0);
    const { client: c2 } = fake((groups) => ({ suggestions: groups.map((g) => ({ key: g.key, categoryId: oldCat })) }));
    expect((await suggestCategories({ db, client: c2 })).suggested).toBe(0);
    for (const id of [out, out2, inn]) expect((await suggestionOf(id)).s).toBeNull();
  });

  it("writes nothing on refusal or max_tokens", async () => {
    const a = await add("REFUSED VENDOR", -100);
    expect((await suggestCategories({ db, client: fake(undefined, "refusal").client })).suggested).toBe(0);
    expect((await suggestCategories({ db, client: fake(undefined, "max_tokens").client })).suggested).toBe(0);
    expect((await suggestionOf(a)).s).toBeNull();
  });

  it("swallows an API error, logs no descriptions, and reports it", async () => {
    await add("SECRET DESCRIPTION VENDOR", -100);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client: SuggestClient = {
      messages: {
        parse: async () => {
          throw Anthropic.APIError.generate(
            429,
            { type: "error", error: { type: "rate_limit_error", message: "SECRET DESCRIPTION VENDOR sk-ant-xyz" } },
            "SECRET DESCRIPTION VENDOR sk-ant-xyz",
            new Headers(),
          );
        },
      },
    };
    const r = await suggestCategories({ db, client });
    expect(r).toMatchObject({ requested: 1, suggested: 0, batches: 1, error: "api_error_429" });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("429");
    expect(logged).not.toContain("SECRET");
    expect(logged).not.toContain("sk-ant");
  });

  it("swallows non-API errors too (DB failure)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      select: () => {
        throw new Error("db down");
      },
    } as unknown as Db;
    const r = await suggestCategories({ db: broken, client: fake().client });
    expect(r.error).toBe("unexpected_error");
  });

  it("skips quietly without ANTHROPIC_API_KEY", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const a = await add("NO KEY VENDOR", -100);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await suggestCategories({ db });
    expect(r).toEqual({ requested: 0, suggested: 0, batches: 0, skipped: "no_api_key" });
    expect(spy).not.toHaveBeenCalled();
    expect((await suggestionOf(a)).s).toBeNull();
  });
});

describe("suggestCategories marks asked rows", () => {
  it("sets suggested_at even when the model answers null, and does not ask again", async () => {
    const a = await add("UNSURE VENDOR", -100);
    const { client } = fake((groups) => ({ suggestions: groups.map((g) => ({ key: g.key, categoryId: null })) }));
    const r = await suggestCategories({ db, client });
    expect(r).toEqual({ requested: 1, suggested: 0, batches: 1 });
    const row = await suggestionOf(a);
    expect(row.s).toBeNull();
    expect(row.at).toBeInstanceOf(Date);
    const again = fake();
    expect(await suggestCategories({ db, client: again.client })).toEqual({ requested: 0, suggested: 0, batches: 0 });
    expect(again.calls).toHaveLength(0);
  });
});

describe("suggestForGroups", () => {
  const sentKeys = (call: Call) => {
    const t = String((call.messages[0] as { content: string }).content);
    return (JSON.parse(t.slice(t.indexOf("{"))).groups as Group[]).map((g) => g.key).sort();
  };

  it("keys results by the caller's group keys (multi-row group and one-off)", async () => {
    const a1 = await add("AMAZON MKTPLACE 1", -1000);
    const a2 = await add("AMAZON MKTPLACE 2", -2000);
    const z = await add("ZELLE FROM BOB SMITH", 15000);
    const { client, calls } = fake();
    const r = await suggestForGroups({
      db,
      client,
      groups: [
        { key: "out|AMAZON MKTPLACE", ids: [a1, a2] },
        { key: z, ids: [z] },
      ],
    });
    expect(r).toEqual({
      results: { "out|AMAZON MKTPLACE": { categoryId: supplies }, [z]: { categoryId: rent } },
      suggestedRows: 3,
    });
    expect(calls).toHaveLength(1);
    expect(sentKeys(calls[0])).toEqual([z, "out|AMAZON MKTPLACE"].sort());
    for (const id of [a1, a2]) expect((await suggestionOf(id)).s).toBe(supplies);
    expect((await suggestionOf(z)).s).toBe(rent);
  });

  it("does not re-send rows that were already asked; returns their stored suggestion", async () => {
    const had = await add("ASKED SHOP", -300, { suggestedCategoryId: draw, suggestedAt: new Date("2026-01-01") });
    const askedNull = await add("ASKED NOTHING", -300, { suggestedAt: new Date("2026-01-01") });
    const fresh = await add("FRESH SHOP", -400);
    const { client, calls } = fake();
    const r = await suggestForGroups({
      db,
      client,
      groups: [
        { key: "g-had", ids: [had] },
        { key: "g-null", ids: [askedNull] },
        { key: "g-fresh", ids: [fresh] },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(sentKeys(calls[0])).toEqual(["g-fresh"]);
    expect(r).toMatchObject({
      results: { "g-had": { categoryId: draw }, "g-null": { categoryId: null }, "g-fresh": { categoryId: supplies } },
    });
    expect((await suggestionOf(had)).s).toBe(draw);
    // All asked: no model call at all, and no API key needed.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const none = await suggestForGroups({ db, groups: [{ key: "g-had", ids: [had] }] });
    expect(none).toMatchObject({ results: { "g-had": { categoryId: draw } } });
  });

  it("marks null answers as asked (suggested_at set, no category)", async () => {
    const a = await add("MYSTERY VENDOR", -100);
    const { client } = fake((groups) => ({ suggestions: groups.map((g) => ({ key: g.key, categoryId: null })) }));
    const r = await suggestForGroups({ db, client, groups: [{ key: "k", ids: [a] }] });
    expect(r).toEqual({ results: { k: { categoryId: null } }, suggestedRows: 0 });
    const row = await suggestionOf(a);
    expect(row.s).toBeNull();
    expect(row.at).toBeInstanceOf(Date);
    const again = fake();
    await suggestForGroups({ db, client: again.client, groups: [{ key: "k", ids: [a] }] });
    expect(again.calls).toHaveLength(0);
  });

  it("guard: rows categorized or suggested while the model ran are left alone", async () => {
    const sorted = await add("RACE ONE", -100);
    const raced = await add("RACE TWO", -100);
    const { client } = fake(async (groups) => {
      await db.update(transactions).set({ categoryId: draw }).where(eq(transactions.id, sorted));
      await db
        .update(transactions)
        .set({ suggestedCategoryId: draw, suggestedAt: new Date("2026-02-02") })
        .where(eq(transactions.id, raced));
      return { suggestions: groups.map((g) => ({ key: g.key, categoryId: supplies })) };
    });
    const r = await suggestForGroups({
      db,
      client,
      groups: [
        { key: "a", ids: [sorted] },
        { key: "b", ids: [raced] },
      ],
    });
    expect("error" in r).toBe(false);
    const s = await suggestionOf(sorted);
    expect(s.s).toBeNull();
    expect(s.at).toBeNull();
    expect((await suggestionOf(raced)).s).toBe(draw);
  });

  it("ignores ids that are already categorized", async () => {
    const done = await add("DONE SHOP", -100, { categoryId: supplies });
    const { client, calls } = fake();
    const r = await suggestForGroups({ db, client, groups: [{ key: "x", ids: [done] }] });
    expect(calls).toHaveLength(0);
    expect(r).toMatchObject({ results: { x: { categoryId: null } } });
    expect((await suggestionOf(done)).at).toBeNull();
  });

  it("an API error writes nothing and returns { error }", async () => {
    const a = await add("SECRET DESCRIPTION VENDOR", -100);
    const b = await add("OTHER VENDOR", -100);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client: SuggestClient = {
      messages: {
        parse: async () => {
          throw Anthropic.APIError.generate(
            429,
            { type: "error", error: { type: "rate_limit_error", message: "SECRET" } },
            "SECRET",
            new Headers(),
          );
        },
      },
    };
    const r = await suggestForGroups({
      db,
      client,
      groups: [
        { key: "a", ids: [a] },
        { key: "b", ids: [b] },
      ],
    });
    expect(r).toEqual({ error: "api_error_429" });
    for (const id of [a, b]) expect(await suggestionOf(id)).toEqual({ s: null, at: null });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET");
  });

  it("a refusal or a lone group out of tokens is marked asked; several groups out of tokens write nothing", async () => {
    const a = await add("REFUSED VENDOR", -100);
    const b = await add("RUNAWAY VENDOR", -100);
    const c = await add("BIG BATCH ONE", -100);
    const d = await add("BIG BATCH TWO", -200);
    expect(await suggestForGroups({ db, client: fake(undefined, "refusal").client, groups: [{ key: "a", ids: [a] }] })).toEqual({
      error: "model_refusal",
    });
    expect(await suggestForGroups({ db, client: fake(undefined, "max_tokens").client, groups: [{ key: "b", ids: [b] }] })).toEqual({
      error: "model_max_tokens",
    });
    for (const id of [a, b]) {
      const row = await suggestionOf(id);
      expect(row.s).toBeNull();
      expect(row.at).toBeInstanceOf(Date);
    }
    const two = [
      { key: "c", ids: [c] },
      { key: "d", ids: [d] },
    ];
    expect(await suggestForGroups({ db, client: fake(undefined, "max_tokens").client, groups: two })).toEqual({ error: "model_max_tokens" });
    for (const id of [c, d]) expect(await suggestionOf(id)).toEqual({ s: null, at: null });
  });

  it("missing key (no injected client) writes nothing and returns { error }", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const a = await add("NO KEY VENDOR", -100);
    expect(await suggestForGroups({ db, groups: [{ key: "a", ids: [a] }] })).toEqual({ error: "no_api_key" });
    expect(await suggestionOf(a)).toEqual({ s: null, at: null });
  });
});
