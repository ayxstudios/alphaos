import type { NextRequest } from "next/server";

import { secretsMatch } from "@/lib/secret-compare";

/** Machine caller (the Alpha daemon) proves itself with ALPHA_HOOK_SECRET. Fails closed. */
export function isAlphaCaller(req: NextRequest): boolean {
  const secret = process.env.ALPHA_HOOK_SECRET;
  if (!secret) return false;
  const given = req.headers.get("x-alpha-secret") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return secretsMatch(given, secret);
}
