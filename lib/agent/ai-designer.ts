// AI designer backend: the jobs an outside agent draws (list, claim, deliver,
// fail), the owner-review hold before an AI portrait reaches the buyer, and the
// one reassignOrder that works for any order. Docs: docs/agent-designer.md.
//
// A job is an order whose ACTIVE assignment is the business's is_agent
// designer and whose ai_state is queued (new) or revision. The job id is the
// order id. Every status change goes through runTransition, never a direct
// write, so QC, activity and the proof flow behave exactly as for a human.
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { withSystemContext, SYSTEM_ACTOR_ID, type Tx } from "@/lib/db";
import {
  activityLog,
  assets,
  assignments,
  businesses,
  designerBusinesses,
  designerProfiles,
  messages,
  orderItems,
  orders,
  proofs,
  users,
} from "@/lib/db/schema";
import { getAgentConfig } from "@/lib/agent/config";
import { openExceptionTx } from "@/lib/agent/exceptions";
import { sendMessage } from "@/lib/email/dispatch";
import { createAssignment } from "@/lib/orders/assign";
import { runTransition, type OrderStatus } from "@/lib/orders/transitions";
import { assetKey, extFor, isR2Configured, presignGet, presignUpload } from "@/lib/storage/r2";
import { DEV_STORE_PREFIX, writeDevStoreObject } from "@/lib/uploads/store";
import { appUrl } from "@/lib/urls";
import {
  AI_REVISION_STAGE,
  getAgentDesignerId,
  isAgentAssigned,
  markQueuedForAgent,
} from "./ai-core";

export { AI_REVISION_STAGE, ensureAgentDesigner, getAgentDesignerId, isAgentAssigned } from "./ai-core";

const SYSTEM_ACTOR = { id: SYSTEM_ACTOR_ID, role: "system" as const };
const MAX_DELIVER_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPE = /^image\/(jpeg|png|webp|gif)$/i;

export class AiJobError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "AiJobError";
  }
}

/* ------------------------------------------------------------------ jobs */

export type AiJob = {
  jobId: string;
  kind: "new" | "revision";
  orderId: string;
  orderNumber: string;
  business: { id: string; name: string };
  product: { title: string | null; style: string | null; aiFramework: string | null; productType: string };
  size: string | null;
  variant: { name: string; value: string }[];
  figureCount: number | null;
  buyerPhotoUrls: string[];
  buyerNotes: string | null;
  revision: null | {
    number: number;
    source: "buyer" | "qc";
    buyerWords: string;
    issues: string[];
    priorPortraitUrl: string | null;
  };
  state: string;
  dueAt: string | null;
  queuedAt: string;
};

async function assetUrl(a: { url: string | null; storage: string; r2Key: string | null }): Promise<string | null> {
  if (a.url) return a.url;
  if (a.storage !== "r2" || !a.r2Key) return null;
  if (a.r2Key.startsWith(DEV_STORE_PREFIX)) return appUrl(`/api/upload/dev/${a.r2Key.slice(DEV_STORE_PREFIX.length)}`);
  if (!isR2Configured()) return null;
  try {
    return await presignGet(a.r2Key);
  } catch {
    return null;
  }
}

