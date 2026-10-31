/**
 * AES-256-GCM for the SimpleFIN Access URL (it contains Basic-auth credentials, i.e. read access to
 * the bank feed). Key: env BANK_TOKEN_KEY = base64 of 32 random bytes (`openssl rand -base64 32`).
 * Stored format: "v1.<iv b64>.<tag b64>.<ciphertext b64>". Never log the plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_VAR = "BANK_TOKEN_KEY";

export function loadBankKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env[KEY_VAR];
  if (!raw) {
    throw new Error(`${KEY_VAR} is not set. Generate one with \`openssl rand -base64 32\` and set it in the environment.`);
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(`${KEY_VAR} must be base64 of exactly 32 bytes (got ${key.length}).`);
  }
  return key;
}

export function encryptSecret(plain: string, key: Buffer = loadBankKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

/** Throws a generic error on a wrong key, tampering or a malformed value (never echoes the input). */
export function decryptSecret(stored: string, key: Buffer = loadBankKey()): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Stored bank credential is malformed.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Could not decrypt the stored bank credential (wrong BANK_TOKEN_KEY or corrupted data).");
  }
}
