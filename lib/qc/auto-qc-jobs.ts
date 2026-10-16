/**
 * The judge's side of Auto QC (docs/AUTO_QC.md): which orders still need a
 * look, everything the judge needs to look, and storing its answer. Runs for
 * the agent (no signed-in user), so it reads through the system context and
 * writes with actor_id null. Never changes an order's state.
 */
import { and, desc, eq, inArray, isNull, max } from "drizzle-orm";

import { SYSTEM_ACTOR_ID, withSystemContext, type RequestUser } from "@/lib/db";
import { assets, autoQcChecks, businesses, orderItems, orders } from "@/lib/db/schema";
import { getApproveItem, getApproveQueue } from "./approve-data";
import type { ProofFilePick } from "@/lib/proofs/files";
import { insertAutoQc, latestSlots, sameIds, slotAssetIds, type AutoQcBody } from "./auto-qc";

const SYSTEM: RequestUser = { id: SYSTEM_ACTOR_ID, role: "admin" };

export type AutoQcJob = {
  orderId: string;
  orderNumber: string;
  businessName: string;
  shopName: string;
  status: string;
  style: string | null;
  styleGuessed: boolean;
  figureCount: number;
  /** Separate portraits (files) the order needs; 1 for a one-portrait order. */
  expectedPortraits: number;
  /** Portraits with no file yet: the order is not complete, whatever the judge sees. */
  missingPortraits: { portrait: number; label: string }[];
  isRevision: boolean;
  round: number;
  requests: { source: string; who: string | null; text: string | null; items: string[]; pins: number; at: string }[];
  orderSays: unknown;
  /** fromCustomer false = staff attached it (often the last proof, for a revision): not the customer's photo. */
  references: { id: string; url: string | null; fromCustomer?: boolean }[];
  portraits: {
    portrait: number | null;
    label: string;
    assetId: string;
    url: string | null;
    previous: { assetId: string; url: string | null } | null;
  }[];
  assetIds: string[];
};

/**
 * Orders in the owner's QC queue (same set and order as /approve) whose newest
 * artwork has not been auto checked yet. Cheap pre-filter: an order counts as
 * checked when an auto QC row is newer than its newest upload; the result
 * route then insists on the exact version ids.
 */
