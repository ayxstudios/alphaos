import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, assets, orders, shops, users } from "@/lib/db/schema";
import type { CardEvent } from "@/lib/orders/card-detail";
import type { ProofFilePick } from "@/lib/proofs/files";
import { buildRevisionHistory, type RevisionHistoryNote } from "@/lib/orders/revision-history";
import type { OrderStatus } from "@/lib/orders/transitions";
import { aiAwaitingAutoQc } from "./ai-qc-gate";
import { getAutoQcView, latestSlots, slotAssetIds, type AutoQcView } from "./auto-qc";
import { othersClaims, startIndex, summarizeOthers } from "./claims";
import { getFixViews, type AutoQcFixView } from "./auto-qc-fix";
import { getQcContext, getQcQueueIds, resolveAssetUrl, type QcContext } from "./data";
import { getQueueKinds, type OrderStream } from "./approve-streams";
import { duplicateSlotsGate } from "./duplicate-slots";
import { evaluateRevisionStop } from "./revision-stop";
import { autoQcWrongFileApplies, currentArtworkIds, wrongFileWarningsFor } from "./wrong-file";

/**
 * What Auto QC found against the files going out, shown before the tap (Ayser
 * 2026-10-22: the stop used to pop up as a browser box 8 s after Approve, over
 * the next order, and refused his "OK"; "Do not do the popup thing", "its
 * something I already approved"). An owner's Approve sends it anyway and the
 * gates log it (confirmQcPassAndSend); this is the same rule read from the
 * check on screen, so the owner sees it before deciding.
 */
export type ApproveStop = { kind: "wrong_file" | "revision_not_done" | "picture_match" | "duplicate_slots"; message: string };

export function approveStopOf(view: AutoQcView | null, outgoing: string[]): ApproveStop | null {
  if (!view) return null;
  // The gate's rule (autoQcWrongFileApplies): a portrait-named finding holds while that portrait's file goes out.
  const judged = view.portraits.map((p) => p.assetId).filter(Boolean);
  if (view.wrongFile && autoQcWrongFileApplies({ assetIds: judged, portraits: view.portraits, wrongFile: view.wrongFile }, outgoing)) {
    return { kind: "wrong_file", message: `Auto QC thinks this is the wrong file: ${view.wrongFile.note.replace(/\.\s*$/, "")}.` };
  }
  if (!view.current) return null;
  // current = the check judged exactly these files (the revision stop's rule).
  const stop = evaluateRevisionStop({ id: view.id, assetIds: judged, revision: view.revision }, judged);
  if (!stop) return null;
  const missed = stop.missed.length ? ` Missed: ${stop.missed.slice(0, 4).join("; ")}.` : stop.note ? ` ${stop.note}` : "";
  return { kind: "revision_not_done", message: `Auto QC says this revision ${stop.done === "no" ? "was not done" : "is only partly done"}.${missed}` };
}

/**
 * The owner Approve screen (/approve, 2026-10-14): from 14 Oct there are no
 * VAs, so the owners QC designer work themselves, one order at a time, with
 * two buttons. This is the QC context plus the two things that screen leads
 * with: is it a NEW ORDER or a REVISION, and what was asked for.
 */
export type ApproveItem = {
  ctx: QcContext;
  shopName: string;
  urgent: boolean;
  urgentReason: string | null;
  /** True once the order has been sent back to the designer at least once. */
  isRevision: boolean;
  /** Which round this is (1 = first redo). */
  round: number;
  /** Every change request, newest first (customer, team or a failed QC). */
  requests: RevisionHistoryNote[];
  /** The newest Auto QC on this order (2026-10-14), or null when none yet. */
  autoQc: AutoQcView | null;
  /** AI fix samples painted on the current versions (one per portrait at most), newest first. */
  fixes: AutoQcFixView[];
  /** An AI Studio portrait whose newest file has no Auto QC yet: Approve stays shut until it has (lib/qc/ai-qc-gate.ts). */
  aiWaiting: boolean;
  /** The files a proof email carries by default (from the QC context). */
  proofFiles: ProofFilePick;
  /** Auto QC's wrong-file or revision stop on the files going out, or null (approveStopOf). */
  stop: ApproveStop | null;
};

