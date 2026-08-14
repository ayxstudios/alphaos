import { and, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { emailSenderIgnores } from "@/lib/db/schema";

export function parseEmailAddress(address: string | null): string | null {
  if (!address) return null;
  const m = address.match(/<([^>]+)>/);
  const raw = (m ? m[1] : address).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

export function builtInSuppressionReason(address: string | null): string | null {
  const parsed = parseEmailAddress(address);
  if (!parsed) return null;
  const local = parsed.split("@")[0] ?? "";
  if (/^(no-?reply|do-?not-?reply|donotreply|notifications?)$/i.test(local)) {
    return "Built-in no-reply sender";
  }
  if (local.includes("no-reply") || local.includes("noreply") || local.includes("do-not-reply")) {
    return "Built-in no-reply sender";
  }
  return null;
}

export function ignoreMatchesAddress(
  ignore: { value: string; matchType: string },
  address: string | null,
): boolean {
  const parsed = parseEmailAddress(address);
  if (!parsed) return false;
  const value = ignore.value.trim().toLowerCase();
  if (!value) return false;
  if (ignore.matchType === "domain") return parsed.endsWith(`@${value.replace(/^@/, "")}`);
  if (ignore.matchType === "contains") return parsed.includes(value);
  return parsed === value;
}

export async function resolveSuppressionReason(
  tx: Tx,
  businessId: string,
  address: string | null,
): Promise<string | null> {
  const builtIn = builtInSuppressionReason(address);
  if (builtIn) return builtIn;
  const ignores = await tx
    .select({ value: emailSenderIgnores.value, matchType: emailSenderIgnores.matchType })
    .from(emailSenderIgnores)
    .where(and(eq(emailSenderIgnores.businessId, businessId), eq(emailSenderIgnores.active, true)));
  for (const ignore of ignores) {
    if (!ignoreMatchesAddress(ignore, address)) continue;
    const value = ignore.value.trim().toLowerCase();
    if (ignore.matchType === "domain") return `Ignored sender domain: ${value}`;
    if (ignore.matchType === "contains") return `Ignored sender match: ${value}`;
    return `Ignored sender: ${value}`;
  }
  return null;
}
