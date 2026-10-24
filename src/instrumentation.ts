/** Runs once at server start. Logs misconfiguration by variable name only, never values. */
export function register() {
  const problems: string[] = [];
  const secret = process.env.SESSION_SECRET;
  if (!secret) problems.push("SESSION_SECRET is not set");
  else if (secret.length < 32) problems.push("SESSION_SECRET is too short (need at least 32 characters)");
  if (!process.env.DATABASE_URL) problems.push("DATABASE_URL is not set");

  if (problems.length) {
    console.error(
      `[quitbooks] Misconfigured environment: ${problems.join("; ")}. ` +
        "Logins and data access will fail until this is fixed (see .env.example).",
    );
  }
}
