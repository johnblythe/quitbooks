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
import { SUGGEST_MAX_TOKENS, SUGGEST_MODEL, suggestCategories, type SuggestClient } from "./ai-suggest-server";

const { transactions, categories } = schema;

let pg: PGlite;
let db: Db;
let supplies: string;
let rent: string;
let draw: string;
let oldCat: string;

type Group = { key: string; direction: "in" | "out" };
type Call = Parameters<SuggestClient["messages"]["parse"]>[0];

/** Fake model: answers every group with a fixed kind-appropriate category (or per-test override). */
function fake(over?: (groups: Group[], call: number) => unknown, stop = "end_turn") {
  const calls: Call[] = [];
  const client: SuggestClient = {
    messages: {
      parse: async (params) => {
        calls.push(params);
        const content = String((params.messages[0] as { content: string }).content);
        const groups: Group[] = JSON.parse(content.slice(content.indexOf("{"))).groups;
        const parsed = over
          ? await over(groups, calls.length)
          : { suggestions: groups.map((g) => ({ key: g.key, categoryId: g.direction === "in" ? rent : supplies })) };
        return { stop_reason: stop, parsed_output: parsed };
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
const suggestionOf = async (id: string) =>
  (await db.select({ s: transactions.suggestedCategoryId, at: transactions.suggestedAt }).from(transactions).where(eq(transactions.id, id)))[0];

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

  it("batches at 60 groups per request", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 130; i++) {
      const w = `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`;
      ids.push(await add(`VENDOR${w} SHOP`, -100 - i));
    }
    const { client, calls } = fake();
    const r = await suggestCategories({ db, client });
    expect(r).toEqual({ requested: 130, suggested: 130, batches: 3 });
    const sizes = calls.map((c) => {
      const t = String((c.messages[0] as { content: string }).content);
      return JSON.parse(t.slice(t.indexOf("{"))).groups.length;
    });
    expect(sizes).toEqual([60, 60, 10]);
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
    const broken = { select: () => { throw new Error("db down"); } } as unknown as Db;
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
