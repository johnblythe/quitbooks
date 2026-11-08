/**
 * compareBooks checks, for every month, that each side's income − expenses + Inbox equals its net
 * (checkMonthAddsUp, unit-tested in qbo-compare.test.ts). Normal input can't break that, so this file
 * makes our P&L's net disagree with its own lines and checks that compareBooks refuses to go on.
 */
import { describe, expect, it, vi } from "vitest";
import { expandLedgerLines } from "./ledger";
import { compareBooks, type OurCategory, type OurTx } from "./qbo-compare";
import { parseQboPnl } from "./qbo-pnl";

const skew = vi.hoisted(() => ({ netCents: 0 }));
vi.mock("./metrics", async (importOriginal) => {
  const real = await importOriginal<typeof import("./metrics")>();
  const computePnl = (...args: Parameters<typeof real.computePnl>) => {
    const p = real.computePnl(...args);
    return { ...p, net: p.net + skew.netCents };
  };
  return { ...real, computePnl };
});

const cats: OurCategory[] = [{ id: "c-rent", name: "Booth Rent", kind: "income", archived: false }];
const pnl = parseQboPnl([",Jan 2026,Total", "Income", "Booth Rent,100.00,100.00", "Total Income,100.00,100.00", "Net Income,100.00,100.00", "", "Cash Basis"].join("\n"));
const rent: OurTx = { id: "t1", date: "2026-01-05", amountCents: 10000, categoryId: "c-rent", stylistId: null, isSplit: false, description: "rent", source: "csv" };

describe("compareBooks refuses a month whose buckets don't add up to its net", () => {
  it("matches when they do", () => {
    skew.netCents = 0;
    expect(compareBooks({ pnl, categories: cats, lines: expandLedgerLines([rent], []) }).match).toBe(true);
  });

  it("throws instead of comparing when our P&L's net disagrees with its own lines", () => {
    skew.netCents = 1;
    expect(() => compareBooks({ pnl, categories: cats, lines: expandLedgerLines([rent], []) })).toThrow(/qbo:compare bug: Jan 2026: our side doesn't add up/);
    skew.netCents = 0;
  });
});