async function buildJob(tx: Tx, orderId: string): Promise<AiJob | null> {
  const [o] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      status: orders.status,
      notes: orders.notes,
      aiState: orders.aiState,
      revisionCount: orders.revisionCount,
      dueAt: orders.dueAt,
      updatedAt: orders.updatedAt,
      number: orders.platformOrderName,
      fallbackNumber: orders.platformOrderId,
      businessName: businesses.name,
    })
    .from(orders)
    .innerJoin(businesses, eq(businesses.id, orders.businessId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!o) return null;

  const [item] = await tx
    .select({
      title: orderItems.title,
      style: orderItems.style,
      variation: orderItems.variation,
      options: orderItems.options,
      figureCount: orderItems.figureCount,
      productType: orderItems.productType,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .limit(1);

  const { findStyle } = await import("./ai-core");
  const styleRow = await findStyle(tx, o.businessId, item?.style ?? null);

  const refs = await tx
    .select({ url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
    .from(assets)
    .where(and(eq(assets.orderId, orderId), eq(assets.type, "reference"), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt));
  const photoUrls = (await Promise.all(refs.map(assetUrl))).filter((u): u is string => !!u);

  const isRevision = o.aiState === "revision" || o.aiState === "revision_claimed";
  let revision: AiJob["revision"] = null;
  if (isRevision) {
    const [move] = await tx
      .select({ from: activityLog.fromState, meta: activityLog.metadata, at: activityLog.createdAt })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, orderId), eq(activityLog.toState, "in_design"), eq(activityLog.action, "order.in_design")))
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    const meta = (move?.meta ?? {}) as Record<string, unknown>;
    const fromQc = move?.from === "awaiting_qc";
    let words = "";
    let issues: string[] = [];
    if (fromQc) {
      words = typeof meta.reason === "string" ? meta.reason : "";
      issues = Array.isArray(meta.failedItems) ? (meta.failedItems as string[]) : [];
    } else {
      const [proof] = await tx
        .select({ notes: proofs.revisionNotes, failed: proofs.failedItems })
        .from(proofs)
        .where(and(eq(proofs.orderId, orderId), eq(proofs.decision, "revision")))
        .orderBy(desc(proofs.decidedAt))
        .limit(1);
      words = proof?.notes ?? (typeof meta.revisionReason === "string" ? meta.revisionReason : "");
      issues = proof?.failed ?? (Array.isArray(meta.revisionIssues) ? (meta.revisionIssues as string[]) : []);
    }
    const [prior] = await tx
      .select({ url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
      .from(assets)
      .where(and(eq(assets.orderId, orderId), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
      .orderBy(desc(assets.createdAt))
      .limit(1);
    revision = {
      number: o.revisionCount,
      source: fromQc ? "qc" : "buyer",
      buyerWords: words,
      issues,
      priorPortraitUrl: prior ? await assetUrl(prior) : null,
    };
  }

  const options = (item?.options ?? []) as { name: string; value: string }[];
  const sizeOpt = options.find((p) => /size|dimension/i.test(p.name));
  return {
    jobId: o.id,
    kind: isRevision ? "revision" : "new",
    orderId: o.id,
    orderNumber: o.number ?? o.fallbackNumber,
    business: { id: o.businessId, name: o.businessName },
    product: {
      title: item?.title ?? null,
      style: item?.style ?? null,
      aiFramework: styleRow?.aiFramework ?? null,
      productType: item?.productType ?? "digital",
    },
    size: sizeOpt?.value ?? item?.variation ?? null,
    variant: options,
    figureCount: item?.figureCount ?? null,
    buyerPhotoUrls: photoUrls,
    buyerNotes: o.notes,
    revision,
    state: o.aiState ?? "queued",
    dueAt: o.dueAt ? o.dueAt.toISOString() : null,
    queuedAt: o.updatedAt.toISOString(),
  };
}

/** Orders held by an agent designer and waiting to be drawn (new or revision). */
function pendingJobWhere() {
  return and(
    eq(designerProfiles.isAgent, true),
    eq(assignments.active, true),
    or(
      // A revision is queued while the order sits in design.
      and(eq(orders.aiState, "revision"), eq(orders.status, "in_design")),
      // New: queued explicitly, or assigned to the agent by hand (ai_state unset).
      and(or(eq(orders.aiState, "queued"), isNull(orders.aiState)), eq(orders.status, "ready_to_assign")),
    ),
  );
}

export async function listPendingJobs(opts?: { businessId?: string; limit?: number }): Promise<AiJob[]> {
  return withSystemContext(async (tx) => {
    const rows = await tx
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(assignments, eq(assignments.orderId, orders.id))
      .innerJoin(designerProfiles, eq(designerProfiles.userId, assignments.designerId))
      .where(and(pendingJobWhere(), opts?.businessId ? eq(orders.businessId, opts.businessId) : undefined))
      .orderBy(asc(orders.dueAt), asc(orders.updatedAt))
      .limit(opts?.limit ?? 50);
    const jobs: AiJob[] = [];
    for (const r of rows) {
      const job = await buildJob(tx, r.id);
      if (job) jobs.push(job);
    }
    return jobs;
  });
}

async function loadHeldOrder(tx: Tx, orderId: string) {
  const [row] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      status: orders.status,
      aiState: orders.aiState,
      agentId: assignments.designerId,
    })
    .from(orders)
    .innerJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true)))
    .innerJoin(designerProfiles, and(eq(designerProfiles.userId, assignments.designerId), eq(designerProfiles.isAgent, true)))
    .where(eq(orders.id, orderId))
    .for("update", { of: orders })
    .limit(1);
  if (!row) throw new AiJobError(404, "not_found", "No AI job for this order (not held by the AI designer).");
  return row;
}

