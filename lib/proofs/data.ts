import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, assets, businesses, orders, proofs, type ProofFileEntry } from "@/lib/db/schema";
import { getOrderPortraits } from "@/lib/orders/portraits";
import type { ProofDecision } from "./decide";

/**
 * One portrait on a 2+ portrait order, as the customer sees it: its number
 * (the same "Portrait N" the designer tagged the upload with), a short label
 * from what was ordered, and whether a version exists to show yet.
 */
export type ProofPortrait = {
  n: number;
  label: string;
  hasPreview: boolean;
};

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
  /**
   * Empty on a single-portrait order (one preview, today's page). On an order
   * with 2+ portraits whose designer tagged uploads per portrait, one entry per
   * portrait so the page shows each one under its own heading and the
   * customer always knows which portrait they are looking at (Jerome,
   * 2026-10-14).
   */
  portraits: ProofPortrait[];
  /** A newer proof was sent for the same order after this one. */
  superseded: boolean;
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
        files: proofs.files,
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
    const pinned = pinnedFiles(row.files);
    const portraits = pinned.length
      ? await pinnedPortraitPreviews(tx, row.orderId, pinned)
      : await resolvePortraitPreviews(tx, row.orderId);
    // Compare timestamps inside Postgres: converting to a JS Date loses
    // microseconds and can make a proof appear newer than itself.
    const createdAt = tx.select({ createdAt: proofs.createdAt }).from(proofs).where(eq(proofs.token, token));
    // Scoped to the one order this token resolves to.
    const [newer] = await tx
      .select({ id: proofs.id })
      .from(proofs)
      .where(and(eq(proofs.orderId, row.orderId), gt(proofs.createdAt, createdAt)))
      .limit(1);

    return {
      businessName: row.businessName,
      businessLogoUrl: row.businessLogoUrl,
      orderNumber: row.platformOrderName ?? row.platformOrderId,
      actionable: row.orderStatus === "awaiting_approval" && !row.decision && !newer,
      decision: row.decision,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      hasPreview: preview != null,
      portraits,
      superseded: Boolean(newer),
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
  /** Exactly one of url (CDN-hosted) or r2Key (private bucket) is set. */
  url: string | null;
  r2Key: string | null;
  businessName: string;
  orderNumber: string;
};

/**
 * Resolve the source image the preview route serves: the latest
 * final/submission asset for the token's order, plus the business and order
 * number for the download filename. CDN assets carry a fetchable URL; R2 assets
 * (every designer submission) carry their private key, which the route reads
 * server-side.
 */
export async function getProofImageSource(
  token: string,
  /** 1-based portrait number on a 2+ portrait order; omitted = the order's newest version. */
  portraitN?: number,
): Promise<ProofImageSource | null> {
  return withSystemContext(async (tx) => {
    const [proof] = await tx
      .select({
        orderId: proofs.orderId,
        files: proofs.files,
        businessName: businesses.name,
        orderNumber: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
      })
      .from(proofs)
      .innerJoin(businesses, eq(businesses.id, proofs.businessId))
      .innerJoin(orders, eq(orders.id, proofs.orderId))
      .where(eq(proofs.token, token));
    if (!proof) return null;

    const pinned = pinnedFiles(proof.files);
    if (portraitN && pinned.length) {
      // The exact file this proof was sent with for that portrait, and only
      // ever a file of the token's own order.
      const entry = pinned.find((f) => f.n === portraitN);
      if (!entry) return null;
      const [asset] = await tx
        .select({ url: assets.url, r2Key: assets.r2Key })
        .from(assets)
        .where(
          and(
            eq(assets.id, entry.assetId),
            eq(assets.orderId, proof.orderId),
            inArray(assets.type, [...PREVIEW_TYPES]),
            isNull(assets.deletedAt),
          ),
        )
        .limit(1);
      if (!asset || (!asset.url && !asset.r2Key)) return null;
      return { url: asset.url, r2Key: asset.r2Key, businessName: proof.businessName, orderNumber: proof.orderNumber };
    }

    let orderItemId: string | undefined;
    if (portraitN) {
      // Still scoped to the token's order: the item must be one of ITS items.
      // The page numbers its portraits per order line, whatever the quantity.
      const portrait = (await getOrderPortraits(tx, proof.orderId, { perLine: true })).find((p) => p.n === portraitN);
      if (!portrait) return null;
      orderItemId = portrait.itemId;
    }
    const asset = await resolvePreviewAsset(tx, proof.orderId, orderItemId);
    if (!asset) return null;
    return { url: asset.url, r2Key: asset.r2Key, businessName: proof.businessName, orderNumber: proof.orderNumber };
  });
}

