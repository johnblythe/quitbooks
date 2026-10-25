import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { suggestPattern } from "./categorize";
import {
  MAX_GROUPS_PER_REQUEST,
  MAX_SAMPLES,
  majoritySuggestion,
  buildSuggestRequest,
  pickExamples,
  suggestOutputSchema,
  typicalAmount,
  validateSuggestions,
  type SuggestCategory,
  type SuggestGroup,
} from "./ai-suggest";
import { chunk, groupInbox } from "./inbox";
import { inInbox } from "./inbox-where";

const { transactions, categories } = schema;

export const SUGGEST_MODEL = "claude-haiku-5-5";
export const SUGGEST_MAX_TOKENS = 4000;
/** Most uncategorized rows considered per run (newest first), matching the Inbox cap. */
export const SUGGEST_ROW_LIMIT = 2000;
const EXAMPLE_ROWS_SCANNED = 300;
const ID_CHUNK = 500;

type SuggestParams = Parameters<Anthropic["messages"]["parse"]>[0];
type SuggestResponse = { stop_reason: string | null; parsed_output?: unknown };

/** The slice of the SDK this module uses, so tests can inject a fake. */
export type SuggestClient = {
  messages: { parse(params: SuggestParams): Promise<SuggestResponse> };
};

export type SuggestResult = {
  /** Uncategorized rows that had no suggestion and were sent to the model. */
  requested: number;
  /** Rows that now have a stored suggestion. */
  suggested: number;
  batches: number;
  error?: string;
  skipped?: "no_api_key";
};

const empty = (): SuggestResult => ({ requested: 0, suggested: 0, batches: 0 });

/** Real client, wrapped to the narrow interface. Reads ANTHROPIC_API_KEY from the environment. */
function realClient(): SuggestClient {
  const sdk = new Anthropic({ maxRetries: 2, timeout: 60_000 });
  return { messages: { parse: (params) => sdk.messages.parse(params) } };
}

/** Logs the error class and HTTP status only: never the message, descriptions or keys. */
function logError(e: unknown): string {
  if (e instanceof Anthropic.APIError) {
    const tag = e instanceof Anthropic.APIConnectionError ? "connection" : String(e.status);
    console.error(`ai-suggest: Anthropic API error (${tag})`);
    return `api_error_${tag}`;
  }
  console.error(`ai-suggest: unexpected ${e instanceof Error ? e.name : "error"}`);
  return "unexpected_error";
}

export type SuggestGroupInput = { key: string; ids: string[] };
/** `results` is keyed by the caller's group key. `error` means nothing was written for this chunk. */
export type SuggestGroupsResult =
  | {
      results: Record<string, { categoryId: string | null }>;
      suggestedRows: number;
    }
  | { error: string };

/**
 * Suggests categories for a handful of groups (one model request). Rows that were already asked
 * (`suggested_at` set) are not sent again; their stored suggestion is returned. Everything else is
 * sent once, and the answer (or null = "asked, no suggestion") is written in one transaction,
 * guarded so a row sorted or suggested meanwhile is left alone. Best-effort: never throws, and an
 * API error or missing key writes nothing and returns `{ error }`.
 */
