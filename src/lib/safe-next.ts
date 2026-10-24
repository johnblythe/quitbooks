/**
 * Post-login redirect target. Accepts only same-origin paths; anything else becomes "/".
 * Parsing with the WHATWG URL parser means we judge the URL the way the browser will:
 * `/\evil.example` and `/<TAB>/evil.example` both resolve to a foreign origin there.
 */
const BASE = "http://x";

export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/")) return "/";
  // No legitimate app path contains control characters or backslashes.
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  try {
    const u = new URL(next, BASE);
    if (u.origin !== BASE) return "/";
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}
