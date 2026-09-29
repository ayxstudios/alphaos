// The small, dependency-light half of the AI designer: finding the business's
// "AI Studio" agent designer, asking whether an order is held by it, queueing
// an order for it, and recording a revision. Kept free of the transition
// machine so lib/orders/assign.ts and lib/orders/transitions.ts can import it
// without a cycle. The jobs, deliver, owner-review and reassign logic lives in
// ./ai-designer.ts.
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import {
  activityLog,
  assignments,
  designerBusinesses,
  designerProfiles,
  orders,
  styles,
  users,
} from "@/lib/db/schema";

export const AI_STUDIO_NAME = "AI Studio";
/** Shown on the order as its stage while the agent redraws it. */
export const AI_REVISION_STAGE = "in revision (AI)";

export type AiState = "queued" | "claimed" | "revision" | "revision_claimed" | "qc" | "owner_review" | "with_buyer" | "failed";

function agentEmail(businessId: string): string {
  return `ai-studio+${businessId}@agent.invalid`;
}

/** The business's agent designer id, or null when none exists yet. */
export async function getAgentDesignerId(tx: Tx, businessId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: designerProfiles.userId })
    .from(designerProfiles)
    .innerJoin(designerBusinesses, eq(designerBusinesses.userId, designerProfiles.userId))
    .where(and(eq(designerProfiles.isAgent, true), eq(designerBusinesses.businessId, businessId)))
    .limit(1);
  return row?.id ?? null;
}

/** The agent designer for a business, created when missing (idempotent). */
export async function ensureAgentDesigner(tx: Tx, businessId: string): Promise<string> {
  const existing = await getAgentDesignerId(tx, businessId);
  if (existing) return existing;
  const email = agentEmail(businessId);
  await tx.insert(users).values({ name: AI_STUDIO_NAME, email, role: "designer", active: true }).onConflictDoNothing();
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  await tx
    .insert(designerProfiles)
    .values({ userId: user.id, isAgent: true, dailyCapacity: 0, maxActiveOrders: 0 })
    .onConflictDoUpdate({ target: designerProfiles.userId, set: { isAgent: true } });
  await tx.insert(designerBusinesses).values({ userId: user.id, businessId }).onConflictDoNothing();
  return user.id;
}

/** True when the order's active assignment is the agent designer. */
export async function isAgentAssigned(tx: Tx, orderId: string): Promise<boolean> {
  const [row] = await tx
    .select({ isAgent: designerProfiles.isAgent })
    .from(assignments)
    .innerJoin(designerProfiles, eq(designerProfiles.userId, assignments.designerId))
    .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)))
    .limit(1);
  return !!row?.isAgent;
}

/** The style row for an item's style name, when the business has one. */
export async function findStyle(tx: Tx, businessId: string, styleName: string | null) {
  const name = styleName?.trim().toLowerCase();
  if (!name) return null;
  const [row] = await tx
    .select({
      id: styles.id,
      name: styles.name,
      aiDesignerEnabled: styles.aiDesignerEnabled,
      aiFramework: styles.aiFramework,
    })
    .from(styles)
    .where(and(eq(styles.businessId, businessId), sql`lower(${styles.name}) = ${name}`))
    .limit(1);
  return row ?? null;
}

/** Mark an order queued for the agent and log it. The assignment row is made by createAssignment. */
export async function markQueuedForAgent(
  tx: Tx,
  input: { orderId: string; businessId: string; byUserId: string | null; via: string },
): Promise<void> {
  await tx.update(orders).set({ aiState: "queued", aiClaimedAt: null }).where(eq(orders.id, input.orderId));
  await tx.insert(activityLog).values({
    businessId: input.businessId,
    orderId: input.orderId,
    actorId: input.byUserId,
    action: "ai.queued",
    metadata: { via: input.via },
  });
}

/**
 * Called by runTransition on every revision edge (QC fail or buyer revision).
 * When the agent holds the order it goes back to the jobs queue as a revision
 * job, never to a human board, and the stage reads "in revision (AI)".
 */
export async function onRevisionEdge(
  tx: Tx,
  input: { orderId: string; businessId: string; from: string; revisionCount: number },
): Promise<boolean> {
  if (!(await isAgentAssigned(tx, input.orderId))) return false;
  await tx.update(orders).set({ aiState: "revision", aiClaimedAt: null }).where(eq(orders.id, input.orderId));
  await tx.insert(activityLog).values({
    businessId: input.businessId,
    orderId: input.orderId,
    actorId: null,
    action: "ai.revision_queued",
    fromState: input.from as never,
    toState: "in_design",
    metadata: {
      stage: AI_REVISION_STAGE,
      revision: input.revisionCount,
      source: input.from === "awaiting_qc" ? "qc" : "buyer",
    },
  });
  return true;
}
