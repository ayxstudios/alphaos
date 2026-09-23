import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison for machine callers (cron, Alpha). A plain
 * `===` returns as soon as a character differs, which leaks how much of a
 * guess was right through response timing. Both sides are hashed first so the
 * buffers always have the same length (timingSafeEqual requires it) and the
 * secret's length is not revealed either.
 */
export function secretsMatch(given: string | null | undefined, secret: string): boolean {
  if (typeof given !== "string" || !given || !secret) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
