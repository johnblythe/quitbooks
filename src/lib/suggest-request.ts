import { z } from "zod";
import { INBOX_LIMIT } from "./inbox";

/** Body of POST /api/inbox/suggest: a few Inbox groups per request. Single source of truth. */
export const suggestGroupsInput = z
  .array(z.object({ key: z.string().min(1).max(200), ids: z.array(z.uuid()).min(1).max(INBOX_LIMIT) }))
  .min(1)
  .max(12);

/**
 * Defense in depth on top of the SameSite cookie: if the browser sent an Origin header, its host
 * must equal the request host. No Origin header (same-origin GET-style fetches, tools) is allowed.
 */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (origin === null) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
