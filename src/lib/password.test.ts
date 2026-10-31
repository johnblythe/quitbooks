import { describe, expect, it } from "vitest";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./password";

const FAST = { N: 1024, r: 8, p: 1 };

describe("password hashing", () => {
  it("round-trips in the new format with recorded parameters", async () => {
    const stored = await hashPassword("correct horse battery", FAST);
    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("defaults to N=2^17", async () => {
    const stored = await hashPassword("pw-for-default-cost");
    expect(stored.startsWith("scrypt$131072$8$1$")).toBe(true);
    expect(await verifyPassword("pw-for-default-cost", stored)).toBe(true);
  });

  it("still verifies the legacy scrypt$salt$hash format", async () => {
    const { scryptSync } = await import("node:crypto");
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const hash = scryptSync("legacy password", salt, 64); // Node defaults, as before
    const stored = `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
    expect(await verifyPassword("legacy password", stored)).toBe(true);
    expect(await verifyPassword("nope", stored)).toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("anything", "scrypt$ab$zz")).toBe(false);
    expect(await verifyPassword("", "scrypt$ab$zz")).toBe(false);
    expect(await verifyPassword("x", "scrypt$$")).toBe(false);
    expect(await verifyPassword("x", "scrypt$00$" + "ab".repeat(10))).toBe(false); // short hash
    expect(await verifyPassword("x", "scrypt$zz$" + "ab".repeat(64))).toBe(false); // non-hex salt
    expect(await verifyPassword("x", "scrypt$1024$8$1$$" + "ab".repeat(64))).toBe(false); // empty salt
    expect(await verifyPassword("x", "scrypt$1000$8$1$00$" + "ab".repeat(64))).toBe(false); // N not pow2
    expect(await verifyPassword("x", "bcrypt$00$" + "ab".repeat(64))).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });

  it("DUMMY_HASH is well-formed at production cost and matches nothing guessable", async () => {
    expect(DUMMY_HASH.startsWith("scrypt$131072$8$1$")).toBe(true);
    expect(await verifyPassword("password", DUMMY_HASH)).toBe(false);
  });
});
