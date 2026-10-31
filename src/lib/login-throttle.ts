/** Pure decisions for login rate limiting. DB access lives in login-attempts.ts. */
/** Failures from one IP in the window before it's blocked: stops a single guesser quickly. */
export const MAX_IP_FAILURES = 5;
/**
 * Failures against one email (from any IP). Higher than the IP limit so a stranger who knows the
 * address can't lock its owner out with a handful of bad guesses, while still capping
 * distributed guessing.
 */
export const MAX_EMAIL_FAILURES = 20;
export const WINDOW_MINUTES = 15;
export const RETENTION_DAYS = 1;
export const THROTTLE_MESSAGE = "Too many attempts. Try again in a few minutes.";

export function isThrottled(counts: { emailFailures: number; ipFailures: number }): boolean {
  return counts.emailFailures >= MAX_EMAIL_FAILURES || counts.ipFailures >= MAX_IP_FAILURES;
}

/** First entry of an x-forwarded-for header, else "unknown". */
export function clientIp(xForwardedFor: string | null | undefined): string {
  const first = xForwardedFor?.split(",")[0]?.trim();
  return first ? first.slice(0, 64) : "unknown";
}