export async function claimJob(orderId: string): Promise<AiJob> {
  return withSystemContext(async (tx) => {
    const o = await loadHeldOrder(tx, orderId);
    const isRevision = o.aiState === "revision";
    const isNew = (o.aiState === "queued" || o.aiState === null) && o.status === "ready_to_assign";
    if (!isRevision && !isNew) {
      throw new AiJobError(409, "not_claimable", `Job is not waiting (state ${o.aiState ?? "none"}, order ${o.status}).`);
    }
    if (isNew) {
      await runTransition(tx, SYSTEM_ACTOR, { orderId, to: "in_design", expectedFrom: "ready_to_assign", metadata: { via: "ai_claim" } });
    }
    await tx
      .update(orders)
      .set({ aiState: isRevision ? "revision_claimed" : "claimed", aiClaimedAt: new Date() })
      .where(eq(orders.id, orderId));
    await tx.insert(activityLog).values({
      businessId: o.businessId,
      orderId,
      actorId: o.agentId,
      action: "ai.claimed",
      metadata: { kind: isRevision ? "revision" : "new", ...(isRevision ? { stage: AI_REVISION_STAGE } : {}) },
    });
    const job = await buildJob(tx, orderId);
    return job as AiJob;
  });
}

export type DeliverInput = {
  url?: string | null;
  base64?: string | null;
  contentType?: string | null;
  filename?: string | null;
  selfCheck?: string | null;
};

