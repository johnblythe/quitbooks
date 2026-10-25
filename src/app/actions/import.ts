"use server";

import { getDb, schema } from "@/db";
import { BOOTH_RENT_KEY } from "@/db/defaults";
import { requireUser } from "@/lib/auth";
import { mappingFits, parseBankCsv, type CsvMapping, type RowError } from "@/lib/csv";
import { BMO_MAPPING_NAME, CATEGORIZED_MAPPING_NAME, getCategorizer, getSavedMapping } from "@/lib/data";
import {
  commitParsedImport,
  existingHashes,
  findManualCandidates,
  ImportCategoryError,
  ImportLinkError,
} from "@/lib/import-commit";
import {
  categoryKey,
  defaultChoices,
  summarizeFileCategories,
  type CategoryGroup,
  type CategoryOption,
  type FileCategoryChoice,
} from "@/lib/import-categories";
import { matchManualEntries } from "@/lib/import-match";
import { activeCutoverDate } from "@/lib/bank-sync-server";
import { splitByCutover } from "@/lib/bank-cutover";
import { csvByteLength, MAX_CSV_BYTES, TOO_BIG_MESSAGE } from "@/lib/import-limits";
import {
  categoryChoicesSchema,
  csvMappingSchema,
  csvTextSchema,
  filenameSchema,
  linksSchema,
  type ImportLink,
} from "@/lib/import-schema";

const { categories, stylists } = schema;

export type PreviewMatch = { transactionId: string; date: string; description: string };

export type PreviewRow = {
  line: number;
  date: string;
  amountCents: number;
  description: string;
  duplicate: boolean;
  categoryName: string | null;
  /** What rules and stylist matching alone would pick (before any category from the file). */
  autoCategoryId: string | null;
  autoStylistId: string | null;
  /** `categoryKey` of the file's own category for this row, or null when it has none. */
  fileCategoryKey: string | null;
  stylistName: string | null;
  /** A hand-entered transaction this row probably is. The UI links them unless the user unticks it. */
  match: PreviewMatch | null;
};

export type ImportPreview = {
  headers: string[];
  mapping: CsvMapping | null;
  rows: PreviewRow[];
  errors: RowError[];
  newCount: number;
  duplicateCount: number;
  matchCount: number;
  /** Rows dated on/after the bank feed's start date; they are left out of the preview and the import. */
  coveredCount: number;
  /** Report lines (section headings, totals, footer) skipped without complaint. */
  skippedLines: number;
  /** Distinct values of the mapped category column, each with the choice to start from. */
  categoryGroups: (CategoryGroup & { choice: FileCategoryChoice })[];
  /** Categories a value can be mapped to (not archived). */
  categories: CategoryOption[];
  boothRentCategoryId: string | null;
};

export type ImportResult =
  | {
      ok: true;
      inserted: number;
      /** Rows already imported earlier. */
      skipped: number;
      /** Rows tied to an existing manual entry instead of being added again. */
      linked: number;
      months: string[];
      /** Rows that couldn't be read and were NOT imported. */
      errors: RowError[];
      /** Rows skipped because the bank feed already covers their dates. */
      covered: number;
      /** Categories created by "Create new" choices. */
      createdCategories: number;
      skippedLines: number;
    }
  | { ok: false; error: string };

function emptyPreview(message: string): ImportPreview {
  return {
    headers: [],
    mapping: null,
    rows: [],
    errors: [{ line: 0, message }],
    newCount: 0,
    duplicateCount: 0,
    matchCount: 0,
    coveredCount: 0,
    skippedLines: 0,
    categoryGroups: [],
    categories: [],
    boothRentCategoryId: null,
  };
}

/**
 * With no mapping from the user yet, prefer one saved from an earlier import whose columns all exist
 * in this file. A saved plain bank mapping isn't used for a file that has a category column of its
 * own, so a QuickBooks export doesn't inherit the BMO layout (or the other way around).
 */
async function pickSavedMapping(headers: string[], detected: CsvMapping | null): Promise<CsvMapping | null> {
  for (const name of [CATEGORIZED_MAPPING_NAME, BMO_MAPPING_NAME]) {
    const saved = await getSavedMapping(name);
    if (saved && mappingFits(saved, headers) && (saved.categoryColumn || !detected?.categoryColumn)) return saved;
  }
  return null;
}

