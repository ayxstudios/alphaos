/**
 * The agent's side of the Auto QC fix samples (docs/AUTO_QC.md "Fix samples"):
 * which orders still need a fix attempt, a signed upload for the fix image,
 * and storing the answer. Runs for the agent (no signed-in user), so it reads
 * through the system context and writes with actor_id null. Never changes an
 * order's state and never sends anything.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

import { SYSTEM_ACTOR_ID, withSystemContext, type RequestUser } from "@/lib/db";
import { activityLog, assets, autoQcChecks, autoQcFixes, businesses, orders } from "@/lib/db/schema";
import { headObject, isR2Configured, presignGet, presignUpload } from "@/lib/storage/r2";
import { getApproveItem, getApproveQueue } from "./approve-data";
import { latestSlots, sameIds, slotAssetIds, type AutoQcPortrait, type AutoQcRevision } from "./auto-qc";
import { fixKeyPrefix, latestBySlot, MAX_FIX_BYTES, type AutoQcFixBody } from "./auto-qc-fix";
import type { AutoQcJob } from "./auto-qc-jobs";

const SYSTEM: RequestUser = { id: SYSTEM_ACTOR_ID, role: "admin" };
/** The agent's own signed download links: long enough for a slow repaint run. */
const AGENT_LINK_SECONDS = 2 * 3600;

export type AutoQcFixJob = AutoQcJob & {
  autoQcId: string;
  autoQc: { verdict: string; summary: string | null; portraits: AutoQcPortrait[]; revision: AutoQcRevision | null };
};

/**
 * Orders in the owner's QC queue whose CURRENT Auto QC found problems and that
 * have no fix row for that Auto QC yet (ready or failed), oldest first in the
 * same order as /approve. `orderNumber` returns that order whatever its rows.
 * The portrait links are full size: the repaint is pasted back at print size.
 */
export async function listFixJobs(opts: { limit: number; orderNumber?: string | null }): Promise<AutoQcFixJob[]> {
  let ids: string[];
  if (opts.orderNumber) {
    const n = opts.orderNumber.trim();
    ids = await withSystemContext(async (tx) => {
      const byName = await tx.select({ id: orders.id }).from(orders).where(eq(orders.platformOrderName, n)).limit(1);
      if (byName.length) return byName.map((r) => r.id);
      const byId = await tx.select({ id: orders.id }).from(orders).where(eq(orders.platformOrderId, n)).limit(1);
      return byId.map((r) => r.id);
    });
  } else {
    ids = await getApproveQueue(SYSTEM);
  }
  if (!ids.length) return [];

  // Newest Auto QC per order, and which Auto QCs already have a fix attempt.
  const { newest, tried } = await withSystemContext(async (tx) => {
    const rows = await tx.select().from(autoQcChecks).where(inArray(autoQcChecks.orderId, ids)).orderBy(desc(autoQcChecks.createdAt));
    const newest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!newest.has(r.orderId)) newest.set(r.orderId, r);
    const qcIds = [...newest.values()].map((r) => r.id);
    const done = qcIds.length
      ? await tx.select({ autoQcId: autoQcFixes.autoQcId }).from(autoQcFixes).where(inArray(autoQcFixes.autoQcId, qcIds))
      : [];
    return { newest, tried: new Set(done.map((d) => d.autoQcId)) };
  });

  const jobs: AutoQcFixJob[] = [];
  for (const id of ids) {
    if (jobs.length >= opts.limit) break;
    const qc = newest.get(id);
    if (!qc || qc.verdict !== "issues") continue;
    if (!opts.orderNumber && tried.has(qc.id)) continue;
    const item = await getApproveItem(SYSTEM, id);
    if (!item || item.ctx.status !== "awaiting_qc") continue;
    const slots = latestSlots(item.ctx.versions, item.ctx.portraits);
    if (!slots.length || !sameIds(qc.assetIds, slotAssetIds(slots))) continue; // judged an older upload
    const businessName = await withSystemContext(async (tx) => {
      const [b] = await tx
        .select({ name: businesses.name })
        .from(orders)
        .innerJoin(businesses, eq(businesses.id, orders.businessId))
        .where(eq(orders.id, id));
      return b?.name ?? "";
    });
    const full = await withSystemContext(async (tx) => {
      const rows = await tx
        .select({ id: assets.id, storage: assets.storage, r2Key: assets.r2Key, url: assets.url })
        .from(assets)
        .where(inArray(assets.id, slots.map((s) => s.latest.id)));
      return new Map(rows.map((r) => [r.id, r]));
    });
    const linkFor = async (assetId: string, fallback: string | null) => {
      const a = full.get(assetId);
      if (a?.storage === "r2" && a.r2Key && isR2Configured()) {
        try { return await presignGet(a.r2Key, AGENT_LINK_SECONDS); } catch { return fallback; }
      }
      return a?.url ?? fallback;
    };
    const { ctx } = item;
    jobs.push({
      orderId: ctx.orderId,
      orderNumber: ctx.orderNumber,
      businessName,
      shopName: item.shopName,
      status: ctx.status,
      style: ctx.style,
      styleGuessed: ctx.styleGuessed,
      figureCount: ctx.figureCount,
      isRevision: item.isRevision,
      round: item.round,
      requests: item.requests.map((r) => ({ source: r.kind, who: r.who, text: r.note, items: r.items, pins: r.pins, at: r.at })),
      orderSays: ctx.orderSays,
      references: ctx.references,
      portraits: await Promise.all(
        slots.map(async (s) => ({
          portrait: s.portrait,
          label: ctx.portraits.find((p) => p.n === s.portrait)?.label ?? "",
          assetId: s.latest.id,
          url: await linkFor(s.latest.id, s.latest.url),
          previous: s.previous ? { assetId: s.previous.id, url: s.previous.url } : null,
        })),
      ),
      assetIds: slotAssetIds(slots),
      autoQcId: qc.id,
      autoQc: {
        verdict: qc.verdict,
        summary: qc.summary,
        portraits: (Array.isArray(qc.portraits) ? qc.portraits : []) as AutoQcPortrait[],
        revision: (qc.revision as AutoQcRevision | null) ?? null,
      },
    });
  }
  return jobs;
}

