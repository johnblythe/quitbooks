import Papa from "papaparse";
import { createHash } from "node:crypto";
import { parseBankDate, type IsoDate } from "./dates";
import { parseAmountToCents } from "./money";

/**
 * How to read a bank CSV. BMO's export format hasn't been confirmed yet, so detection is
 * heuristic and the mapping is user-editable and saved once confirmed.
 */
export type CsvMapping = {
  dateColumn: string;
  descriptionColumn: string;
  /** "single": one signed Amount column. "split": separate debit (out) and credit (in) columns. */
  amountMode: "single" | "split";
  amountColumn?: string;
  debitColumn?: string;
  creditColumn?: string;
  /** Some banks export money-out as positive in a single column. Flip the sign if so. */
  invertSign?: boolean;
  /** Optional extra column appended to the description (e.g. a memo / Zelle sender column). */
  memoColumn?: string;
};

export type ParsedRow = {
  /** 1-based line number in the file (header = line 1). */
  line: number;
  date: IsoDate;
  amountCents: number;
  description: string;
  dedupeHash: string;
};

export type RowError = { line: number; message: string };

export type CsvParseResult = {
  headers: string[];
  mapping: CsvMapping | null;
  rows: ParsedRow[];
  errors: RowError[];
};

const DATE_HEADERS = ["posting date", "post date", "transaction date", "date", "posted date"];
const DESC_HEADERS = ["description", "transaction description", "details", "payee", "name", "memo"];
const AMOUNT_HEADERS = ["amount", "transaction amount", "amount ($)"];
const DEBIT_HEADERS = ["debit", "debits", "withdrawal", "withdrawals", "withdrawal amount", "money out"];
const CREDIT_HEADERS = ["credit", "credits", "deposit", "deposits", "deposit amount", "money in"];
const MEMO_HEADERS = ["memo", "notes", "additional info", "extended description"];

function findHeader(headers: string[], candidates: string[]): string | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i >= 0) return headers[i];
  }
  // Fall back to "contains" matching.
  for (const c of candidates) {
    const i = lower.findIndex((h) => h.includes(c));
    if (i >= 0) return headers[i];
  }
  return undefined;
}

/** Best-guess mapping from the header row. Returns null if it can't find date + description + amount. */
export function detectMapping(headers: string[]): CsvMapping | null {
  const dateColumn = findHeader(headers, DATE_HEADERS);
  const descriptionColumn = findHeader(headers, DESC_HEADERS);
  if (!dateColumn || !descriptionColumn) return null;

  const memoCandidate = findHeader(headers, MEMO_HEADERS);
  const memoColumn = memoCandidate && memoCandidate !== descriptionColumn ? memoCandidate : undefined;

  const debitColumn = findHeader(headers, DEBIT_HEADERS);
  const creditColumn = findHeader(headers, CREDIT_HEADERS);
  if (debitColumn && creditColumn && debitColumn !== creditColumn) {
    return { dateColumn, descriptionColumn, amountMode: "split", debitColumn, creditColumn, memoColumn };
  }

  const amountColumn = findHeader(headers, AMOUNT_HEADERS);
  if (amountColumn) {
    return { dateColumn, descriptionColumn, amountMode: "single", amountColumn, memoColumn };
  }
  return null;
}

