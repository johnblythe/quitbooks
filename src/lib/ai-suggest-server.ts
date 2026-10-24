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
  buildSuggestRequest,
  pickExamples,
  suggestOutputSchema,
  typicalAmount,
  validateSuggestions,
  type SuggestCategory,
  type SuggestGroup,
} from "./ai-suggest";
import { chunk, groupInbox } from "./inbox";

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
export type SuggestClient = { messages: { parse(params: SuggestParams): Promise<SuggestResponse> } };

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

/**
 * Stores a suggested category on uncategorized rows that have none yet. Best-effort: it never
 * throws, and it never sets a real category. Without ANTHROPIC_API_KEY (and no injected client)
 * it returns `{ skipped: "no_api_key" }`.
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
      .where(and(isNull(transactions.categoryId), isNull(transactions.suggestedCategoryId)))
      .orderBy(desc(transactions.date), transactions.id)
      .limit(SUGGEST_ROW_LIMIT);
    if (!rows.length) return result;
    result.requested = rows.length;

    const cats: SuggestCategory[] = (
      await db
        .select({ id: categories.id, name: categories.name, kind: categories.kind })
        .from(categories)
        .where(eq(categories.archived, false))
    ).map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
    if (!cats.length) return result;

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

    // Real groups plus one-offs as their own one-row groups; keys map back to row ids.
    const { groups, oneOffs } = groupInbox(rows);
    const idsByKey = new Map<string, string[]>();
    const all: SuggestGroup[] = [];
    for (const g of groups) {
      idsByKey.set(g.key, g.ids);
      all.push({
        key: g.key,
        pattern: g.pattern,
        direction: g.direction,
        count: g.count,
        sampleDescriptions: g.rows.slice(0, MAX_SAMPLES).map((r) => r.description),
        typicalAmountCents: typicalAmount(g.rows.map((r) => r.amountCents)),
      });
    }
    for (const r of oneOffs) {
      const key = `row|${r.id}`;
      idsByKey.set(key, [r.id]);
      all.push({
        key,
        pattern: suggestPattern(r.description) || r.description,
        direction: r.amountCents > 0 ? "in" : "out",
        count: 1,
        sampleDescriptions: [r.description],
        typicalAmountCents: Math.abs(r.amountCents),
      });
    }

    const client = opts.client ?? realClient();
    const format = zodOutputFormat(suggestOutputSchema(cats));

    for (const batch of chunk(all, MAX_GROUPS_PER_REQUEST)) {
      result.batches++;
      try {
        const { system, user } = buildSuggestRequest({ categories: cats, examples, groups: batch });
        const response = await client.messages.parse({
          model: SUGGEST_MODEL,
          max_tokens: SUGGEST_MAX_TOKENS,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: "low", format },
        });
        if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") continue;
        const valid = validateSuggestions(response.parsed_output, { categories: cats, groups: batch });
        const now = new Date();
        for (const s of valid) {
          for (const ids of chunk(idsByKey.get(s.key) ?? [], ID_CHUNK)) {
            const written = await db
              .update(transactions)
              .set({ suggestedCategoryId: s.categoryId, suggestedAt: now })
              .where(
                and(inArray(transactions.id, ids), isNull(transactions.categoryId), isNull(transactions.suggestedCategoryId)),
              )
              .returning({ id: transactions.id });
            result.suggested += written.length;
          }
        }
      } catch (e) {
        result.error = logError(e);
        break; // auth, rate-limit and outage errors would repeat; try again next run
      }
    }
  } catch (e) {
    result.error = logError(e);
  }
  return result;
}
