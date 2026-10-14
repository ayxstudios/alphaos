/**
 * AI portraits go through the owners' QC, with Auto QC first (Yousif
 * 2026-10-14, Perfetta Minimal Storybook 4197908493: "When you make the
 * watercolor minimal storybook portraits for perfetta, make sure you still put
 * it through the AlphaOS qc. And through that it should also go through autoQc
 * check."). Both revisions of that order were passed minutes after the AI
 * delivered them (once on the shared VA login, once by the agent pressing
 * Approve itself), so the owner only saw WhatsApp pictures and Auto QC never
 * judged the second file.
 *
 * An order the AI Studio drew (its active assignment is the agent designer)
 * may only leave Awaiting QC when
 *   1. an owner passes it on AlphaOS (admin role; never the VA login, a script,
 *      the system or the agent itself), and
 *   2. Auto QC has judged the exact file going to the customer: an Auto QC row
 *      on that upload, or for a "Send AI fix" file the judged fix it came from.
 * Orders drawn by people are unchanged. docs/AUTO_QC.md.
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { isAgentAssigned } from "@/lib/agent/ai-core";
import { assets, autoQcChecks, autoQcFixes } from "@/lib/db/schema";

export type AiQcRefusal = { code: "ai_owner_qc" | "ai_auto_qc_pending"; message: string };

export const AI_OWNER_QC_MESSAGE = "AI portraits are approved by an owner on Approve, once Auto QC has checked them.";
export const AI_AUTO_QC_PENDING_MESSAGE =
  "Auto QC is still checking this AI portrait. Approve opens once it's done, usually within 10 minutes.";

/** True when Auto QC has judged this upload, or the AI fix it was made from. */
export async function autoQcJudged(tx: Tx, orderId: string, assetId: string): Promise<boolean> {
  const [check] = await tx
    .select({ id: autoQcChecks.id })
    .from(autoQcChecks)
    .where(and(eq(autoQcChecks.orderId, orderId), sql`${autoQcChecks.assetIds} @> ${JSON.stringify([assetId])}::jsonb`))
    .limit(1);
  if (check) return true;
  const [fix] = await tx
    .select({ id: autoQcFixes.id })
    .from(autoQcFixes)
    .where(and(eq(autoQcFixes.orderId, orderId), eq(autoQcFixes.usedAssetId, assetId), isNotNull(autoQcFixes.qcVerdict)))
    .limit(1);
  return !!fix;
}

async function newestArtworkId(tx: Tx, orderId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.orderId, orderId), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
    .orderBy(desc(assets.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Null when this QC pass may go ahead, else why not. `assetId` = the file the
 * proof carries (default: the newest upload); `fixIds` = "Send AI fix", whose
 * fixes each need their own Auto QC verdict.
 */
export async function aiQcRefusal(
  tx: Tx,
  actor: { role: string },
  input: { orderId: string; assetId?: string | null; fixIds?: string[] },
): Promise<AiQcRefusal | null> {
  if (!(await isAgentAssigned(tx, input.orderId))) return null;
  if (actor.role !== "admin") return { code: "ai_owner_qc", message: AI_OWNER_QC_MESSAGE };
  const pending = { code: "ai_auto_qc_pending" as const, message: AI_AUTO_QC_PENDING_MESSAGE };
  if (input.fixIds?.length) {
    const ids = [...new Set(input.fixIds)];
    const judged = await tx
      .select({ id: autoQcFixes.id })
      .from(autoQcFixes)
      .where(and(eq(autoQcFixes.orderId, input.orderId), inArray(autoQcFixes.id, ids), isNotNull(autoQcFixes.qcVerdict)));
    return judged.length === ids.length ? null : pending;
  }
  const assetId = input.assetId ?? (await newestArtworkId(tx, input.orderId));
  if (!assetId) return null; // nothing uploaded: the caller's own checks refuse that
  return (await autoQcJudged(tx, input.orderId, assetId)) ? null : pending;
}

/** For the Approve screen: true while an AI portrait still waits for its Auto QC. */
export async function aiAwaitingAutoQc(tx: Tx, orderId: string): Promise<boolean> {
  if (!(await isAgentAssigned(tx, orderId))) return false;
  const assetId = await newestArtworkId(tx, orderId);
  return !!assetId && !(await autoQcJudged(tx, orderId, assetId));
}
