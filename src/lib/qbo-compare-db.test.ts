/**
 * End to end on PGlite with the real migrations: import the synthetic QuickBooks Transaction Detail
 * sample through the real import path, then compare against the synthetic P&L by Month sample.
 *
 * fixtures/qbo-pnl-by-month.sample.csv is what QuickBooks would report for that detail file. A raw
 * import leaves the rows QuickBooks categorized but we deliberately don't (Booth Rent nobody matched,
 * a -Split- row, an asset purchase) in the Inbox; sorting those three is what makes it MATCH.
 *
 * Also: false-MATCH regressions (a file that doesn't add up, months not in the file, money the parser
 * can't place), the read-only wiring, and the real CLI's exit code and output.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { and, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { DEFAULT_CATEGORIES } from "@/db/defaults";
import * as schema from "@/db/schema";
import { makeCategorizer } from "./categorizer";
import { parseBankCsv } from "./csv";
import { CATEGORIZED_MAPPING_NAME, defaultChoices, summarizeFileCategories } from "./import-categories";
import { commitParsedImport } from "./import-commit";
import { QboCompareInputError } from "./qbo-compare";
import { runQboCompare, withReadOnly } from "./qbo-compare-db";
import { QboPnlParseError } from "./qbo-pnl";
import { saveSplit } from "./split-server";

const { transactions, importBatches, csvMappings, users, categories, stylists, rules } = schema;

const detail = readFileSync("fixtures/qbo-transaction-detail.sample.csv", "utf8");
const pnlCsv = readFileSync("fixtures/qbo-pnl-by-month.sample.csv", "utf8");

/** Replaces one exact line of the P&L sample (failing loudly if it isn't there). */
function editPnl(from: string, to: string, text = pnlCsv): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

async function openDb(dir?: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite(dir);
  const pg = drizzle(client, { schema });
  await migrate(pg, { migrationsFolder: "./drizzle" });
  return { db: pg as unknown as Db, close: () => client.close() };
}

/**
 * Fresh books with the sample imported the way the import screen does it: what `db:seed` creates,
 * two stylists, the detected mapping, default category choices, stylist matching and rules.
 */
async function seedAndImport(db: Db) {
  await db.delete(transactions);
  await db.delete(importBatches);
  await db.delete(csvMappings);
  await db.delete(rules);
  await db.delete(stylists);
  await db.delete(categories);
  await db.delete(users);
  const [u] = await db.insert(users).values({ email: "t@example.com", name: "T", passwordHash: "x" }).returning({ id: users.id });
  await db.insert(categories).values(
    DEFAULT_CATEGORIES.map((c, i) => ({ name: c.name, kind: c.kind, systemKey: c.systemKey ?? null, sortOrder: (i + 1) * 10 })),
  );
  const made = await db
    .insert(stylists)
    .values([
      { name: "Jane Doe", matchText: "JANE DOE", rentCents: 35000, rentCadence: "weekly", startDate: "2024-01-01" },
      { name: "Maria Ortiz", matchText: "MARIA ORTIZ", rentCents: 35000, rentCadence: "weekly", startDate: "2024-01-01" },
    ])
    .returning({ id: stylists.id, name: stylists.name });

  const parsed = parseBankCsv(detail);
  expect(parsed.mapping?.categoryColumn).toBe("Split");
  expect(parsed.errors).toHaveLength(1); // the 13/45/2025 row, which can't be imported
  const cats = await db.select({ id: categories.id, name: categories.name, kind: categories.kind, archived: categories.archived }).from(categories);
  const out = await commitParsedImport(db, {
    userId: u.id,
    filename: "qbo-transaction-detail.sample.csv",
    mappingName: CATEGORIZED_MAPPING_NAME,
    mapping: parsed.mapping!,
    rows: parsed.rows,
    links: [],
    categorizer: await makeCategorizer(db),
    categoryChoices: defaultChoices(summarizeFileCategories(parsed.rows), cats),
  });
  expect(out.inserted).toBe(parsed.rows.length);
  return { jane: made.find((s) => s.name === "Jane Doe")!.id };
}

