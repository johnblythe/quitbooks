import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, loadBankKey } from "./bank-crypto";

const key = randomBytes(32);
const url = "https://user:pass@beta-bridge.simplefin.org/simplefin";

describe("bank-crypto", () => {
  it("round-trips", () => {
    const enc = encryptSecret(url, key);
    expect(enc).not.toContain("pass");
    expect(decryptSecret(enc, key)).toBe(url);
  });
  it("uses a fresh IV each time", () => expect(encryptSecret(url, key)).not.toBe(encryptSecret(url, key)));
  it("detects tampering in each part", () => {
    const parts = encryptSecret(url, key).split(".");
    for (const i of [1, 2, 3]) {
      const bad = [...parts];
      const buf = Buffer.from(bad[i], "base64");
      buf[0] ^= 1;
      bad[i] = buf.toString("base64");
      expect(() => decryptSecret(bad.join("."), key)).toThrow(/decrypt/);
    }
  });
  it("rejects the wrong key and malformed input without echoing it", () => {
    const enc = encryptSecret(url, key);
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow(/decrypt/);
    expect(() => decryptSecret("garbage", key)).toThrow(/malformed/);
  });
  it("names the variable, never its value, when the key is missing or bad", () => {
    expect(() => loadBankKey({})).toThrow(/BANK_TOKEN_KEY is not set/);
    const secretish = Buffer.from("short").toString("base64");
    try {
      loadBankKey({ BANK_TOKEN_KEY: secretish });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/BANK_TOKEN_KEY must be base64 of exactly 32 bytes/);
      expect((e as Error).message).not.toContain(secretish);
    }
    expect(loadBankKey({ BANK_TOKEN_KEY: key.toString("base64") })).toHaveLength(32);
  });
});
