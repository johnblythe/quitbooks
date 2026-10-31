import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { parseBankCsv } from "./csv";
import { generateFakeBmo, type FakeBmoOptions } from "./fake-bmo";
import { parseAmountToCents } from "./money";

const combos: FakeBmoOptions[] = [];
for (const format of ["single", "split"] as const)
  for (const preamble of [true, false])
    for (const zelleSender of ["description", "memo"] as const)
      for (const order of ["newest", "oldest"] as const)
        combos.push({ months: 12, endMonth: "2026-09", seed: 7, format, preamble, zelleSender, order });

const label = (o: FakeBmoOptions) => `${o.format}/${o.preamble ? "preamble" : "bare"}/${o.zelleSender}/${o.order}`;

describe("generateFakeBmo", () => {
  it("is deterministic", () => {
    const a = generateFakeBmo(combos[3]);
    const b = generateFakeBmo(combos[3]);
    expect(b.csv).toBe(a.csv);
    expect(JSON.stringify(b.truth)).toBe(JSON.stringify(a.truth));
    expect(generateFakeBmo({ ...combos[3], seed: 8 }).csv).not.toBe(a.csv);
  });

  it("generates the same underlying scenario regardless of file shape", () => {
    const a = generateFakeBmo({ ...combos[0], zelleSender: "description", order: "oldest" });
    const b = generateFakeBmo({ ...combos[0], format: "split", zelleSender: "description", order: "oldest" });
    expect(b.truth.rows).toEqual(a.truth.rows);
  });

  it("covers every scenario element and trap in a 12-month file", () => {
    const { truth } = generateFakeBmo({ months: 12, endMonth: "2026-09", seed: 42 });
    const traps = new Set(truth.rows.flatMap((r) => (r.trap ? r.trap.split("+") : [])));
    for (const t of [
      "name-substring-annual",
      "name-substring-shannon",
      "name-substring-joanne",
      "payer-differs-from-name",
      "payer-llc",
      "stylist-leaves",
      "stylist-starts",
      "same-day-identical",
      "short-payment",
      "missed-week-then-double",
      "pos-ref-between-words",
      "comma-in-description",
      "supply-refund",
      "venmo-cashout",
      "subscription-cancelled-after-this",
    ]) {
      expect(traps, t).toContain(t);
    }
    const qb = truth.rows.filter((r) => r.description.includes("QBooks"));
    expect(qb.length).toBeGreaterThan(0);
    expect(qb.length).toBeLessThan(12);
    expect(truth.rows.filter((r) => r.category === "Taxes")).toHaveLength(4);
    expect(truth.rows.filter((r) => r.category === "Insurance")).toHaveLength(1);
    expect(truth.rows.find((r) => r.trap === "supply-refund")!.amountCents).toBeGreaterThan(0);
    expect(truth.totalChairs).toBe(5);
    expect(truth.roster.length).toBeGreaterThanOrEqual(5);
    expect(new Set(truth.roster.map((s) => s.cadence)).size).toBe(3);
    const identical = truth.rows.filter((r) => r.trap === "same-day-identical");
    expect(identical).toHaveLength(2);
    expect({ ...identical[0], balanceCents: 0 }).toEqual({ ...identical[1], balanceCents: 0 });
  });

  it("rolls up months consistently with the rows (transfers excluded)", () => {
    const { truth } = generateFakeBmo({ months: 6, endMonth: "2026-03", seed: 3 });
    expect(truth.months.map((m) => m.month)).toEqual(["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
    for (const m of truth.months) {
      expect(m.netCents).toBe(m.incomeCents - m.expenseCents);
      const rent = Object.values(m.boothRentByStylist).reduce((a, b) => a + b, 0);
      expect(rent).toBeLessThanOrEqual(m.incomeCents);
    }
    const transfers = truth.rows.filter((r) => r.category.startsWith("Owner"));
    const nonTransfer = truth.rows.filter((r) => !r.category.startsWith("Owner") && !r.category.startsWith("Transfer"));
    expect(transfers.length).toBeGreaterThan(0);
    const net = truth.months.reduce((a, m) => a + m.netCents, 0);
    expect(net).toBe(nonTransfer.reduce((a, r) => a + r.amountCents, 0));
  });

  it("handles tiny windows", () => {
    const { csv, truth } = generateFakeBmo({ months: 1, endMonth: "2026-02" });
    expect(parseBankCsv(csv).errors).toEqual([]);
    expect(truth.rows.every((r) => r.date >= "2026-02-01" && r.date <= "2026-02-28")).toBe(true);
  });

  describe.each(combos.map((c) => [label(c), c] as const))("%s", (_name, opts) => {
    const { csv, truth } = generateFakeBmo(opts);

    it("parses with an auto-detected mapping: every row, zero errors, same total", () => {
      const r = parseBankCsv(csv);
      expect(r.errors).toEqual([]);
      expect(r.mapping?.amountMode).toBe(opts.format);
      expect(r.mapping?.memoColumn).toBe(opts.zelleSender === "memo" ? "Memo" : undefined);
      expect(r.rows).toHaveLength(truth.rows.length);
      const sum = (xs: { amountCents: number }[]) => xs.reduce((a, x) => a + x.amountCents, 0);
      expect(sum(r.rows)).toBe(sum(truth.rows));
      r.rows.forEach((row, i) => {
        expect(row.date).toBe(truth.rows[i].date);
        expect(row.amountCents).toBe(truth.rows[i].amountCents);
      });
    });

    it("has unique dedupe hashes", () => {
      const hashes = parseBankCsv(csv).rows.map((r) => r.dedupeHash);
      expect(new Set(hashes).size).toBe(hashes.length);
    });

    it("has a running balance consistent with the rows and the opening balance", () => {
      const headerAt = csv.split("\r\n").findIndex((l) => /^(Posted Date|Date),/.test(l));
      const body = csv.split("\r\n").slice(headerAt).join("\n");
      const parsed = Papa.parse<Record<string, string>>(body, { header: true, skipEmptyLines: "greedy" });
      expect(parsed.errors).toEqual([]);
      const rows = parsed.data.map((rec) => {
        const amount =
          opts.format === "single"
            ? parseAmountToCents(rec["Amount"])!
            : (parseAmountToCents(rec["Deposits"] || "0") ?? 0) - (parseAmountToCents(rec["Withdrawals"] || "0") ?? 0);
        return { amount, balance: parseAmountToCents(rec["Balance"])! };
      });
      const chrono = opts.order === "newest" ? [...rows].reverse() : rows;
      let bal = truth.openingBalance.cents;
      for (const r of chrono) {
        bal += r.amount;
        expect(r.balance).toBe(bal);
      }
      expect(truth.openingBalance.asOf).toBe("2025-10-01");
    });

    it("keeps the Zelle sender where asked", () => {
      const zelle = truth.rows.filter((r) => r.description.startsWith("ZELLE PAYMENT") && r.amountCents > 0);
      expect(zelle.length).toBeGreaterThan(0);
      for (const z of zelle) {
        if (opts.zelleSender === "memo") {
          expect(z.description).toBe("ZELLE PAYMENT RECEIVED");
          expect(z.memo).toMatch(/^FROM [A-Z ]+$/);
        } else {
          expect(z.description).toMatch(/^ZELLE PAYMENT FROM [A-Z ]+$/);
          expect(z.memo).toBe("");
        }
      }
    });
  });

  it("quotes descriptions that contain commas", () => {
    const { csv } = generateFakeBmo({ months: 12, endMonth: "2026-09", seed: 42 });
    expect(csv).toContain('"ACH DEBIT SALLY BEAUTY SUPPLY, LLC ONLINE ORDER"');
  });
});