function booksHelpers(db: Db) {
  const categoryId = async (name: string) => {
    const [c] = await db.select({ id: categories.id }).from(categories).where(eq(categories.name, name));
    return c.id;
  };
  const tx = async (description: string, date?: string) => {
    const rows = await db
      .select()
      .from(transactions)
      .where(date ? and(eq(transactions.description, description), eq(transactions.date, date)) : eq(transactions.description, description));
    expect(rows).toHaveLength(1);
    return rows[0];
  };
  /** What a person does in the Inbox to match QuickBooks for the three rows the importer leaves there. */
  const sortInboxLikeLauren = async (jane: string) => {
    // Booth Rent from a Zelle the stylist matcher couldn't place: Lauren knows it was Jane's.
    const stranger = await tx("Zelle from a stranger");
    await db.update(transactions).set({ categoryId: await categoryId("Booth Rent"), stylistId: jane }).where(eq(transactions.id, stranger.id));
    // QuickBooks had Costco as a split: supplies plus a repair part.
    const costco = await tx("Costco");
    const split = await saveSplit(db, costco.id, [
      { categoryId: await categoryId("Supplies"), stylistId: null, amountCents: -26055, memo: "Color and foils" },
      { categoryId: await categoryId("Repairs & Maintenance"), stylistId: null, amountCents: -5000, memo: "Sink part" },
    ]);
    expect(split.ok).toBe(true);
    // QuickBooks put the Amazon purchase on the balance sheet (Uncategorized Asset): not P&L.
    const amazon = await tx("Amazon — Stuff");
    await db.update(transactions).set({ categoryId: await categoryId("Transfer Between Accounts") }).where(eq(transactions.id, amazon.id));
  };
  return { categoryId, tx, sortInboxLikeLauren };
}

let mem: Awaited<ReturnType<typeof openDb>>;
let db: Db;
let jane: string;
let tx: ReturnType<typeof booksHelpers>["tx"];
let categoryId: ReturnType<typeof booksHelpers>["categoryId"];
let sortInboxLikeLauren: () => Promise<void>;

beforeAll(async () => {
  mem = await openDb();
  db = mem.db;
  const h = booksHelpers(db);
  tx = h.tx;
  categoryId = h.categoryId;
  sortInboxLikeLauren = () => h.sortInboxLikeLauren(jane);
});

afterAll(async () => {
  await mem.close();
});

beforeEach(async () => {
  ({ jane } = await seedAndImport(db));
});

const compare = (opts: Partial<Parameters<typeof runQboCompare>[1]> = {}, on: Db = db) =>
  runQboCompare(on, { csvText: pnlCsv, fileName: "qbo-pnl-by-month.sample.csv", database: "test PGlite", ...opts });

const cells = (run: Awaited<ReturnType<typeof compare>>) =>
  run.result.mismatches.map((c) => ({ month: c.month, label: c.label, qbo: c.qbo, ours: c.ours, diff: c.diff }));

