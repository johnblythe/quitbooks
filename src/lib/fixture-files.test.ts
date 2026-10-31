import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBankCsv } from "./csv";
import type { FakeTruth } from "./fake-bmo";

describe("committed reusable BMO fixtures", () => {
  for (const format of ["single", "split"]) {
    it(`${format} CSV preserves every answer-key date and amount`, () => {
      const path = `fixtures/bmo-fake-12mo-${format}`;
      const truth = JSON.parse(readFileSync(`${path}.truth.json`, "utf8")) as FakeTruth;
      const parsed = parseBankCsv(readFileSync(`${path}.csv`, "utf8"));
      expect(parsed.errors).toEqual([]);
      expect(parsed.rows).toHaveLength(439);
      expect(parsed.rows.map(({ date, amountCents }) => ({ date, amountCents }))).toEqual(
        truth.rows.map(({ date, amountCents }) => ({ date, amountCents })),
      );
      expect(truth.roster.length).toBeGreaterThan(0);
      expect(truth.openingBalance.cents).toBeGreaterThan(0);
    });
  }
});