/** A signed PUT for one fix image of this order. The agent uploads straight to the private bucket. */
export async function createFixUpload(orderId: string, contentType: string): Promise<{ ok: true; key: string; uploadUrl: string } | { ok: false; status: number; error: string }> {
  if (!/^image\/(jpeg|png)$/.test(contentType)) return { ok: false, status: 400, error: "contentType must be image/jpeg or image/png" };
  if (!isR2Configured()) return { ok: false, status: 503, error: "file storage is not configured" };
  const exists = await withSystemContext(async (tx) => {
    const [o] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1);
    return !!o;
  });
  if (!exists) return { ok: false, status: 404, error: "order not found" };
  const key = `${fixKeyPrefix(orderId)}ai-fix-${randomUUID()}.${contentType === "image/png" ? "png" : "jpg"}`;
  return { ok: true, key, uploadUrl: await presignUpload({ key, contentType }) };
}

export type SaveFixResult = { ok: true; id: string } | { ok: false; status: number; error: string };

/** Store the agent's answer. A ready fix must be painted on the slot's newest version and its file must be in storage. */
export async function saveFix(body: AutoQcFixBody): Promise<SaveFixResult> {
  const item = await getApproveItem(SYSTEM, body.orderId);
  if (!item) return { ok: false, status: 404, error: "order not found" };
  if (item.ctx.status !== "awaiting_qc") return { ok: false, status: 409, error: "stale: the order is no longer waiting for QC" };
  const latest = latestBySlot(item.ctx.versions, item.ctx.portraits);
  if (latest.get(body.portrait) !== body.sourceAssetId) return { ok: false, status: 409, error: "stale: the designer uploaded a newer version" };
  if (body.status === "ready") {
    try {
      const head = await headObject(body.key!);
      if (!head.contentLength || head.contentLength > MAX_FIX_BYTES) return { ok: false, status: 400, error: "the uploaded file is empty or too big" };
      if (head.contentType && !/^image\//.test(head.contentType)) return { ok: false, status: 400, error: "the uploaded file is not an image" };
    } catch {
      return { ok: false, status: 400, error: "the fix image was not found in storage; upload it first" };
    }
  }
  const id = await withSystemContext(async (tx) => {
    const [qc] = await tx
      .select({ id: autoQcChecks.id, businessId: autoQcChecks.businessId })
      .from(autoQcChecks)
      .where(and(eq(autoQcChecks.id, body.autoQcId), eq(autoQcChecks.orderId, body.orderId)));
    if (!qc) return null;
    const [row] = await tx
      .insert(autoQcFixes)
      .values({
        businessId: qc.businessId,
        orderId: body.orderId,
        autoQcId: body.autoQcId,
        sourceAssetId: body.sourceAssetId,
        portrait: body.portrait,
        status: body.status,
        r2Key: body.key,
        contentType: body.contentType,
        width: body.width,
        height: body.height,
        fixed: body.fixed,
        notFixed: body.notFixed,
        summary: body.summary || null,
        model: body.model,
        engine: body.engine,
      })
      .returning({ id: autoQcFixes.id });
    await tx.insert(activityLog).values({
      businessId: qc.businessId,
      orderId: body.orderId,
      actorId: null,
      action: body.status === "ready" ? "qc.ai_fix_ready" : "qc.ai_fix_failed",
      metadata: { fixId: row.id, autoQcId: body.autoQcId, sourceAssetId: body.sourceAssetId, portrait: body.portrait, fixed: body.fixed.map((f) => f.label) },
    });
    return row.id;
  });
  return id ? { ok: true, id } : { ok: false, status: 404, error: "auto QC not found for this order" };
}