describe("qbo:compare against the synthetic QuickBooks samples", () => {
  it("matches QuickBooks to the penny once the Inbox is sorted", async () => {
    await sortInboxLikeLauren();
    const run = await compare();

    expect(run.result.warnings).toEqual([]);
    expect(run.result.problems).toEqual([]);
    expect(cells(run)).toEqual([]);
    expect(run.match).toBe(true);
    expect(run.summary).toBe("MATCH: Jan 2025 to Mar 2025 (3 months)");
    expect(run.report.trimEnd().split("\n").at(-1)).toBe("MATCH: Jan 2025 to Mar 2025 (3 months)");
    expect(run.report).toContain("- Our books: test PGlite");
    for (const m of run.result.months) {
      expect(m.status).toBe("ok");
      expect(m.ours).toEqual({ income: m.qbo.income, expenses: m.qbo.expenses, inbox: m.qbo.inbox, net: m.qbo.net });
    }
    // Feb's Inbox, net: $75 in less $172 out, against Uncategorized Income less Uncategorized Expense and Ask My Accountant.
    expect(run.result.months.map((m) => m.qbo.inbox)).toEqual([0, -9700, 0]);
    // Net QB is the file's own Net Income row.
    expect(run.result.months.map((m) => m.qbo.netReported)).toEqual([-69607, -167075, -176602]);
    // Every QuickBooks account found its category through the mapping saved by the import.
    expect(run.result.unmapped).toEqual([]);
    expect(run.result.unmatchedCategories).toEqual([]);
    expect(new Set(run.result.mappings.map((m) => m.via))).toEqual(new Set(["saved import mapping"]));
    // What's still in the Inbox is what QuickBooks also left uncategorized.
    expect(run.result.inbox.map(({ month, inCents, outCents }) => ({ month, inCents, outCents }))).toEqual([
      { month: "2025-01", inCents: 0, outCents: 0 },
      { month: "2025-02", inCents: 7500, outCents: 17200 },
      { month: "2025-03", inCents: 0, outCents: 0 },
    ]);
  });

  it("flags exactly the changed cell and lists the transaction in it", async () => {
    await sortInboxLikeLauren();
    const square = await tx("Square — Card sales deposit", "2025-02-20");
    await db.update(transactions).set({ amountCents: 10300 }).where(eq(transactions.id, square.id));

    const run = await compare();
    expect(cells(run)).toEqual([{ month: "2025-02", label: "Product Sales", qbo: 13000, ours: 10300, diff: -2700 }]);
    const [cell] = run.result.mismatches;
    expect(cell.feeds).toEqual([{ account: "Product Sales", section: "income", cents: 13000 }]);
    expect(cell.lines.map((l) => [l.date, l.amountCents, l.tx.description, l.tx.source])).toEqual([
      ["2025-02-20", 10300, "Square — Card sales deposit", "csv"],
    ]);
    expect(run.report).toContain(`| 2025-02-20 | +$103.00 | Square — Card sales deposit | csv | /transactions/${square.id} |`);
    expect(run.result.months.map((m) => m.status)).toEqual(["ok", "cells", "ok"]);
    expect(run.match).toBe(false);
    expect(run.summary).toBe("1 mismatch, total abs diff $27.00");
    expect(run.report.trimEnd().split("\n").at(-1)).toBe("1 mismatch, total abs diff $27.00");
  });

  it("shows a recategorized transaction as the two cells it moved between, with month totals still equal", async () => {
    await sortInboxLikeLauren();
    const duke = await tx("Duke Energy", "2025-01-16");
    await db.update(transactions).set({ categoryId: await categoryId("Repairs & Maintenance") }).where(eq(transactions.id, duke.id));

    const run = await compare();
    expect(cells(run)).toEqual([
      { month: "2025-01", label: "Repairs & Maintenance", qbo: 0, ours: 14218, diff: 14218 },
      { month: "2025-01", label: "Utilities", qbo: 14218, ours: 0, diff: -14218 },
    ]);
    expect(run.result.months[0].status).toBe("ok");
    expect(run.result.mismatches[0].lines.map((l) => l.tx.id)).toEqual([duke.id]);
    expect(run.result.mismatches[1].lines).toEqual([]);
  });

  it("explains a raw import: Inbox money on one side, QuickBooks' category on the other", async () => {
    const run = await compare();
    const inbox = "Inbox: uncategorized, net (money in − money out)";
    expect(cells(run)).toEqual([
      { month: "2025-01", label: "Booth Rent", qbo: 140000, ours: 105000, diff: -35000 },
      { month: "2025-01", label: inbox, qbo: 0, ours: 35000, diff: 35000 },
      { month: "2025-02", label: "Supplies", qbo: 45075, ours: 19020, diff: -26055 },
      { month: "2025-02", label: "Repairs & Maintenance", qbo: 5000, ours: 0, diff: -5000 },
      // $75 in less $546.76 out, against $75 in less $172 out.
      { month: "2025-02", label: inbox, qbo: -9700, ours: -47176, diff: -37476 },
    ]);
    expect(run.summary).toBe("5 mismatches, total abs diff $1,385.31");
    const janInbox = run.result.mismatches[1];
    expect(janInbox.lines.map((l) => l.tx.description)).toEqual(["Zelle from a stranger"]);
    expect(run.result.mismatches[4].feeds.map((f) => [f.account, f.cents])).toEqual([
      ["Uncategorized Income", 7500],
      ["Uncategorized Expense", -5200],
      ["Ask My Accountant", -12000],
    ]);
    expect(run.result.inbox[1]).toMatchObject({ inCents: 7500, inCount: 1, outCents: 54676, outCount: 5 });
    // Net income is off only by the asset purchase QuickBooks keeps off the P&L.
    expect(run.result.months.map((m) => m.ours.net - m.qbo.net)).toEqual([0, -6421, 0]);
  });

  it("compares only the months asked for, and names them in the verdict", async () => {
    await sortInboxLikeLauren();
    const square = await tx("Square — Card sales deposit", "2025-02-20");
    await db.update(transactions).set({ amountCents: 10300 }).where(eq(transactions.id, square.id));

    expect((await compare({ from: "2025-03" })).summary).toBe("MATCH: Mar 2025 to Mar 2025 (1 month)");
    expect((await compare({ to: "2025-01" })).summary).toBe("MATCH: Jan 2025 to Jan 2025 (1 month)");
    const feb = await compare({ from: "2025-02", to: "2025-02" });
    expect(feb.result.columns.map((c) => c.month)).toEqual(["2025-02"]);
    expect(feb.summary).toBe("1 mismatch, total abs diff $27.00");
  });

  it("reads our books for only the days of a partial month, and says so above the verdict", async () => {
    // March 1-8 only: Jane's rent, Pat's retail sale and the Duke bill. March rent (the 9th) and the
    // plumber (the 12th) are after it, on our side too, or they would show up as mismatches.
    const text = [
      ',"Mar 1-8, 2025",Total',
      "Income,,",
      "Booth Rent,350.00,350.00",
      "Retail Sales,45.00,45.00",
      "Total for Income,395.00,395.00",
      "Expenses,,",
      "Utilities,151.02,151.02",
      "Total for Expenses,151.02,151.02",
      "Net Income,243.98,243.98",
      "",
      "Cash Basis",
    ].join("\n");
    const run = await compare({ csvText: text, from: "2025-03", to: "2025-03" });
    expect(cells(run)).toEqual([]);
    expect(run.result.months[0].ours).toEqual({ income: 39500, expenses: 15102, inbox: 0, net: 24398 });
    expect(run.match).toBe(true);
    expect(run.report.trimEnd().split("\n").slice(-2)).toEqual([
      `WARNING: partial month. Compared 2025-03 only from 2025-03-01 to 2025-03-08 ("Mar 1-8, 2025"); the rest of that month was not checked.`,
      "MATCH: Mar 1-8, 2025 to Mar 1-8, 2025 (1 month)",
    ]);
  });

  it("lets --map override the saved mapping, and lists our category left without an account", async () => {
    await sortInboxLikeLauren();
    const run = await compare({ overrides: { "Bank Charges": "bank & payment fees" } });
    expect(run.result.mappings.find((m) => m.fullName === "Bank Charges")).toMatchObject({ via: "--map", targetLabel: "Bank & Payment Fees" });
    expect(cells(run)).toEqual([
      { month: "2025-01", label: "Bank & Payment Fees", qbo: 1500, ours: 0, diff: -1500 },
      { month: "2025-01", label: "Bank Charges", qbo: 0, ours: 1500, diff: 1500 },
      { month: "2025-02", label: "Bank & Payment Fees", qbo: 1500, ours: 0, diff: -1500 },
      { month: "2025-02", label: "Bank Charges", qbo: 0, ours: 1500, diff: 1500 },
    ]);
    expect(run.result.unmatchedCategories.map((u) => [u.category.name, u.cents])).toEqual([["Bank Charges", 3000]]);
    await expect(compare({ overrides: { "Bank Charges": "Nope" } })).rejects.toBeInstanceOf(QboCompareInputError);
  });

  it("tolerates differences up to --tolerance-cents, and still reports them", async () => {
    await sortInboxLikeLauren();
    const square = await tx("Square — Card sales deposit", "2025-02-20");
    await db.update(transactions).set({ amountCents: 12999 }).where(eq(transactions.id, square.id));
    expect((await compare()).summary).toBe("1 mismatch, total abs diff $0.01");
    expect((await compare({ toleranceCents: 1 })).summary).toBe("MATCH: Jan 2025 to Mar 2025 (3 months); 1 cell within the $0.01 tolerance (sum $0.01)");
  });
});