export async function deliverJob(orderId: string, input: DeliverInput): Promise<{ status: OrderStatus; assetId: string }> {
  const selfCheck = input.selfCheck?.trim();
  if (!selfCheck) throw new AiJobError(400, "self_check_required", "selfCheck is required: say what you checked against the photos and the brief.");
  const url = input.url?.trim() || null;
  const base64 = input.base64?.trim() || null;
  if (!url === !base64) throw new AiJobError(400, "one_file", "Send exactly one of url or base64.");
  if (url && !/^https?:\/\//i.test(url)) throw new AiJobError(400, "bad_url", "url must be http(s).");

  // Store the bytes before the transaction so a slow upload never holds the row lock.
  let stored: { r2Key: string } | null = null;
  const o0 = await withSystemContext((tx) => loadHeldOrder(tx, orderId));
  if (base64) {
    const raw = base64.replace(/^data:[^;]+;base64,/, "");
    const bytes = Buffer.from(raw, "base64");
    if (!bytes.length) throw new AiJobError(400, "empty_file", "base64 decoded to nothing.");
    if (bytes.length > MAX_DELIVER_BYTES) throw new AiJobError(413, "too_big", "File is over 25 MB.");
    const contentType = input.contentType?.trim() || (base64.match(/^data:([^;]+);/)?.[1] ?? "image/png");
    if (!IMAGE_TYPE.test(contentType)) throw new AiJobError(400, "bad_type", "contentType must be jpeg, png, webp or gif.");
    const key = assetKey(o0.businessId, orderId, "submission", extFor(input.filename ?? "", contentType));
    if (isR2Configured()) {
      const res = await fetch(await presignUpload({ key, contentType }), { method: "PUT", headers: { "content-type": contentType }, body: bytes });
      if (!res.ok) throw new AiJobError(502, "upload_failed", `Storage refused the file (${res.status}).`);
      stored = { r2Key: key };
    } else {
      const devKey = `${DEV_STORE_PREFIX}${key}`;
      await writeDevStoreObject(devKey, contentType, bytes);
      stored = { r2Key: devKey };
    }
  }

  return withSystemContext(async (tx) => {
    const o = await loadHeldOrder(tx, orderId);
    if ((o.aiState !== "claimed" && o.aiState !== "revision_claimed") || o.status !== "in_design") {
      throw new AiJobError(409, "not_claimed", `Claim the job first (state ${o.aiState ?? "none"}, order ${o.status}).`);
    }
    const wasRevision = o.aiState === "revision_claimed";
    // Same shape as a human upload (saveCardAssetUploads): a 'submission' asset.
    const [asset] = await tx
      .insert(assets)
      .values(
        stored
          ? { businessId: o.businessId, orderId, type: "submission", storage: "r2", r2Key: stored.r2Key, uploadedBy: o.agentId }
          : { businessId: o.businessId, orderId, type: "submission", storage: "cdn", url: url!, uploadedBy: o.agentId },
      )
      .returning({ id: assets.id });
    const { status } = await runTransition(tx, SYSTEM_ACTOR, {
      orderId,
      to: "awaiting_qc",
      expectedFrom: "in_design",
      metadata: { via: "ai_deliver", ...(wasRevision ? { stage: AI_REVISION_STAGE } : {}) },
    });
    await tx.update(orders).set({ aiState: "qc", aiClaimedAt: null }).where(eq(orders.id, orderId));
    await tx.insert(activityLog).values({
      businessId: o.businessId,
      orderId,
      actorId: o.agentId,
      action: "ai.delivered",
      fromState: "in_design",
      toState: "awaiting_qc",
      metadata: { selfCheck, assetId: asset.id, revision: wasRevision, ...(wasRevision ? { stage: AI_REVISION_STAGE } : {}) },
    });
    return { status, assetId: asset.id };
  });
}

export async function failJob(orderId: string, reason: string | null | undefined): Promise<{ exceptionId: string }> {
  const why = reason?.trim();
  if (!why) throw new AiJobError(400, "reason_required", "reason is required.");
  return withSystemContext(async (tx) => {
    const o = await loadHeldOrder(tx, orderId);
    if (o.aiState === "qc" || o.aiState === "owner_review" || o.aiState === "with_buyer") {
      throw new AiJobError(409, "not_failable", `Job already delivered (state ${o.aiState}).`);
    }
    const [{ number }] = await tx
      .select({ number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})` })
      .from(orders)
      .where(eq(orders.id, orderId));
    const ex = await openExceptionTx(tx, {
      businessId: o.businessId,
      orderId,
      kind: "ai_designer_failed",
      summary: `The AI designer could not finish order ${number}: ${why.slice(0, 200)}`,
      detail: { reason: why, aiState: o.aiState, orderStatus: o.status },
    });
    // failed = out of the jobs queue but still held by the agent, so a person can reassign it.
    await tx.update(orders).set({ aiState: "failed", aiClaimedAt: null }).where(eq(orders.id, orderId));
    await tx.insert(activityLog).values({
      businessId: o.businessId,
      orderId,
      actorId: o.agentId,
      action: "ai.failed",
      metadata: { reason: why, exceptionId: ex.id },
    });
    return { exceptionId: ex.id };
  });
}

/* ------------------------------------------------------- owner approval */

/** True when this order is AI-held and the business wants to approve each AI portrait. */
export async function ownerReviewRequired(tx: Tx, orderId: string, businessId: string): Promise<boolean> {
  if (!(await isAgentAssigned(tx, orderId))) return false;
  const [biz] = await tx.select({ agentConfig: businesses.agentConfig }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return getAgentConfig(biz).aiOwnerApproval;
}

/** After VA QC passes an AI proof with the proof email held: park it in owner_review. */
export async function holdForOwnerReview(
  tx: Tx,
  input: { orderId: string; businessId: string; messageId: string; byUserId: string | null },
): Promise<void> {
  await tx.update(orders).set({ aiState: "owner_review" }).where(eq(orders.id, input.orderId));
  await tx.insert(activityLog).values({
    businessId: input.businessId,
    orderId: input.orderId,
    actorId: input.byUserId,
    action: "ai.owner_review_queued",
    metadata: { messageId: input.messageId },
  });
}

export type OwnerReviewItem = {
  orderId: string;
  orderNumber: string;
  customerEmail: string | null;
  portraitUrl: string | null;
  messageId: string | null;
  subject: string | null;
  selfCheck: string | null;
  waitingSince: string;
};

export async function listOwnerReview(businessId: string): Promise<OwnerReviewItem[]> {
  return withSystemContext(async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        fallback: orders.platformOrderId,
        at: orders.updatedAt,
      })
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.aiState, "owner_review")))
      .orderBy(asc(orders.updatedAt));
    const out: OwnerReviewItem[] = [];
    for (const r of rows) {
      const held = await findHeldDraft(tx, r.id);
      const [asset] = await tx
        .select({ url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
        .from(assets)
        .where(and(eq(assets.orderId, r.id), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
        .orderBy(desc(assets.createdAt))
        .limit(1);
      const [delivered] = await tx
        .select({ meta: activityLog.metadata })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, r.id), eq(activityLog.action, "ai.delivered")))
        .orderBy(desc(activityLog.createdAt))
        .limit(1);
      out.push({
        orderId: r.id,
        orderNumber: r.number ?? r.fallback,
        customerEmail: held?.address ?? null,
        portraitUrl: asset ? await assetUrl(asset) : null,
        messageId: held?.id ?? null,
        subject: held?.subject ?? null,
        selfCheck: ((delivered?.meta ?? {}) as { selfCheck?: string }).selfCheck ?? null,
        waitingSince: r.at.toISOString(),
      });
    }
    return out;
  });
}

async function findHeldDraft(tx: Tx, orderId: string) {
  const [m] = await tx
    .select({ id: messages.id, subject: messages.subject, address: messages.address, proofId: messages.proofId })
    .from(messages)
    .where(
      and(
        eq(messages.orderId, orderId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "draft"),
        sql`${messages.metadata} ? 'qcPass'`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return m ?? null;
}

export type ApproveResult = { ok: true; messageId: string } | { ok: false; code: string; message: string };

/**
 * The owner approves a held AI portrait: the held proof email goes out, the
 * proof is marked sent, and the normal awaiting_approval flow carries on
 * (buyer approves or asks for a revision through the proof link as usual).
 */
export async function approveOwnerReview(orderId: string, userId: string): Promise<ApproveResult> {
  const prep = await withSystemContext(async (tx) => {
    const [user] = await tx.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user?.active || user.role !== "admin") return { ok: false as const, code: "forbidden", message: "Only an owner can approve an AI portrait." };
    const [o] = await tx
      .select({ businessId: orders.businessId, aiState: orders.aiState, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!o || o.aiState !== "owner_review") return { ok: false as const, code: "not_waiting", message: "This order is not waiting for owner approval." };
    const held = await findHeldDraft(tx, orderId);
    if (!held) return { ok: false as const, code: "no_draft", message: "The held proof email is missing. Send the proof from the order page." };
    return { ok: true as const, businessId: o.businessId, held };
  });
  if (!prep.ok) return prep;

  const sent = await sendMessage(prep.held.id, { approvedById: userId, markRetryableFailed: true });
  if (!sent.ok) return { ok: false, code: "email_failed", message: `The proof email did not send: ${sent.error}` };

  await withSystemContext(async (tx) => {
    if (prep.held.proofId) await tx.update(proofs).set({ sentAt: new Date() }).where(eq(proofs.id, prep.held.proofId));
    await tx.update(orders).set({ aiState: "with_buyer" }).where(eq(orders.id, orderId));
    await tx.insert(activityLog).values([
      {
        businessId: prep.businessId,
        orderId,
        actorId: userId,
        action: "email.sent",
        metadata: { messageId: prep.held.id, to: prep.held.address, via: "ai_owner_approval" },
      },
      { businessId: prep.businessId, orderId, actorId: userId, action: "ai.owner_approved", metadata: { messageId: prep.held.id } },
    ]);
  });
  return { ok: true, messageId: prep.held.id };
}

/* ------------------------------------------------------------- reassign */

const REASSIGNABLE = new Set<OrderStatus>([
  "awaiting_details",
  "awaiting_photos",
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
  "awaiting_approval",
  "on_hold",
]);

export type ReassignResult = { ok: true; changed: boolean } | { ok: false; code: string; message: string };

/**
 * The one reassignment path, for any order including AI-queued ones. Moving an
 * order away from the agent removes it from the jobs queue (ai_state cleared,
 * assignment deactivated); moving it to the agent queues it as a job.
 */
export async function reassignOrder(orderId: string, designerId: string, byUserId: string | null): Promise<ReassignResult> {
  return withSystemContext(async (tx) => {
    const [o] = await tx
      .select({ id: orders.id, businessId: orders.businessId, status: orders.status, aiState: orders.aiState })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!o) return { ok: false as const, code: "not_found", message: "Order not found." };
    if (!REASSIGNABLE.has(o.status)) {
      return { ok: false as const, code: "status", message: `Cannot reassign while it is ${o.status.replace(/_/g, " ")}.` };
    }
    const [target] = await tx
      .select({ id: users.id, isAgent: designerProfiles.isAgent })
      .from(users)
      .innerJoin(designerBusinesses, and(eq(designerBusinesses.userId, users.id), eq(designerBusinesses.businessId, o.businessId)))
      .leftJoin(designerProfiles, eq(designerProfiles.userId, users.id))
      .where(and(eq(users.id, designerId), eq(users.role, "designer"), eq(users.active, true)))
      .limit(1);
    if (!target) return { ok: false as const, code: "designer", message: "That designer does not work in this order's business." };

    const [current] = await tx
      .select({ designerId: assignments.designerId })
      .from(assignments)
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)))
      .limit(1);
    if (current?.designerId === designerId && !(target.isAgent && o.aiState === "failed")) {
      return { ok: true as const, changed: false };
    }
    const wasAgent = current ? await isAgentAssigned(tx, orderId) : false;
    await createAssignment(tx, {
      orderId,
      businessId: o.businessId,
      designerId,
      assignedBy: byUserId,
      reason: wasAgent ? "Reassigned from the AI designer." : null,
    });
    await tx.insert(activityLog).values({
      businessId: o.businessId,
      orderId,
      actorId: byUserId,
      action: current ? "order.reassigned" : "order.assigned",
      metadata: { designerId, via: "reassign_order", ...(wasAgent ? { fromAi: true } : {}), ...(target.isAgent ? { toAi: true } : {}) },
    });
    if (target.isAgent) {
      // A revision in progress stays a revision job; anything else is a fresh job.
      if (o.status === "in_design" && (o.aiState === "revision" || o.aiState === "revision_claimed")) {
        await tx.update(orders).set({ aiState: "revision", aiClaimedAt: null }).where(eq(orders.id, orderId));
      } else {
        await markQueuedForAgent(tx, { orderId, businessId: o.businessId, byUserId, via: "reassign" });
      }
    } else if (wasAgent || o.aiState) {
      await tx.update(orders).set({ aiState: null, aiClaimedAt: null }).where(eq(orders.id, orderId));
      if (wasAgent) {
        await tx.insert(activityLog).values({
          businessId: o.businessId,
          orderId,
          actorId: byUserId,
          action: "ai.removed_from_queue",
          metadata: { designerId },
        });
      }
    }
    return { ok: true as const, changed: true };
  });
}

/** Turn the AI designer on or off for one style (product) of a business. */
export async function setStyleAiDesigner(
  tx: Tx,
  input: { businessId: string; styleName: string; enabled: boolean; framework?: string | null },
): Promise<boolean> {
  const { styles } = await import("@/lib/db/schema");
  const rows = await tx
    .update(styles)
    .set({ aiDesignerEnabled: input.enabled, aiFramework: input.enabled ? (input.framework?.trim() || null) : null })
    .where(and(eq(styles.businessId, input.businessId), sql`lower(${styles.name}) = ${input.styleName.trim().toLowerCase()}`))
    .returning({ id: styles.id });
  if (input.enabled) {
    const { ensureAgentDesigner } = await import("./ai-core");
    await ensureAgentDesigner(tx, input.businessId);
  }
  return rows.length > 0;
}

export { getAgentDesignerId as agentDesignerIdFor };
