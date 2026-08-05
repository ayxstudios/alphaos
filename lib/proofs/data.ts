import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, assets, businesses, orders, proofs } from "@/lib/db/schema";
import type { ProofDecision } from "./decide";

/**
 * Everything the PUBLIC proof page is allowed to render. Deliberately minimal:
 * the business identity, the order number, and the proof's own state. It never
 * carries the customer's email, internal notes, the designer's name, or any
 * other order — exposing those would defeat the point of a token-scoped page.
 */
export type ProofView = {
  businessName: string;
  businessLogoUrl: string | null;
  orderNumber: string;
  /** True while Approve / Request Revision are still legal for this order. */
  actionable: boolean;
  decision: ProofDecision | null;
  decidedAt: string | null; // ISO
  hasPreview: boolean;
};

const PREVIEW_TYPES = ["final", "submission"] as const;

/**
 * IMPORTANT: the proof portal has no signed-in user, so it runs in the system
 * (admin) RLS context. That context is cross-tenant, so EVERY query here must be
 * scoped by the unique `token` (or the single orderId it resolves to). Never
 * widen a query beyond the one proof the token addresses.
 */
export async function getProofView(token: string): Promise<ProofView | null> {
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .select({
        orderId: proofs.orderId,
        decision: proofs.decision,
        decidedAt: proofs.decidedAt,
        orderStatus: orders.status,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        businessName: businesses.name,
        businessLogoUrl: businesses.logoUrl,
      })
      .from(proofs)
      .innerJoin(orders, eq(orders.id, proofs.orderId))
      .innerJoin(businesses, eq(businesses.id, proofs.businessId))
      .where(eq(proofs.token, token));
    if (!row) return null;

    const preview = await resolvePreviewAsset(tx, row.orderId);

    return {
      businessName: row.businessName,
      businessLogoUrl: row.businessLogoUrl,
      orderNumber: row.platformOrderName ?? row.platformOrderId,
      actionable: row.orderStatus === "awaiting_approval" && !row.decision,
      decision: row.decision,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      hasPreview: preview != null,
    };
  });
}

/**
 * Record a customer view: set first_viewed_at once, bump viewed_at every time.
 * On the very first view, append a proof.viewed activity_log entry so a VA can
 * tell whether the customer has even opened the proof.
 */
export async function recordProofView(token: string): Promise<void> {
  await withSystemContext(async (tx) => {
    const [proof] = await tx
      .select({
        id: proofs.id,
        businessId: proofs.businessId,
        orderId: proofs.orderId,
        firstViewedAt: proofs.firstViewedAt,
      })
      .from(proofs)
      .where(eq(proofs.token, token));
    if (!proof) return;

    const firstView = proof.firstViewedAt == null;
    await tx
      .update(proofs)
      .set({
        viewedAt: new Date(),
        ...(firstView ? { firstViewedAt: new Date() } : {}),
      })
      .where(eq(proofs.id, proof.id));

    if (firstView) {
      await tx.insert(activityLog).values({
        businessId: proof.businessId,
        orderId: proof.orderId,
        actorId: null, // customer action, no internal user
        action: "proof.viewed",
        metadata: { via: "proof_portal" },
      });
    }
  });
}

export type ProofImageSource = {
  url: string;
  businessName: string;
};

/**
 * Resolve the source image the preview route should watermark: the latest
 * final/submission asset for the token's order, plus the business name for the
 * watermark label. Only CDN-hosted assets expose a fetchable URL; R2 assets
 * would need signing infra that does not exist yet, so they resolve to null
 * (the route then 404s rather than leaking anything).
 */
export async function getProofImageSource(
  token: string,
): Promise<ProofImageSource | null> {
  return withSystemContext(async (tx) => {
    const [proof] = await tx
      .select({ orderId: proofs.orderId, businessName: businesses.name })
      .from(proofs)
      .innerJoin(businesses, eq(businesses.id, proofs.businessId))
      .where(eq(proofs.token, token));
    if (!proof) return null;

    const asset = await resolvePreviewAsset(tx, proof.orderId);
    if (!asset?.url) return null;
    return { url: asset.url, businessName: proof.businessName };
  });
}

/** Latest final/submission asset (finals preferred, then newest) for an order. */
async function resolvePreviewAsset(
  tx: Tx,
  orderId: string,
): Promise<{ url: string | null } | null> {
  const rows = await tx
    .select({ url: assets.url, type: assets.type, createdAt: assets.createdAt })
    .from(assets)
    .where(
      and(eq(assets.orderId, orderId), inArray(assets.type, [...PREVIEW_TYPES]), isNull(assets.deletedAt)),
    )
    .orderBy(desc(assets.createdAt));
  if (!rows.length) return null;
  // Prefer a "final" if one exists; otherwise the newest submission.
  const final = rows.find((r) => r.type === "final");
  return final ?? rows[0];
}