/**
 * Latest final/submission asset (finals preferred, then newest) for an order,
 * or for one portrait of it when the designer tagged uploads per portrait.
 */
async function resolvePreviewAsset(
  tx: Tx,
  orderId: string,
  orderItemId?: string,
): Promise<{ url: string | null; r2Key: string | null } | null> {
  const rows = await tx
    .select({ url: assets.url, r2Key: assets.r2Key, type: assets.type, createdAt: assets.createdAt })
    .from(assets)
    .where(
      and(
        eq(assets.orderId, orderId),
        inArray(assets.type, [...PREVIEW_TYPES]),
        isNull(assets.deletedAt),
        ...(orderItemId ? [eq(assets.orderItemId, orderItemId)] : []),
      ),
    )
    .orderBy(desc(assets.createdAt));
  // Only assets we can actually read count, so the page never shows a broken image.
  const readable = rows.filter((r) => r.url || r.r2Key);
  if (!readable.length) return null;
  // Prefer a "final" if one exists; otherwise the newest submission.
  const final = readable.find((r) => r.type === "final");
  return final ?? readable[0];
}

type PinnedFile = { assetId: string; n: number; label: string };

/**
 * The files a proof was sent with, in portrait order, when it carried 2+
 * portraits (proofs.files, pinned by the QC send). Such a proof shows exactly
 * those files, each under the number the email used, never a newer upload
 * nobody has checked yet. Empty = the page works it out from the order.
 */
function pinnedFiles(files: ProofFileEntry[] | null): PinnedFile[] {
  if (!Array.isArray(files) || files.length < 2) return [];
  // Shop option names can arrive with their own colon ("Number of Pets:: 1").
  return files.map((f, i) => ({ assetId: f.assetId, n: f.n ?? i + 1, label: (f.label ?? "").replace(/:{2,}/g, ":") }));
}

/** One entry per pinned portrait; scoped to the token's order like every query here. */
async function pinnedPortraitPreviews(tx: Tx, orderId: string, pinned: PinnedFile[]): Promise<ProofPortrait[]> {
  const rows = await tx
    .select({ id: assets.id, url: assets.url, r2Key: assets.r2Key })
    .from(assets)
    .where(
      and(
        eq(assets.orderId, orderId),
        inArray(
          assets.id,
          pinned.map((f) => f.assetId),
        ),
        inArray(assets.type, [...PREVIEW_TYPES]),
        isNull(assets.deletedAt),
      ),
    );
  const readable = new Set(rows.filter((r) => r.url || r.r2Key).map((r) => r.id));
  return pinned.map((f) => ({ n: f.n, label: f.label, hasPreview: readable.has(f.assetId) }));
}

/**
 * Per-portrait previews for the proof page. Only an order with 2+ portraits
 * AND at least one upload tagged to a portrait gets a list; everything else
 * (single portrait, or a multi-portrait order whose versions predate
 * per-portrait tagging) keeps the one-image page, so nothing old breaks.
 */
async function resolvePortraitPreviews(tx: Tx, orderId: string): Promise<ProofPortrait[]> {
  const portraits = await getOrderPortraits(tx, orderId, { perLine: true });
  if (portraits.length < 2) return [];
  const previews = await Promise.all(
    // Shop option names can arrive with their own colon ("Number of Pets:: 1").
    portraits.map(async (p) => ({ n: p.n, label: p.label.replace(/:{2,}/g, ":"), hasPreview: (await resolvePreviewAsset(tx, orderId, p.itemId)) != null })),
  );
  return previews.some((p) => p.hasPreview) ? previews : [];
}
