import { z } from "zod";

import { MAX_CSV_BYTES } from "./import-limits";

const column = z.string().max(500);

/** Runtime shape of `CsvMapping` (server action arguments are untrusted input). */
export const csvMappingSchema = z.object({
  dateColumn: column,
  descriptionColumn: column,
  amountMode: z.enum(["single", "split"]),
  amountColumn: column.optional(),
  debitColumn: column.optional(),
  creditColumn: column.optional(),
  invertSign: z.boolean().optional(),
  memoColumn: column.optional(),
  categoryColumn: column.optional(),
  categoryMap: z
    .record(
      z.string().max(300),
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("existing"), categoryId: z.uuid() }),
        z.object({ type: z.literal("inbox") }),
      ]),
    )
    .optional(),
});

const choice = z.discriminatedUnion("type", [
  z.object({ type: z.literal("existing"), categoryId: z.uuid() }),
  z.object({
    type: z.literal("new"),
    name: z.string().trim().min(1).max(60),
    kind: z.enum(["income", "expense", "transfer"]),
  }),
  z.object({ type: z.literal("inbox") }),
]);

/** The import screen's choice per distinct file-category value, keyed by `categoryKey(value)`. */
export const categoryChoicesSchema = z.record(z.string().max(300), choice);

// A string has at most as many chars as bytes, so this only rejects what is certainly too big;
// the exact byte check follows.
export const csvTextSchema = z.string().max(MAX_CSV_BYTES);

export const filenameSchema = z.string().max(200);

/** A confirmed "this CSV row is that manual entry" link. */
export const linkSchema = z.object({
  line: z.number().int().positive(),
  transactionId: z.uuid(),
});
export const linksSchema = z.array(linkSchema).max(50_000);

export type ImportLink = z.infer<typeof linkSchema>;