export async function suggestForGroups(opts: {
  db: Db;
  client?: SuggestClient;
  groups: SuggestGroupInput[];
}): Promise<SuggestGroupsResult> {
  try {
    const { db } = opts;
    const wanted = [...new Set(opts.groups.flatMap((g) => g.ids))];
    const rows: {
      id: string;
      amountCents: number;
      description: string;
      suggestedCategoryId: string | null;
      suggestedAt: Date | null;
    }[] = [];
    for (const ids of chunk(wanted, ID_CHUNK)) {
      rows.push(
        ...(await db
          .select({
            id: transactions.id,
            amountCents: transactions.amountCents,
            description: transactions.description,
            suggestedCategoryId: transactions.suggestedCategoryId,
            suggestedAt: transactions.suggestedAt,
          })
          .from(transactions)
          .where(and(inArray(transactions.id, ids), inInbox()))),
      );
    }
    const byId = new Map(rows.map((r) => [r.id, r]));

    const cats: SuggestCategory[] = (
      await db
        .select({
          id: categories.id,
          name: categories.name,
          kind: categories.kind,
        })
        .from(categories)
        .where(eq(categories.archived, false))
    ).map((c) => ({ id: c.id, name: c.name, kind: c.kind }));

    // Split into groups that still need the model and ones that are already answered.
    const toAsk: SuggestGroup[] = [];
    const askIds = new Map<string, string[]>();
    for (const g of opts.groups) {
      const live = g.ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
      const fresh = live.filter((r) => !r.suggestedAt);
      if (!fresh.length || !cats.length) continue;
      askIds.set(
        g.key,
        fresh.map((r) => r.id),
      );
      toAsk.push({
        key: g.key,
        pattern: suggestPattern(fresh[0].description) || fresh[0].description,
        direction: fresh[0].amountCents > 0 ? "in" : "out",
        count: fresh.length,
        sampleDescriptions: fresh.slice(0, MAX_SAMPLES).map((r) => r.description),
        typicalAmountCents: typicalAmount(fresh.map((r) => r.amountCents)),
      });
    }

    let suggestedRows = 0;
    const chosen = new Map<string, string | null>();
    if (toAsk.length) {
      if (!opts.client && !process.env.ANTHROPIC_API_KEY) return { error: "no_api_key" };
      const exampleRows = await db
        .select({
          description: transactions.description,
          amountCents: transactions.amountCents,
          categoryName: categories.name,
        })
        .from(transactions)
        .innerJoin(categories, eq(transactions.categoryId, categories.id))
        .where(isNotNull(transactions.categoryId))
        .orderBy(desc(transactions.date), desc(transactions.createdAt))
        .limit(EXAMPLE_ROWS_SCANNED);
      const examples = pickExamples(exampleRows);

      const client = opts.client ?? realClient();
      const { system, user } = buildSuggestRequest({
        categories: cats,
        examples,
        groups: toAsk,
      });
      const response = await client.messages.parse({
        model: SUGGEST_MODEL,
        max_tokens: SUGGEST_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        output_config: {
          effort: "low",
          format: zodOutputFormat(suggestOutputSchema(cats)),
        },
      });
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
        return { error: `model_${response.stop_reason}` };
      }
      const valid = new Map(
        validateSuggestions(response.parsed_output, {
          categories: cats,
          groups: toAsk,
        }).map((v) => [v.key, v.categoryId]),
      );
      const now = new Date();
      await db.transaction(async (tx) => {
        for (const g of toAsk) {
          const categoryId = valid.get(g.key) ?? null;
          for (const ids of chunk(askIds.get(g.key) ?? [], ID_CHUNK)) {
            const written = await tx
              .update(transactions)
              .set({ suggestedCategoryId: categoryId, suggestedAt: now })
              .where(and(inArray(transactions.id, ids), inInbox(), isNull(transactions.suggestedAt)))
              .returning({ id: transactions.id });
            for (const w of written) {
              const r = byId.get(w.id);
              if (r) {
                r.suggestedCategoryId = categoryId;
                r.suggestedAt = now;
              }
            }
            if (categoryId) suggestedRows += written.length;
          }
          chosen.set(g.key, categoryId);
        }
      });
    }

    const results: Record<string, { categoryId: string | null }> = {};
    for (const g of opts.groups) {
      const live = g.ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
      const direction = live.length && live[0].amountCents > 0 ? "in" : "out";
      results[g.key] = {
        categoryId: majoritySuggestion(
          live.map((r) => r.suggestedCategoryId),
          cats,
          direction,
        ),
      };
    }
    return { results, suggestedRows };
  } catch (e) {
    return { error: logError(e) };
  }
}

/**
 * Background path (cron, script, import-free sync): stores suggestions on every uncategorized row
 * that has not been asked yet, in chunks of groups. Best-effort: it never throws, and it never sets
 * a real category. Without ANTHROPIC_API_KEY (and no injected client) it returns `{ skipped }`.
 */
export async function suggestCategories(opts: { db: Db; client?: SuggestClient }): Promise<SuggestResult> {
  const result = empty();
  try {
    if (!opts.client && !process.env.ANTHROPIC_API_KEY) return { ...result, skipped: "no_api_key" };
    const { db } = opts;

    const rows = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        amountCents: transactions.amountCents,
        description: transactions.description,
      })
      .from(transactions)
      .where(and(inInbox(), isNull(transactions.suggestedAt)))
      .orderBy(desc(transactions.date), transactions.id)
      .limit(SUGGEST_ROW_LIMIT);
    if (!rows.length) return result;
    result.requested = rows.length;

    // Real groups plus one-offs as their own one-row groups.
    const { groups, oneOffs } = groupInbox(rows);
    const all: SuggestGroupInput[] = [
      ...groups.map((g) => ({ key: g.key, ids: g.ids })),
      ...oneOffs.map((r) => ({ key: `row|${r.id}`, ids: [r.id] })),
    ];

    for (const batch of chunk(all, MAX_GROUPS_PER_REQUEST)) {
      result.batches++;
      const r = await suggestForGroups({
        db,
        client: opts.client,
        groups: batch,
      });
      if ("error" in r) {
        result.error = r.error;
        break; // auth, rate-limit and outage errors would repeat; try again next run
      }
      result.suggested += r.suggestedRows;
    }
  } catch (e) {
    result.error = logError(e);
  }
  return result;
}
