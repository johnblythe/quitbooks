/** Size limits shared by the import form (client) and the import actions (server). No dependencies. */

/** Server-side cap on CSV size, measured in bytes. Next's action body limit is 4 MB (next.config.ts). */
export const MAX_CSV_BYTES = 3.5 * 1024 * 1024;
export const TOO_BIG_MESSAGE = "File is too big; export a shorter date range.";

export function csvByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
