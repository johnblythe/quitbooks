"use server";

import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { parseBankCsv, type CsvMapping, type RowError } from "@/lib/csv";
import { BMO_MAPPING_NAME, getCategorizer } from "@/lib/data";

const { transactions, importBatches, csvMappings, categories, stylists } = schema;

const MAX_BYTES = 5 * 1024 * 1024;

export type PreviewRow = {
  line: number;
  date: string;
  amountCents: number;
  description: string;
  duplicate: boolean;
  categoryName: string | null;
  stylistName: string | null;
};

export type ImportPreview = {
  headers: string[];
  mapping: CsvMapping | null;
  rows: PreviewRow[];
  errors: RowError[];
  newCount: number;
  duplicateCount: number;
};

export type ImportResult = { ok: true; inserted: number; skipped: number; months: string[] } | { ok: false; error: string };

async function existingHashes(hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const db = await getDb();
  const found = new Set<string>();
  // Chunk to keep query parameters reasonable.
  for (let i = 0; i < hashes.length; i += 500) {
    const chunk = hashes.slice(i, i + 500);
    const rows = await db
      .select({ h: transactions.dedupeHash })
      .from(transactions)
      .where(inArray(transactions.dedupeHash, chunk));
    rows.forEach((r) => r.h && found.add(r.h));
  }
  return found;
}

/** Parses the CSV and shows what would happen, without writing anything. */
export async function previewImport(text: string, mapping: CsvMapping | null): Promise<ImportPreview> {
  await requireUser();
  if (text.length > MAX_BYTES) {
    return { headers: [], mapping: null, rows: [], errors: [{ line: 0, message: "File is too large (5 MB max)." }], newCount: 0, duplicateCount: 0 };
  }
  const parsed = parseBankCsv(text, mapping);
  const dupes = await existingHashes(parsed.rows.map((r) => r.dedupeHash));
  const categorizer = await getCategorizer();

  const db = await getDb();
  const [cats, people] = await Promise.all([
    db.select({ id: categories.id, name: categories.name }).from(categories),
    db.select({ id: stylists.id, name: stylists.name }).from(stylists),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const stylistName = new Map(people.map((s) => [s.id, s.name]));

  const rows: PreviewRow[] = parsed.rows.map((r) => {
    const auto = categorizer(r);
    return {
      line: r.line,
      date: r.date,
      amountCents: r.amountCents,
      description: r.description,
      duplicate: dupes.has(r.dedupeHash),
      categoryName: auto.categoryId ? (catName.get(auto.categoryId) ?? null) : null,
      stylistName: auto.stylistId ? (stylistName.get(auto.stylistId) ?? null) : null,
    };
  });

  const duplicateCount = rows.filter((r) => r.duplicate).length;
  return {
    headers: parsed.headers,
    mapping: parsed.mapping,
    rows,
    errors: parsed.errors,
    newCount: rows.length - duplicateCount,
    duplicateCount,
  };
}

/** Imports new rows (skipping ones already imported) and saves the column mapping for next time. */
export async function commitImport(text: string, mapping: CsvMapping, filename: string): Promise<ImportResult> {
  const user = await requireUser();
  if (text.length > MAX_BYTES) return { ok: false, error: "File is too large (5 MB max)." };

  const parsed = parseBankCsv(text, mapping);
  if (!parsed.rows.length) return { ok: false, error: "No rows to import." };

  const db = await getDb();
  const dupes = await existingHashes(parsed.rows.map((r) => r.dedupeHash));
  const fresh = parsed.rows.filter((r) => !dupes.has(r.dedupeHash));
  const categorizer = await getCategorizer();

  const [batch] = await db
    .insert(importBatches)
    .values({
      filename: filename.slice(0, 200) || "import.csv",
      rowCount: parsed.rows.length,
      insertedCount: 0,
      skippedCount: 0,
      createdBy: user.userId,
    })
    .returning({ id: importBatches.id });

  let inserted = 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const chunk = fresh.slice(i, i + 200).map((r) => {
      const auto = categorizer(r);
      return {
        date: r.date,
        amountCents: r.amountCents,
        description: r.description,
        categoryId: auto.categoryId,
        stylistId: auto.stylistId,
        source: "csv" as const,
        importBatchId: batch.id,
        dedupeHash: r.dedupeHash,
        createdBy: user.userId,
      };
    });
    // onConflictDoNothing guards against a double-submit racing the duplicate check.
    const res = await db
      .insert(transactions)
      .values(chunk)
      .onConflictDoNothing({ target: transactions.dedupeHash })
      .returning({ id: transactions.id });
    inserted += res.length;
  }

  const skipped = parsed.rows.length - inserted;
  await db
    .update(importBatches)
    .set({ insertedCount: inserted, skippedCount: skipped })
    .where(inArray(importBatches.id, [batch.id]));

  await db
    .insert(csvMappings)
    .values({ name: BMO_MAPPING_NAME, mapping })
    .onConflictDoUpdate({ target: csvMappings.name, set: { mapping } });

  const months = [...new Set(fresh.map((r) => r.date.slice(0, 7)))].sort();
  return { ok: true, inserted, skipped, months };
}