/** Parses the CSV and shows what would happen, without writing anything. */
export async function previewImport(text: unknown, mapping: unknown): Promise<ImportPreview> {
  await requireUser();
  const t = csvTextSchema.safeParse(text);
  const m = csvMappingSchema.nullable().safeParse(mapping);
  if (!t.success || csvByteLength(t.data) > MAX_CSV_BYTES) return emptyPreview(TOO_BIG_MESSAGE);
  if (!m.success) return emptyPreview("That column mapping isn't valid.");

  const db = await getDb();
  let wanted = m.data;
  if (!wanted) {
    const detected = parseBankCsv(t.data, null);
    wanted = await pickSavedMapping(detected.headers, detected.mapping);
  }
  const parsedAll = parseBankCsv(t.data, wanted);
  const { kept, covered } = splitByCutover(parsedAll.rows, await activeCutoverDate(db));
  const parsed = { ...parsedAll, rows: kept };
  const dupes = await existingHashes(db, parsed.rows.map((r) => r.dedupeHash));
  const categorizer = await getCategorizer();

  const fresh = parsed.rows.filter((r) => !dupes.has(r.dedupeHash));
  const candidates = await findManualCandidates(db, fresh);
  const matches = matchManualEntries(fresh, candidates);

  const [cats, people] = await Promise.all([
    db
      .select({ id: categories.id, name: categories.name, kind: categories.kind, systemKey: categories.systemKey, archived: categories.archived })
      .from(categories),
    db.select({ id: stylists.id, name: stylists.name }).from(stylists),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const stylistName = new Map(people.map((s) => [s.id, s.name]));

  const rows: PreviewRow[] = parsed.rows.map((r) => {
    const auto = categorizer(r);
    const hit = matches.get(r.line);
    return {
      line: r.line,
      date: r.date,
      amountCents: r.amountCents,
      description: r.description,
      duplicate: dupes.has(r.dedupeHash),
      categoryName: auto.categoryId ? (catName.get(auto.categoryId) ?? null) : null,
      autoCategoryId: auto.categoryId,
      autoStylistId: auto.stylistId,
      fileCategoryKey: r.category ? categoryKey(r.category) : null,
      stylistName: auto.stylistId ? (stylistName.get(auto.stylistId) ?? null) : null,
      match: hit
        ? { transactionId: hit.candidate.id, date: hit.candidate.date, description: hit.candidate.description }
        : null,
    };
  });

  const duplicateCount = rows.filter((r) => r.duplicate).length;
  const options: CategoryOption[] = cats.filter((c) => !c.archived);
  const categoryGroups = parsed.mapping?.categoryColumn
    ? (() => {
        const groups = summarizeFileCategories(parsed.rows.filter((r) => !dupes.has(r.dedupeHash)));
        const choices = defaultChoices(groups, options, parsed.mapping.categoryMap);
        return groups.map((g) => ({ ...g, choice: choices[g.key] }));
      })()
    : [];
  return {
    headers: parsed.headers,
    mapping: parsed.mapping,
    rows,
    errors: parsed.errors,
    newCount: rows.length - duplicateCount,
    duplicateCount,
    matchCount: matches.size,
    coveredCount: covered.length,
    skippedLines: parsed.skippedLines,
    categoryGroups,
    categories: options,
    boothRentCategoryId: cats.find((c) => c.systemKey === BOOTH_RENT_KEY)?.id ?? null,
  };
}

/**
 * Imports new rows (skipping ones already imported), ties confirmed rows to existing manual
 * entries, and saves the column mapping for next time. All or nothing.
 * `ackErrors` must be true when the file has rows that couldn't be read.
 */
export async function commitImport(
  text: unknown,
  mapping: unknown,
  filename: unknown,
  links: unknown = [],
  ackErrors: unknown = false,
  categoryChoices: unknown = {},
): Promise<ImportResult> {
  const user = await requireUser();
  const t = csvTextSchema.safeParse(text);
  if (!t.success || csvByteLength(t.data) > MAX_CSV_BYTES) return { ok: false, error: TOO_BIG_MESSAGE };
  const m = csvMappingSchema.safeParse(mapping);
  const f = filenameSchema.safeParse(filename);
  const l = linksSchema.safeParse(links);
  const c = categoryChoicesSchema.safeParse(categoryChoices);
  if (!m.success || !f.success || !l.success || !c.success) return { ok: false, error: "That import request wasn't valid." };

  const db = await getDb();
  const parsedAll = parseBankCsv(t.data, m.data);
  if (!parsedAll.rows.length) return { ok: false, error: "No rows to import." };
  const { kept, covered } = splitByCutover(parsedAll.rows, await activeCutoverDate(db));
  const parsed = { ...parsedAll, rows: kept };
  if (parsed.errors.length && ackErrors !== true) {
    return {
      ok: false,
      error: `${parsed.errors.length} rows couldn't be read. Confirm you want to import without them.`,
    };
  }

  if (!parsed.rows.length) {
    return {
      ok: true,
      inserted: 0,
      skipped: 0,
      linked: 0,
      months: [],
      errors: parsed.errors,
      covered: covered.length,
      createdCategories: 0,
      skippedLines: parsed.skippedLines,
    };
  }
  const categorizer = await getCategorizer();
  const confirmed: ImportLink[] = l.data;

  try {
    const out = await commitParsedImport(db, {
      userId: user.userId,
      filename: f.data,
      mappingName: m.data.categoryColumn ? CATEGORIZED_MAPPING_NAME : BMO_MAPPING_NAME,
      mapping: m.data,
      rows: parsed.rows,
      links: confirmed,
      categorizer,
      categoryChoices: m.data.categoryColumn ? c.data : {},
    });
    return {
      ok: true,
      inserted: out.inserted,
      skipped: out.duplicates,
      linked: out.linked,
      months: out.months,
      errors: parsed.errors,
      covered: covered.length,
      createdCategories: out.createdCategories,
      skippedLines: parsed.skippedLines,
    };
  } catch (e) {
    if (e instanceof ImportLinkError || e instanceof ImportCategoryError) return { ok: false, error: e.message };
    throw e;
  }
}
