"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import {
  approveProof,
  requestRevision,
  type ProofActionResult,
  type RevisionInput,
} from "@/lib/proofs/decide";
import { recordProofView } from "@/lib/proofs/data";
import { checkRateLimit, clientIp } from "@/lib/proofs/rate-limit";

/**
 * Rate-limit guard shared by the public proof actions. Limits by BOTH the client
 * IP and the token, so a single link can't be hammered and a single host can't
 * sweep many links.
 */
async function guard(
  action: string,
  token: string,
  limit: number,
  windowSec: number,
): Promise<ProofActionResult | null> {
  const ip = clientIp(await headers());
  const [byIp, byToken] = await Promise.all([
    checkRateLimit(`proof:${action}:ip:${ip}`, limit, windowSec),
    checkRateLimit(`proof:${action}:tok:${token}`, limit, windowSec),
  ]);
  if (!byIp.ok || !byToken.ok) {
    return {
      ok: false,
      code: "invalid",
      message: "Too many attempts. Please wait a moment and try again.",
    };
  }
  return null;
}

/** Log a customer view. Fire-and-forget from the client on page load. */
export async function trackView(token: string): Promise<void> {
  // Lightly throttled so a refresh loop can't spam view rows.
  const blocked = await guard("view", token, 30, 60);
  if (blocked) return;
  await recordProofView(token);
}

export async function approveAction(token: string): Promise<ProofActionResult> {
  const blocked = await guard("decide", token, 20, 60);
  if (blocked) return blocked;

  const result = await approveProof(token);
  if (result.ok) revalidatePath(`/proof/${token}`);
  return result;
}

export async function revisionAction(
  token: string,
  input: RevisionInput,
): Promise<ProofActionResult> {
  const blocked = await guard("decide", token, 20, 60);
  if (blocked) return blocked;

  const result = await requestRevision(token, input);
  if (result.ok) revalidatePath(`/proof/${token}`);
  return result;
}