describe("false-MATCH regressions: these used to say MATCH", () => {
  beforeEach(async () => {
    await sortInboxLikeLauren();
  });

  it("a Net Income row that disagrees with the file's accounts fails, though every cell agrees", async () => {
    // QuickBooks says Feb lost $41 less than its own accounts add up to.
    const text = editPnl(`Net Income,-696.07,"-1,670.75","-1,766.02","-4,132.84"`, `Net Income,-696.07,"-1,629.75","-1,766.02","-4,091.84"`);
    const run = await compare({ csvText: text });
    expect(cells(run)).toEqual([]);
    expect(run.result.problems.map((p) => p.message)).toEqual([`Line 30: "Net Income" for Feb 2025 says -$1,629.75, but the accounts add up to -$1,670.75.`]);
    expect(run.result.months.map((m) => m.status)).toEqual(["ok", "mismatch", "ok"]);
    expect(run.match).toBe(false);
    expect(run.summary).toBe("2 mismatches (1 month total, 1 problem in the QuickBooks file), total abs diff $41.00");
  });

  it("a section Total that disagrees with its accounts fails", async () => {
    const text = editPnl(`Total for Expenses,"1,980.17","2,005.00","2,161.02","6,146.19"`, `Total for Expenses,"2,005.17","2,005.00","2,161.02","6,171.19"`);
    const run = await compare({ csvText: text });
    expect(cells(run)).toEqual([]);
    expect(run.result.problems.map((p) => p.message)).toEqual([
      `Line 24: "Total for Expenses" for Jan 2025 says $2,005.17, but the accounts above it add up to $1,980.17.`,
    ]);
    expect(run.match).toBe(false);
  });

  it("a file cut off before Net Income fails", async () => {
    const text = pnlCsv.slice(0, pnlCsv.indexOf("Net Income,"));
    const run = await compare({ csvText: text });
    expect(cells(run)).toEqual([]);
    expect(run.result.problems.map((p) => p.message)).toEqual([expect.stringContaining('No "Net Income" row found')]);
    expect(run.match).toBe(false);
  });

  it("an account named 'Total Wine & More' is refused, not dropped", async () => {
    const text = editPnl(`Utilities,142.18,,151.02,293.20`, `Total Wine & More,25.00,,,25.00\nUtilities,142.18,,151.02,293.20`);
    await expect(compare({ csvText: text })).rejects.toThrow(/"Total Wine & More" has amounts and starts with "Total", but doesn't close any section/);
  });

  it("an unquoted thousands separator is refused, not read as $1.00 + $800.00", async () => {
    const text = editPnl(`Rent Expense,"1,800.00","1,800.00","1,800.00","5,400.00"`, `Rent Expense,1,800.00,"1,800.00","1,800.00","5,400.00"`);
    await expect(compare({ csvText: text })).rejects.toThrow(QboPnlParseError);
  });

  it("asking for months the file doesn't have is refused", async () => {
    await expect(compare({ to: "2025-06" })).rejects.toThrow(/covers Jan 2025 to Mar 2025, but you asked for 2025-01 to 2025-06/);
    await expect(compare({ from: "2024-12" })).rejects.toThrow(QboPnlParseError);
  });

  it("a gap between month columns is refused", async () => {
    // Drop the Feb column from every line: the header then skips from Jan to Mar.
    const noFeb = pnlCsv
      .split("\n")
      .map((line) => {
        const cells = line.match(/("[^"]*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "")) ?? [];
        return cells.length >= 4 ? [cells[0], cells[1], ...cells.slice(3)].join(",").replace(/,$/, "") : line;
      })
      .join("\n");
    expect(noFeb).toContain(",Jan 2025,Mar 2025,Total");
    await expect(compare({ csvText: noFeb })).rejects.toThrow(/skip from "Jan 2025" to "Mar 2025"/);
  });
});

