import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEY_LEN = 64;
const SALT_LEN = 16;
/** 128 * N * r = 128 MiB at N=2^17, r=8; leave headroom. */
const MAXMEM = 256 * 1024 * 1024;

export type ScryptParams = { N: number; r: number; p: number };
export const DEFAULT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
/** What `scrypt$salt$hash` (the original format) used implicitly: Node's defaults. */
const LEGACY_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

function scrypt(password: string, salt: Buffer, len: number, params: ScryptParams): Promise<Buffer> {
  const opts: ScryptOptions = { ...params, maxmem: MAXMEM };
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/**
 * Hash format: scrypt$N$r$p$<salt hex>$<hash hex>
 * `params` is for tests (smaller N keeps them fast); production always uses the default.
 */
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scrypt(password, salt, KEY_LEN, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

const HEX = /^[0-9a-f]+$/i;
const isPow2 = (n: number) => Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;

/** Returns null for anything malformed. Accepts the new and the legacy format. */
function parseStored(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split("$");
  let params = LEGACY_PARAMS;
  let saltHex: string | undefined;
  let hashHex: string | undefined;

  if (parts[0] !== "scrypt") return null;
  if (parts.length === 3) {
    [, saltHex, hashHex] = parts;
  } else if (parts.length === 6) {
    const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    // Bound the cost so a corrupted row can't request unbounded memory.
    if (!isPow2(N) || N > 2 ** 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
      return null;
    }
    params = { N, r, p };
    [, , , , saltHex, hashHex] = parts;
  } else {
    return null;
  }

  if (!saltHex || !hashHex || !HEX.test(saltHex) || !HEX.test(hashHex)) return null;
  if (saltHex.length % 2 || hashHex.length % 2) return null;
  const hash = Buffer.from(hashHex, "hex");
  if (hash.length !== KEY_LEN) return null;
  return { params, salt: Buffer.from(saltHex, "hex"), hash };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  try {
    const actual = await scrypt(password, parsed.salt, KEY_LEN, parsed.params);
    return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * A valid-looking hash of a random throwaway password at the production cost. Verifying against it
 * when the email is unknown makes "no such user" cost the same as "wrong password".
 */
export const DUMMY_HASH =
  "scrypt$131072$8$1$982651e80a94aea011416c01e93b35a6$d2c15cd91351405297ac43a99cce3e232fc7217192e0102a3c400b8a4ba9bef4ca114bf059218ca73fd32c9fd8fa5bc4afb1daa032f12e31828f7b70bcb75c3a";
