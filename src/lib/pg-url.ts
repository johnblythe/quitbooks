/**
 * node-postgres treats sslmode=require/prefer/verify-ca as verify-full today, warns on every
 * connect, and says v9 will weaken them to libpq semantics (no certificate check). Neon's
 * certificates verify fine, so pin verify-full: same security now, and it survives the upgrade.
 */
export function withVerifyFull(url: string): string {
  return url.replace(/([?&])sslmode=(?:require|prefer|verify-ca)(?=&|$)/, "$1sslmode=verify-full");
}