describe("read only", () => {
  /**
   * The database as the compare sees it, with every top-level query method blocked so a read that
   * bypasses the transaction fails the test. `around` runs inside the compare's own transaction,
   * after its reads; `dropConfig` opens the transaction without READ ONLY.
   */
  function guarded(real: Db, opts: { around?: (tx: unknown) => Promise<void>; dropConfig?: boolean } = {}) {
    const configs: unknown[] = [];
    const blocked = new Set(["select", "selectDistinct", "selectDistinctOn", "insert", "update", "delete", "execute", "query", "with", "$count"]);
    const proxy = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (fn: (tx: unknown) => Promise<unknown>, config?: unknown) => {
            configs.push(config);
            return target.transaction(
              async (tx) => {
                const out = await fn(tx);
                await opts.around?.(tx);
                return out;
              },
              (opts.dropConfig ? undefined : config) as Parameters<Db["transaction"]>[1],
            );
          };
        }
        if (typeof prop === "string" && blocked.has(prop)) throw new Error(`db.${prop} was used outside the compare's read-only transaction`);
        return Reflect.get(target, prop, receiver);
      },
    });
    return { db: proxy, configs };
  }

  it("does every read inside one READ ONLY, REPEATABLE READ transaction", async () => {
    await sortInboxLikeLauren();
    const seen: Record<string, unknown> = {};
    const g = guarded(db, {
      around: async (t) => {
        const ex = (t as Db).execute.bind(t as Db);
        seen.readOnly = (await ex(sql`show transaction_read_only`)).rows[0];
        seen.isolation = (await ex(sql`show transaction_isolation`)).rows[0];
      },
    });
    const run = await compare({}, g.db);
    expect(run.summary).toBe("MATCH: Jan 2025 to Mar 2025 (3 months)");
    expect(g.configs).toEqual([{ isolationLevel: "repeatable read", accessMode: "read only" }]);
    expect(seen).toEqual({ readOnly: { transaction_read_only: "on" }, isolation: { transaction_isolation: "repeatable read" } });
  });

  it("a write through the compare's own transaction is refused by Postgres", async () => {
    const [before] = await db.select({ n: count() }).from(categories);
    let writeError: (Error & { cause?: Error }) | null = null;
    const g = guarded(db, {
      around: async (t) => {
        // In a savepoint, so the refused write doesn't abort the compare's transaction.
        writeError = await (t as Db)
          .transaction(async (sp) => {
            await sp.insert(categories).values({ name: "Sneaky", kind: "expense" });
          })
          .then(
            () => null,
            (e: Error & { cause?: Error }) => e,
          );
      },
    });
    await compare({}, g.db);
    expect((writeError as (Error & { cause?: Error }) | null)?.cause?.message).toMatch(/cannot execute INSERT in a read-only transaction/);
    const [after] = await db.select({ n: count() }).from(categories);
    expect(after.n).toBe(before.n);
  });

  it("refuses to read at all when the transaction isn't read-only", async () => {
    const g = guarded(db, { dropConfig: true });
    await expect(compare({}, g.db)).rejects.toThrow("Couldn't open a read-only transaction, so nothing was read.");
  });

  it("withReadOnly refuses writes", async () => {
    const [before] = await db.select({ n: count() }).from(categories);
    const err = await withReadOnly(db, (t) => t.insert(categories).values({ name: "Sneaky", kind: "expense" })).then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    // Drizzle wraps the Postgres error; the cause is Postgres refusing the write.
    expect(err?.cause?.message).toMatch(/cannot execute INSERT in a read-only transaction/);
    const [after] = await db.select({ n: count() }).from(categories);
    expect(after.n).toBe(before.n);
  });

  it("writes nothing while comparing", async () => {
    const snapshot = async () => ({
      tx: await db.select().from(transactions).orderBy(transactions.id),
      cats: await db.select().from(categories).orderBy(categories.id),
      maps: await db.select().from(csvMappings).orderBy(csvMappings.id),
    });
    const before = await snapshot();
    await compare();
    expect(await snapshot()).toEqual(before);
  });
});

