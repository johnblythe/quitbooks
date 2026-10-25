import { describe, expect, it } from "vitest";
import { bankAttention, reconcile } from "./bank-status";

const now = new Date("2026-10-24T12:00:00Z");
const day = 86_400_000;
const base = {
  lastSyncedAt: new Date(now.getTime() - day),
  lastError: null,
  lastWarning: null,
  createdAt: new Date(now.getTime() - 30 * day),
  active: true,
};

describe("bankAttention", () => {
  it("is healthy after a recent sync", () => expect(bankAttention(base, now)).toBeNull());
  it("surfaces last_error", () =>
    expect(bankAttention({ ...base, lastError: "con.auth: expired" }, now)).toEqual({ tone: "bad", message: "con.auth: expired" }));
  it("flags a sync older than 3 days", () =>
    expect(bankAttention({ ...base, lastSyncedAt: new Date(now.getTime() - 4 * day) }, now)?.message).toMatch(/3 days/));
  it("flags never-synced old connections but not brand new ones", () => {
    expect(bankAttention({ ...base, lastSyncedAt: null }, now)).toMatchObject({ tone: "bad", message: expect.stringMatching(/never/i) });
    expect(bankAttention({ ...base, lastSyncedAt: null, createdAt: new Date(now.getTime() - day) }, now)).toBeNull();
  });
  it("ignores connections with no account chosen yet", () => expect(bankAttention({ ...base, lastError: "x", active: false }, now)).toBeNull());
  it("shows a warning without going red, and an error or staleness wins over it", () => {
    expect(bankAttention({ ...base, lastWarning: "con.auth: Chase" }, now)).toEqual({ tone: "warn", message: "con.auth: Chase" });
    expect(bankAttention({ ...base, lastWarning: "w", lastError: "e" }, now)).toEqual({ tone: "bad", message: "e" });
    expect(bankAttention({ ...base, lastWarning: "w", lastSyncedAt: new Date(now.getTime() - 4 * day) }, now)?.tone).toBe("bad");
  });
});

describe("reconcile", () => {
  it("matches when equal", () => expect(reconcile(100, 100).kind).toBe("match"));
  it("reports books minus bank", () => expect(reconcile(100_00, 90_00)).toMatchObject({ kind: "off", diffCents: -10_00 }));
});
