import {
  pgTable,
  uuid,
  text,
  integer,
  date,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Money is always stored as integer cents.
 * Transactions use a signed amount: positive = money in, negative = money out.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["income", "expense", "transfer"] }).notNull(),
  /** System categories (e.g. Booth Rent) are referenced by code and can't be deleted. */
  systemKey: text("system_key").unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stylists = pgTable("stylists", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Text that appears in the bank description for their Zelle payments, e.g. "JANE DOE". */
  matchText: text("match_text"),
  chairLabel: text("chair_label"),
  rentCents: integer("rent_cents").notNull(),
  rentCadence: text("rent_cadence", { enum: ["weekly", "biweekly", "monthly"] })
    .notNull()
    .default("weekly"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const importBatches = pgTable("import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  rowCount: integer("row_count").notNull(),
  insertedCount: integer("inserted_count").notNull(),
  skippedCount: integer("skipped_count").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date").notNull(),
    amountCents: integer("amount_cents").notNull(),
    description: text("description").notNull(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    stylistId: uuid("stylist_id").references(() => stylists.id, { onDelete: "set null" }),
    note: text("note"),
    source: text("source", { enum: ["manual", "csv", "bank_sync"] }).notNull(),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id, {
      onDelete: "set null",
    }),
    /** Stable fingerprint of an imported bank row; prevents double-importing the same CSV. */
    dedupeHash: text("dedupe_hash"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_date_idx").on(t.date),
    index("transactions_category_idx").on(t.categoryId),
    index("transactions_stylist_idx").on(t.stylistId),
    uniqueIndex("transactions_dedupe_hash_idx").on(t.dedupeHash),
  ],
);

/** Auto-categorization rules. Matched case-insensitively against the transaction description. */
export const rules = pgTable("rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  pattern: text("pattern").notNull(),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  /** Optional: only apply to money in ("in") or money out ("out"). */
  direction: text("direction", { enum: ["any", "in", "out"] }).notNull().default("any"),
  priority: integer("priority").notNull().default(100),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Saved CSV column mappings, so the BMO export only has to be mapped once. */
export const csvMappings = pgTable("csv_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  mapping: jsonb("mapping").$type<import("@/lib/csv").CsvMapping>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Single-row-per-key settings (total chairs, opening balance, etc.). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Stylist = typeof stylists.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type Rule = typeof rules.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
