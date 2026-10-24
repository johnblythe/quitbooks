/** Pure decisions for login rate limiting. DB access lives in login-attempts.ts. */
export const MAX_FAILURES = 5;
export const WINDOW_MINUTES = 15;
export const RETENTION_DAYS = 1;
export const THROTTLE_MESSAGE = "Too many attempts. Try again in a few minutes.";

export function isThrottled(
  counts: { emailFailures: number; ipFailures: number },
  max: number = MAX_FAILURES,
): boolean {
  return counts.emailFailures >= max || counts.ipFailures >= max;
}

/** First entry of an x-forwarded-for header, else "unknown". */
export function clientIp(xForwardedFor: string | null | undefined): string {
  const first = xForwardedFor?.split(",")[0]?.trim();
  return first ? first.slice(0, 64) : "unknown";
}
