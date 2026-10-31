/**
 * Writes a fabricated BMO CSV export plus a truth file.
 * Usage: npm run fake:bmo -- [--months 12] [--end YYYY-MM] [--seed 42] [--format single|split]
 *          [--preamble | --no-preamble] [--zelle-sender description|memo] [--order newest|oldest] [--out path]
 * Writes <out>.csv and <out>.truth.json (default out: fixtures/bmo-fake-<N>mo-<format>).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { addMonths, todayIso } from "../src/lib/dates";
import { DEFAULT_FAKE_OPTIONS, generateFakeBmo, type FakeBmoOptions } from "../src/lib/fake-bmo";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) fail(`Unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "preamble" || key === "no-preamble") flags.set(key, "true");
    else {
      const v = args[++i];
      if (v === undefined) fail(`Missing value for ${a}`);
      flags.set(key, v);
    }
  }
  const oneOf = <T extends string>(key: string, allowed: readonly T[], dflt: T): T => {
    const v = flags.get(key);
    if (v === undefined) return dflt;
    if (!allowed.includes(v as T)) fail(`--${key} must be one of: ${allowed.join(", ")}`);
    return v as T;
  };
  const num = (key: string, dflt: number) => {
    const v = flags.get(key);
    if (v === undefined) return dflt;
    if (!/^\d+$/.test(v)) fail(`--${key} must be a whole number`);
    return Number(v);
  };

  const lastCompleteMonth = addMonths(todayIso().slice(0, 7), -1);
  const opts: FakeBmoOptions = {
    months: num("months", DEFAULT_FAKE_OPTIONS.months),
    endMonth: flags.get("end") ?? lastCompleteMonth,
    seed: num("seed", DEFAULT_FAKE_OPTIONS.seed),
    format: oneOf("format", ["single", "split"], DEFAULT_FAKE_OPTIONS.format),
    preamble: flags.has("no-preamble") ? false : flags.has("preamble") ? true : DEFAULT_FAKE_OPTIONS.preamble,
    zelleSender: oneOf("zelle-sender", ["description", "memo"], DEFAULT_FAKE_OPTIONS.zelleSender),
    order: oneOf("order", ["newest", "oldest"], DEFAULT_FAKE_OPTIONS.order),
  };
  if (flags.has("preamble") && flags.has("no-preamble")) fail("Pass only one of --preamble / --no-preamble");

  const { csv, truth } = generateFakeBmo(opts);
  const out = flags.get("out") ?? `fixtures/bmo-fake-${opts.months}mo-${opts.format}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.csv`, csv);
  writeFileSync(`${out}.truth.json`, JSON.stringify(truth, null, 2) + "\n");
  console.log(`Wrote ${out}.csv (${truth.rows.length} rows) and ${out}.truth.json`);
}

main();