describe("the CLI (npm run qbo:compare)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "qbo-compare-cli-"));
    const disk = await openDb(join(dir, "pglite"));
    const { jane: j } = await seedAndImport(disk.db);
    await booksHelpers(disk.db).sortInboxLikeLauren(j);
    await disk.close();
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cli = (args: string[]) => {
    const res = spawnSync(process.execPath, ["--import", "tsx", "scripts/qbo-compare.ts", ...args], {
      env: { ...process.env, DATABASE_URL: `pglite:${join(dir, "pglite")}` },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: res.status, out: res.stdout, err: res.stderr, last: res.stdout.trimEnd().split("\n").at(-1) };
  };
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  it("exits 0 on MATCH and names the local database", () => {
    const r = cli(["fixtures/qbo-pnl-by-month.sample.csv"]);
    expect(r.code).toBe(0);
    expect(r.last).toBe("MATCH: Jan 2025 to Mar 2025 (3 months)");
    expect(r.out).toContain(`- Our books: local PGlite (${join(dir, "pglite")}), not production`);
    expect(r.err).toContain("Reading our books from local PGlite");
  }, 60_000);

  it("exits 1 when the file's own Net Income disagrees, though every cell agrees", () => {
    const path = file("tampered.csv", editPnl(`Net Income,-696.07,"-1,670.75","-1,766.02","-4,132.84"`, `Net Income,-696.07,"-1,629.75","-1,766.02","-4,091.84"`));
    const r = cli([path]);
    expect(r.code).toBe(1);
    expect(r.last).toBe("2 mismatches (1 month total, 1 problem in the QuickBooks file), total abs diff $41.00");
  }, 60_000);

  it("exits 2 (an error, not a mismatch) on an empty --out or --map instead of ignoring it, and leaves an old report alone", () => {
    const stale = file("report.md", "MATCH: from an earlier run\n");
    for (const args of [["--out="], ["--out", ""], ["--map="], ["--map", ""]]) {
      const r = cli(["fixtures/qbo-pnl-by-month.sample.csv", ...args]);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/--(out|map) was given an empty value/);
    }
    expect(readFileSync(stale, "utf8")).toBe("MATCH: from an earlier run\n");
  }, 60_000);

  it("exits 2 with a message for months the file doesn't have, or a file it can't read", () => {
    const r = cli(["fixtures/qbo-pnl-by-month.sample.csv", "--to", "2025-06"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("but you asked for 2025-01 to 2025-06");
    const unreadable = cli([file("total-wine.csv", editPnl(`Utilities,142.18,,151.02,293.20`, `Total Wine & More,25.00,,,25.00\nUtilities,142.18,,151.02,293.20`))]);
    expect(unreadable.code).toBe(2);
    expect(unreadable.err).toMatch(/"Total Wine & More" has amounts and starts with "Total"/);
    const missing = cli([join(dir, "no-such-file.csv")]);
    expect(missing.code).toBe(2);
    expect(missing.out).toBe("");
  }, 60_000);

  it("prints a report far over 64 KB in full, verdict line last", () => {
    // 1,500 QuickBooks accounts we have nothing for: one mismatched cell each.
    const rows = Array.from({ length: 1500 }, (_, i) => `Unknown Account ${i + 1},1.00,,,1.00`);
    const text = [",Jan 2025,Feb 2025,Mar 2025,Total", "Expenses,,,,", ...rows, `Total for Expenses,"1,500.00",0.00,0.00,"1,500.00"`, `Net Income,"-1,500.00",0.00,0.00,"-1,500.00"`, "", "Cash Basis"].join("\n");
    const r = cli([file("big.csv", text)]);
    expect(r.out.length).toBeGreaterThan(200_000);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Unknown Account 1500");
    expect(r.last).toMatch(/^\d{4} mismatches, total abs diff \$[\d,]+\.\d\d$/);
  }, 60_000);
});