export async function getApproveQueue(user: RequestUser, skip: string[] = []): Promise<string[]> {
  // One queue across every business the owner can see. `skip` = approvals still
  // in their Stop window: still awaiting_qc on the server, so kept out here.
  const ids = await getQcQueueIds(user, "all");
  if (!skip.length) return ids;
  const hide = new Set(skip);
  return ids.filter((id) => !hide.has(id));
}

/**
 * The queue one owner works on /approve (2026-10-14, two owners): the shared
 * queue minus anything another person has open right now (lib/qc/claims.ts),
 * so the two of them never land on the same order. `start` = where to open:
 * the order asked for with ?o=, or when that one is gone or someone else's,
 * the next free one after it in the shared order (so Skip never bounces back
 * to the order just skipped). `takenBy` = who has the asked-for order when it
 * is someone else's; `others` = who else is checking and how many.
 */
export async function getOwnerApproveQueue(
  user: RequestUser,
  skip: string[] = [],
  asked?: string,
  stream?: OrderStream,
): Promise<{
  ids: string[];
  start: number;
  others: { name: string; count: number }[];
  takenBy: string | null;
  /** The stream these ids are in (the one asked for, else the asked-for order's, else the first with anything in it). */
  stream: OrderStream;
  /** Orders waiting per stream (what someone else has open or what is in its Stop window not counted). */
  counts: Record<OrderStream, number>;
}> {
  const [all0, live] = await Promise.all([
    getQcQueueIds(user, "all"),
    withUserContext(user, (tx) => othersClaims(tx, user.id)),
  ]);
  const kinds = await getQueueKinds(user, all0);
  const inQueue = new Set(all0);
  const claims = live.filter((c) => inQueue.has(c.orderId));
  const hide = new Set([...skip, ...claims.map((c) => c.orderId)]);
  const free = all0.filter((id) => !hide.has(id));
  const counts: Record<OrderStream, number> = { new: 0, revision: 0 };
  for (const id of free) counts[kinds.get(id) ?? "new"]++;
  // An order opened by link (?o=) decides its own stream; a stream tab with nothing on it falls to the other one.
  const chosen: OrderStream =
    (asked && kinds.get(asked)) || stream || (counts.new === 0 && counts.revision > 0 ? "revision" : "new");
  const all = all0.filter((id) => (kinds.get(id) ?? "new") === chosen);
  const ids = free.filter((id) => (kinds.get(id) ?? "new") === chosen);
  return {
    ids,
    start: startIndex(all, ids, asked),
    others: summarizeOthers(claims),
    takenBy: (asked && claims.find((c) => c.orderId === asked)?.holder) || null,
    stream: chosen,
    counts,
  };
}