export function normalizeDescription(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The identity of a bank row for dedupe: ISO date, amount as the bank wrote it (before any sign
 * inversion) and the description column only (normalized, memo excluded). None of the options a user
 * can edit in the mapping (memo column, sign inversion) feed into it, so re-importing with a changed
 * mapping still dedupes.
 */
function identityKey(date: string, rawCents: number, descriptionColumn: string): string {
  return `${date}|${rawCents}|${normalizeDescription(descriptionColumn).toUpperCase()}`;
}

function fingerprint(key: string, occurrence: number): string {
  return createHash("sha256").update(`${key}|${occurrence}`).digest("hex").slice(0, 32);
}

/**
 * Reads the amount. `cents` is the signed value stored in the ledger; `rawCents` is the value as the
 * bank wrote it, before `invertSign`. The dedupe hash uses `rawCents` so toggling the sign option
 * doesn't change any hash.
 */
function readAmount(
  record: Record<string, string>,
  mapping: CsvMapping,
): { cents: number; rawCents: number } | null {
  if (mapping.amountMode === "single") {
    const raw = parseAmountToCents(record[mapping.amountColumn ?? ""]);
    if (raw === null) return null;
    return { cents: mapping.invertSign ? -raw : raw, rawCents: raw };
  }
  const debitRaw = record[mapping.debitColumn ?? ""]?.trim() ?? "";
  const creditRaw = record[mapping.creditColumn ?? ""]?.trim() ?? "";
  const debit = debitRaw ? parseAmountToCents(debitRaw) : 0;
  const credit = creditRaw ? parseAmountToCents(creditRaw) : 0;
  if (debit === null || credit === null) return null;
  if (!debitRaw && !creditRaw) return null;
  // Debit = money out, regardless of whether the bank wrote it as positive or negative.
  const cents = Math.abs(credit) - Math.abs(debit);
  return { cents, rawCents: cents };
}

/**
 * Parses a bank CSV into normalized rows.
 * - If `mapping` is omitted, it's detected from the headers.
 * - Rows with zero amounts or unparseable values are reported in `errors` and skipped.
 * - `dedupeHash` is stable across re-imports of overlapping date ranges, and distinguishes
 *   genuinely repeated transactions (same day, amount, description) by their order in the file.
 */
export function parseBankCsv(text: string, mapping?: CsvMapping | null): CsvParseResult {
  // Some banks prepend account info lines before the real header; skip to the first line
  // that is a header. Prefer a line whose cells map to date + description + amount columns, so a
  // preamble line like "Activity date range: 10/01 to 10/31, all transactions" isn't mistaken for it.
  // Fall back to the first line with a comma and "date" in it (unknown headers, mapped by hand).
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const scan = Math.min(lines.length, 15);
  let start = -1;
  for (let i = 0; i < scan; i++) {
    if (!lines[i].includes(",")) continue;
    const cells = Papa.parse<string[]>(lines[i]).data[0] ?? [];
    if (detectMapping(cells.map((c) => c.trim()))) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    start = 0;
    for (let i = 0; i < scan; i++) {
      if (/date/i.test(lines[i]) && lines[i].includes(",")) {
        start = i;
        break;
      }
    }
  }
  const body = lines.slice(start).join("\n");

  const parsed = Papa.parse<Record<string, string>>(body, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  const effective = mapping ?? detectMapping(headers);

  const result: CsvParseResult = { headers, mapping: effective, rows: [], errors: [] };
  if (!effective) {
    result.errors.push({
      line: start + 1,
      message: "Couldn't find date, description and amount columns. Map them manually.",
    });
    return result;
  }

  const seen = new Map<string, number>();
  parsed.data.forEach((record, idx) => {
    const line = start + idx + 2; // +1 for header, +1 for 1-based
    const rawDate = record[effective.dateColumn] ?? "";
    const date = parseBankDate(rawDate);
    if (!date) {
      result.errors.push({ line, message: `Unrecognized date "${rawDate}"` });
      return;
    }
    const amount = readAmount(record, effective);
    if (amount === null) {
      result.errors.push({ line, message: "Missing, unrecognized or out-of-range amount" });
      return;
    }
    const amountCents = amount.cents;
    if (amountCents === 0) {
      result.errors.push({ line, message: "Zero amount, skipped" });
      return;
    }
    const descriptionCell = normalizeDescription(record[effective.descriptionColumn] ?? "");
    let description = descriptionCell;
    const memo = effective.memoColumn ? normalizeDescription(record[effective.memoColumn] ?? "") : "";
    if (memo && !description.includes(memo)) description = description ? `${description} — ${memo}` : memo;
    if (!description) description = "(no description)";

    const key = identityKey(date, amount.rawCents, descriptionCell);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    result.rows.push({
      line,
      date,
      amountCents,
      description,
      dedupeHash: fingerprint(key, occurrence),
    });
  });

  for (const e of parsed.errors) {
    result.errors.push({ line: (e.row ?? 0) + start + 2, message: e.message });
  }
  return result;
}