export async function listAutoQcJobs(opts: { limit: number; orderNumber?: string | null }): Promise<AutoQcJob[]> {
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
    const queue = await getApproveQueue(SYSTEM);
    if (queue.length === 0) return [];
    const latest = new Map<string, { at: Date; assetIds: unknown }>();
    const multi: string[] = [];
    const done = await withSystemContext(async (tx) => {
      const lastUpload = await tx
        .select({ orderId: assets.orderId, at: max(assets.createdAt) })
        .from(assets)
        .where(and(inArray(assets.orderId, queue), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
        .groupBy(assets.orderId);
      const checks = await tx
        .select({ orderId: autoQcChecks.orderId, at: autoQcChecks.createdAt, assetIds: autoQcChecks.assetIds })
        .from(autoQcChecks)
        .where(inArray(autoQcChecks.orderId, queue))
        .orderBy(desc(autoQcChecks.createdAt));
      for (const c of checks) if (!latest.has(c.orderId)) latest.set(c.orderId, c);
      const set = new Set<string>();
      for (const u of lastUpload) {
        const c = latest.get(u.orderId);
        if (c && u.at && c.at >= u.at) set.add(u.orderId);
      }
      // A 2+ portrait order can look judged by time alone while its last check
      // saw only some of its files (4199589633: dog and cat uploaded together,
      // a check from before portraits counted judged only the cat). Those are
      // compared file by file below.
      const timed = [...set];
      const lines = timed.length
        ? await tx
            .select({ orderId: orderItems.orderId, quantity: orderItems.quantity })
            .from(orderItems)
            .where(inArray(orderItems.orderId, timed))
        : [];
      const count = new Map<string, number>();
      for (const l of lines) count.set(l.orderId, (count.get(l.orderId) ?? 0) + Math.max(1, l.quantity ?? 1));
      for (const id of timed) if ((count.get(id) ?? 0) > 1) multi.push(id);
      // No artwork at all: nothing to judge yet.
      const withArt = new Set(lastUpload.map((u) => u.orderId));
      for (const id of queue) if (!withArt.has(id)) set.add(id);
      return set;
    });
    for (const id of multi) {
      const item = await getApproveItem(SYSTEM, id);
      if (!item) continue;
      const current = slotAssetIds(latestSlots(item.ctx.versions, item.ctx.portraits, item.ctx.proofFiles));
      if (!sameIds(latest.get(id)?.assetIds, current)) done.delete(id);
    }
    ids = queue.filter((id) => !done.has(id));
  }

  const jobs: AutoQcJob[] = [];
  for (const id of ids) {
    if (jobs.length >= opts.limit) break;
    const item = await getApproveItem(SYSTEM, id);
    if (!item) continue;
    const { ctx } = item;
    const slots = latestSlots(ctx.versions, ctx.portraits, ctx.proofFiles);
    if (slots.length === 0) continue;
    const businessName = await withSystemContext(async (tx) => {
      const [b] = await tx
        .select({ name: businesses.name })
        .from(orders)
        .innerJoin(businesses, eq(businesses.id, orders.businessId))
        .where(eq(orders.id, id));
      return b?.name ?? "";
    });
    jobs.push({
      orderId: ctx.orderId,
      orderNumber: ctx.orderNumber,
      businessName,
      shopName: item.shopName,
      status: ctx.status,
      style: ctx.style,
      styleGuessed: ctx.styleGuessed,
      figureCount: ctx.figureCount,
      ...portraitCounts(ctx.proofFiles),
      isRevision: item.isRevision,
      round: item.round,
      requests: item.requests.map((r) => ({ source: r.kind, who: r.who, text: r.note, items: r.items, pins: r.pins, at: r.at })),
      orderSays: ctx.orderSays,
      references: ctx.references,
      portraits: slots.map((s) => ({
        portrait: s.portrait,
        label: ctx.portraits.find((p) => p.n === s.portrait)?.label ?? "",
        assetId: s.latest.id,
        url: s.latest.url,
        previous: s.previous ? { assetId: s.previous.id, url: s.previous.url } : null,
      })),
      assetIds: slotAssetIds(slots),
    });
  }
  return jobs;
}

/** How many portraits the judge should expect, and which have no file yet. */
export function portraitCounts(pick: ProofFilePick): Pick<AutoQcJob, "expectedPortraits" | "missingPortraits"> {
  if (pick.mode !== "slots") return { expectedPortraits: 1, missingPortraits: [] };
  return { expectedPortraits: pick.expected, missingPortraits: pick.missing.map((m) => ({ portrait: m.n, label: m.label })) };
}

export type SaveResult = { ok: true; id: string } | { ok: false; status: number; error: string };

/** Store a judge answer, refusing one about artwork that has since been replaced. */
export async function saveAutoQc(body: AutoQcBody): Promise<SaveResult> {
  const item = await getApproveItem(SYSTEM, body.orderId);
  if (!item) return { ok: false, status: 404, error: "order not found" };
  const current = slotAssetIds(latestSlots(item.ctx.versions, item.ctx.portraits, item.ctx.proofFiles));
  if (!sameIds(body.assetIds, current)) return { ok: false, status: 409, error: "stale: the artwork changed since this was judged" };
  const id = await withSystemContext(async (tx) => {
    const [o] = await tx.select({ businessId: orders.businessId }).from(orders).where(eq(orders.id, body.orderId));
    return o ? insertAutoQc(tx, o.businessId, body) : null;
  });
  return id ? { ok: true, id } : { ok: false, status: 404, error: "order not found" };
}