export async function getApproveItem(user: RequestUser, orderId: string): Promise<ApproveItem | null> {
  const ctx = await getQcContext(user, orderId);
  if (!ctx) return null;
  const extra = await withUserContext(user, async (tx) => {
    const [o] = await tx
      .select({
        revisionCount: orders.revisionCount,
        urgentAt: orders.urgentAt,
        urgentReason: orders.urgentReason,
        shopName: shops.name,
      })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(eq(orders.id, orderId));
    const rows = await tx
      .select({
        id: activityLog.id,
        action: activityLog.action,
        actorId: activityLog.actorId,
        actorName: users.name,
        fromState: activityLog.fromState,
        toState: activityLog.toState,
        metadata: activityLog.metadata,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .leftJoin(users, eq(users.id, activityLog.actorId))
      .where(and(eq(activityLog.orderId, orderId), eq(activityLog.toState, "in_design")))
      .orderBy(asc(activityLog.createdAt));
    const events: CardEvent[] = rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actorId,
      actorName: r.actorName ?? null,
      fromState: (r.fromState as OrderStatus | null) ?? null,
      toState: (r.toState as OrderStatus | null) ?? null,
      body: null,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    const outgoing = slotAssetIds(latestSlots(ctx.versions, ctx.portraits, ctx.proofFiles));
    const autoQc = await getAutoQcView(tx, orderId, outgoing);
    const fixes = await getFixViews(tx, orderId, ctx.versions, ctx.portraits, ctx.proofFiles);
    const aiWaiting = await aiAwaitingAutoQc(tx, orderId);
    return { o, requests: buildRevisionHistory(events), autoQc, fixes, aiWaiting, outgoing };
  });
  const revisionCount = extra.o?.revisionCount ?? 0;
  const isRevision = revisionCount > 0 || extra.requests.length > 0;
  return {
    ctx,
    shopName: extra.o?.shopName ?? "",
    urgent: !!extra.o?.urgentAt,
    urgentReason: extra.o?.urgentAt ? (extra.o.urgentReason ?? null) : null,
    isRevision,
    round: Math.max(revisionCount, extra.requests.length, isRevision ? 1 : 0),
    requests: extra.requests,
    autoQc: extra.autoQc,
    fixes: extra.fixes,
    aiWaiting: extra.aiWaiting,
    proofFiles: ctx.proofFiles,
    stop: approveStopOf(extra.autoQc, extra.outgoing),
  };
}

/** How long the picture match may hold the page; past it the send's own check still runs (a failed row says so). */
const MATCH_CHECK_MS = 2_500;

/**
 * The picture check (lib/qc/wrong-file.ts: the customer's photo, the buyer's
 * other orders, 30 days of art) on the order's current files, so it is on the
 * screen before the tap like Auto QC's own findings, and the owner's Approve
 * covers it (the reviewer's catch, 22 Oct: an unseen match must not go out
 * under "approved it"). Never throws; slow or failed reads as nothing.
 */
export async function getPictureMatchStop(orderId: string): Promise<ApproveStop | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      wrongFileWarningsFor(orderId),
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), MATCH_CHECK_MS);
      }),
    ]);
    if (!res?.blocking) return null;
    return { kind: "picture_match", message: res.blocking.replace(/\s*Upload the right file for this order\.$/, "") };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Two portraits she asked to be different carrying the same file (lib/qc/duplicate-slots.ts), read before the tap
 * like the other stops so the owner's Approve covers it. The gate with no reason given only reads (two R2 HEADs at
 * most). Never throws; slow or failed reads as nothing, and the send's own check still runs.
 */
export async function getDuplicateSlotsStop(user: RequestUser, orderId: string): Promise<ApproveStop | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      withUserContext(user, (tx) => duplicateSlotsGate(tx, user, { orderId, businessId: "", via: "qc_pass" })),
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), MATCH_CHECK_MS);
      }),
    ]);
    if (!res) return null;
    const message = res.message.replace(/^Order [^:]+: /, "").replace(/\s*Fail it back to the designer.*$/, "");
    return { kind: "duplicate_slots", message };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The artwork the next order opens on (newest file per portrait), so Approve
 * can fetch it in the background while the owner looks at this one: the next
 * screen then paints its 5-8 MB image from the browser's memory. Same URLs as
 * that screen (resolveAssetUrl, stable for 10 minutes). Never throws.
 */
export async function getArtworkPreloadUrls(user: RequestUser, orderId: string | null): Promise<string[]> {
  if (!orderId) return [];
  try {
    return await withUserContext(user, async (tx) => {
      const ids = await currentArtworkIds(tx, orderId);
      if (!ids.length) return [];
      const rows = await tx
        .select({ url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
        .from(assets)
        .where(and(inArray(assets.id, ids.slice(0, 4)), isNull(assets.deletedAt)));
      const urls = await Promise.all(rows.map((r) => resolveAssetUrl(r)));
      return urls.filter((u): u is string => !!u);
    });
  } catch {
    return [];
  }
}
