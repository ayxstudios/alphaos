/**
 * Wrong-file stop (incident 16 Oct 2026: PixArt PC32132, Saiya alone portrait,
 * was delivered the PC32131 Parker + Saiya landscape file). A file that is the
 * same picture as another file it must not be is refused on designer submit and
 * on QC pass; staff can override with a reason, designers cannot.
 *
 * Same picture = both looks agree (lib/qc/image-hash.ts samePicture): the dHash
 * within SAME_PICTURE_DISTANCE bits AND the 64x80 fine signature within
 * SAME_PICTURE_INK_DIFF. The dHash alone also matched different drawings on the
 * same paper (designer Jerome's CPS watercolours, 16 Oct: about 28% of real
 * uploads), so it only picks the candidates and the ink decides:
 *   reference   a photo the customer sent on THIS order (the designer sent it back);
 *               references staff attached do not count: often the last proof,
 *               given to the designer for a revision that rightly looks like it   BLOCKS
 *   other_order the newest artwork of the buyer's other orders                       BLOCKS
 *   recent_art  any artwork on another order of the business hashed in 30 days       BLOCKS
 *   orientation the file's shape contradicts the portrait/landscape ordered          WARNS
 *   auto_qc     Auto QC's judge reported wrongFile on exactly these files           BLOCKS
 * Files with no hash or no fine signature (PDF, HEIC, corrupt, not backfilled)
 * are never matched and never blocked.
 *
 * Which other-order files count (2026-10-27, Jerome: 4213333468's portrait was
 * also put on 4204560873 by mistake, and the RIGHT order could not be handed in):
 *   sent     the file went to its own customer (current when its order passed QC,
 *            or a final): blocks everyone, staff override as above
 *   unsent   still its order's current file, never past QC there: a designer's
 *            hand-in goes through with a heads-up naming the other order (the
 *            submit says which order the picture is for); QC pass still stops,
 *            so a person looks before anything reaches a customer
 *   stray    replaced on its order and never sent: not that order's art, ignored
 *
 * A block never overrides an owner on what the owner saw (Ayser 2026-10-22:
 * "dont override what i say"): an admin's QC pass goes through Auto QC's
 * finding with "<name> approved it" logged (confirmQcPassAndSend), and the
 * Approve screen shows a picture match before the tap and sends its own line
 * with the approval. A VA gives any word, "OK" included.
 */
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";

import { isAgentAssigned } from "@/lib/agent/ai-core";
import { isDesignerLike } from "@/lib/auth/roles";
import { withSystemContext, type RequestUser, type Tx } from "@/lib/db";
import { activityLog, assets, autoQcChecks, orderItems, orders } from "@/lib/db/schema";
import { orderNumberOf, loadSameBuyerContext, orientationOf } from "@/lib/orders/same-buyer";
import { loadProofFilePick } from "@/lib/proofs/files";
import { hashColumnsFor } from "@/lib/qc/asset-hash";
import { sameIds } from "@/lib/qc/auto-qc";
import { SAME_PICTURE_DISTANCE, aspectOf, hamming, samePicture } from "@/lib/qc/image-hash";

export const WRONG_FILE_OVERRIDE_ACTION = "order.wrong_file_override";
/** A designer handed in a picture that is also on another order where it has not gone out. */
export const WRONG_FILE_HEADS_UP_ACTION = "order.wrong_file_heads_up";
export const RECENT_ART_DAYS = 30;
/** Any word is enough (Ayser 2026-10-22, his "OK" was refused at 4): the owner's say goes. */
export const MIN_OVERRIDE_REASON = 1;

export type WrongFileKind = "reference" | "other_order" | "recent_art" | "orientation" | "auto_qc";

export type WrongFileReason = {
  kind: WrongFileKind;
  note: string;
  /** The asset that was checked. */
  assetId?: string;
  matchAssetId?: string;
  matchOrderNumber?: string;
  distance?: number;
  /** Share of inked pixels that differ (lib/qc/image-hash.ts inkDifference). */
  inkDiff?: number;
  /** other_order / recent_art: false when the matched file never went to its own customer. */
  matchSent?: boolean;
};

export type WrongFileResult = { blocked: boolean; reasons: WrongFileReason[] };

// ---------------------------------------------------------------------------
// Pure core (tested without a database)
// ---------------------------------------------------------------------------

export type HashedFile = { assetId: string; dhash: string | null; fineSig?: string | null; width?: number | null; height?: number | null };
/** sent false = the file never went to its own order's customer (unknown counts as sent). */
export type MatchCandidate = { assetId: string; dhash: string | null; fineSig?: string | null; orderNumber?: string; sent?: boolean };
/** A reference file; fromCustomer false = staff attached it, so it is never compared. */
export type ReferenceCandidate = MatchCandidate & { fromCustomer?: boolean };

export type WrongFileInput = {
  target: HashedFile;
  references: ReferenceCandidate[];
  siblings: MatchCandidate[];
  recent: MatchCandidate[];
  expectedOrientation: "portrait" | "landscape" | null;
};

type Match = { c: MatchCandidate; distance: number; inkDiff: number };

/** The candidate both looks call the same picture as the target, closest drawing first. */
function nearest(target: HashedFile, list: MatchCandidate[]): Match | null {
  let best: Match | null = null;
  for (const c of list) {
    const same = samePicture(target, c);
    if (same && (!best || same.inkDiff < best.inkDiff)) best = { c, ...same };
  }
  return best;
}

/** A sent match outranks an unsent one: it is the one that must block. */
function nearestSentFirst(target: HashedFile, list: MatchCandidate[]): Match | null {
  return nearest(target, list.filter((c) => c.sent !== false)) ?? nearest(target, list);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function evaluateWrongFile(input: WrongFileInput): WrongFileResult {
  const reasons: WrongFileReason[] = [];
  const { target } = input;
  if (target.dhash) {
    const ref = nearest(target, input.references.filter((r) => r.fromCustomer !== false));
    if (ref) {
      reasons.push({
        kind: "reference",
        note: "the customer's reference photo",
        assetId: target.assetId,
        matchAssetId: ref.c.assetId,
        distance: ref.distance,
        inkDiff: round3(ref.inkDiff),
      });
    }
    const used = new Set<string>();
    const sib = nearestSentFirst(target, input.siblings);
    if (sib) {
      used.add(sib.c.assetId);
      reasons.push({
        kind: "other_order",
        note: sib.c.orderNumber ? `${sib.c.orderNumber}'s artwork` : "another order's artwork",
        assetId: target.assetId,
        matchAssetId: sib.c.assetId,
        matchOrderNumber: sib.c.orderNumber,
        distance: sib.distance,
        inkDiff: round3(sib.inkDiff),
        ...(sib.c.sent === false ? { matchSent: false } : {}),
      });
    }
    const rec = nearestSentFirst(target, input.recent.filter((c) => !used.has(c.assetId)));
    // A sent recent match still blocks when the buyer's other order only matched unsent.
    if (rec && (!sib || (sib.c.sent === false && rec.c.sent !== false))) {
      reasons.push({
        kind: "recent_art",
        note: rec.c.orderNumber ? `artwork on order ${rec.c.orderNumber}` : "artwork on another order",
        assetId: target.assetId,
        matchAssetId: rec.c.assetId,
        matchOrderNumber: rec.c.orderNumber,
        distance: rec.distance,
        inkDiff: round3(rec.inkDiff),
        ...(rec.c.sent === false ? { matchSent: false } : {}),
      });
    }
  }
  const shape = aspectOf(target.width, target.height);
  if (input.expectedOrientation && (shape === "portrait" || shape === "landscape") && shape !== input.expectedOrientation) {
    reasons.push({
      kind: "orientation",
      note: `ordered as ${input.expectedOrientation} but this file is ${shape} (${target.width} x ${target.height})`,
      assetId: target.assetId,
    });
  }
  return { blocked: reasons.some((r) => r.kind !== "orientation"), reasons };
}

/** The plain refusal sentence for the reasons that block, or null when nothing blocks. */
export function wrongFileMessage(reasons: WrongFileReason[]): string | null {
  const blocking = reasons.find((r) => r.kind !== "orientation" && r.matchSent !== false) ?? reasons.find((r) => r.kind !== "orientation");
  if (!blocking) return null;
  const what =
    blocking.kind === "reference"
      ? "the customer's reference photo"
      : blocking.kind === "other_order"
        ? blocking.matchOrderNumber
          ? `${blocking.matchOrderNumber}'s artwork`
          : "another order's artwork"
        : blocking.kind === "recent_art"
          ? blocking.matchOrderNumber
            ? `artwork on order ${blocking.matchOrderNumber}`
            : "artwork on another order"
          : blocking.note;
  if (blocking.kind === "auto_qc") return `Auto QC says this is the wrong file: ${blocking.note}. Upload the right file for this order.`;
  // The same picture on an order where it has not gone out yet (2026-10-27): one of the two is the mix-up.
  const other = blocking.kind === "other_order" || blocking.kind === "recent_art" ? blocking.matchOrderNumber : null;
  if (blocking.matchSent === false) {
    return `The same picture is also on ${other ? `order ${other}` : "another order"}, where it has not gone to the customer yet. Check which order it belongs to before it goes out.`;
  }
  return `This file looks like ${what}. Upload the right file for this order.`;
}

/** A match a designer's hand-in does not stop on: the same picture on another order that never went out. */
export function isDesignerHeadsUp(r: WrongFileReason): boolean {
  return (r.kind === "other_order" || r.kind === "recent_art") && r.matchSent === false;
}

/** The note a designer sees with a hand-in that went through on a heads-up match. */
export function designerHeadsUpMessage(reasons: WrongFileReason[]): string | null {
  const where = [...new Set(reasons.filter(isDesignerHeadsUp).map((r) => (r.matchOrderNumber ? `order ${r.matchOrderNumber}` : "another order")))];
  if (!where.length) return null;
  return `The same picture is also on ${where.join(" and ")}. If it does not belong there, upload ${where.length === 1 ? "that order's" : "each order's"} own portrait on its card.`;
}

/**
 * The files a QC pass sends: one per portrait from the proof pick (what the
 * email and the proof page carry), else the newest per slot. Two untagged
 * files on a 2-portrait order share one slot key, so currentArtworkIds alone
 * checked only one of them.
 */
export async function outgoingArtworkIds(tx: Tx, orderId: string): Promise<string[]> {
  const picked = (await loadProofFilePick(tx, orderId)).files.map((f) => f.assetId);
  return picked.length ? picked : currentArtworkIds(tx, orderId);
}

/** Warnings only (never block): orientation. */
export function wrongFileWarnings(reasons: WrongFileReason[]): string[] {
  return reasons.filter((r) => r.kind === "orientation").map((r) => `Check the shape: ${r.note}.`);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** The newest artwork per portrait slot (item + unit), or the newest overall when no file is tagged. */
export async function currentArtworkIds(tx: Tx, orderId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: assets.id, itemId: assets.orderItemId, unit: assets.portraitUnit })
    .from(assets)
    .where(and(eq(assets.orderId, orderId), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
    .orderBy(desc(assets.createdAt));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const slot = `${r.itemId ?? ""}:${r.unit ?? 1}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    out.push(r.id);
  }
  return out;
}

type AssetRow = {
  id: string;
  storage: "cdn" | "r2";
  url: string | null;
  r2Key: string | null;
  dhash: string | null;
  fineSig: string | null;
  width: number | null;
  height: number | null;
};

const ASSET_COLUMNS = {
  id: assets.id,
  storage: assets.storage,
  url: assets.url,
  r2Key: assets.r2Key,
  dhash: assets.dhash,
  fineSig: assets.fineSig,
  width: assets.width,
  height: assets.height,
};

/** Files one check may give a fine signature on the spot; the backfill does the rest, and a file without one cannot match. */
const HASH_ON_THE_SPOT = 8;
/** Recent artworks within dHash reach that get the second look, nearest first. */
const RECENT_SECOND_LOOKS = 100;

/** The stored hashes, or ones computed now and saved (a file uploaded before migration 0060 or 0061). */
async function withHash(tx: Tx, row: AssetRow): Promise<AssetRow> {
  if (row.dhash && row.fineSig) return row;
  const cols = await hashColumnsFor(row);
  if (!cols.dhash) return row;
  await tx.update(assets).set(cols).where(eq(assets.id, row.id));
  return { ...row, ...cols };
}

/** Order moves that mean its current portrait went to the customer (QC pass and on). */
const SENT_ACTIONS = ["order.awaiting_approval", "order.approved", "order.printing", "order.shipped", "order.delivered", "order.complete"];
const SENT_STATUSES = new Set(["awaiting_approval", "approved", "printing", "shipped", "delivered", "complete"]);

export type SlotFile = { id: string; itemId: string | null; unit: number | null; createdAt: Date; deletedAt: Date | null };

/**
 * Did this file go to its own order's customer? A final did; a submission did
 * when its order passed QC (or moved on from there) while it was still the
 * newest file in its portrait slot. Pure (tested).
 */
export function wentToCustomer(file: SlotFile & { type: string }, slotFiles: SlotFile[], sentAt: Date[]): boolean {
  if (file.type === "final") return true;
  const slot = (f: SlotFile) => `${f.itemId ?? ""}:${f.unit ?? 1}`;
  return sentAt.some(
    (at) =>
      at > file.createdAt &&
      !slotFiles.some(
        (n) => n.id !== file.id && slot(n) === slot(file) && n.createdAt > file.createdAt && n.createdAt < at && (!n.deletedAt || n.deletedAt > at),
      ),
  );
}

export type MatchStanding = "sent" | "unsent" | "stray";

/**
 * Where each matched file stands on its own order: sent (that customer's
 * portrait), unsent (its order's current file, not out yet) or stray (replaced
 * there and never sent: not that order's art). Only matched files get here, so
 * this is a handful of reads at most.
 */
export async function standingOf(tx: Tx, ids: string[]): Promise<Map<string, MatchStanding>> {
  const out = new Map<string, MatchStanding>();
  if (!ids.length) return out;
  const rows = await tx
    .select({
      id: assets.id,
      orderId: assets.orderId,
      type: assets.type,
      itemId: assets.orderItemId,
      unit: assets.portraitUnit,
      createdAt: assets.createdAt,
      deletedAt: assets.deletedAt,
    })
    .from(assets)
    .where(inArray(assets.id, ids));
  for (const orderId of new Set(rows.map((r) => r.orderId))) {
    const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1);
    const current = new Set(await currentArtworkIds(tx, orderId));
    const slotFiles = await tx
      .select({ id: assets.id, itemId: assets.orderItemId, unit: assets.portraitUnit, createdAt: assets.createdAt, deletedAt: assets.deletedAt })
      .from(assets)
      .where(and(eq(assets.orderId, orderId), inArray(assets.type, ["submission", "final"])));
    const sentAt = (
      await tx
        .select({ at: activityLog.createdAt })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, orderId), inArray(activityLog.action, SENT_ACTIONS)))
    ).map((r) => r.at);
    for (const r of rows.filter((x) => x.orderId === orderId)) {
      const isCurrent = current.has(r.id);
      // An order past QC with no move logged (imported) still sent its current file.
      const sent = wentToCustomer(r, slotFiles, sentAt) || (isCurrent && !!order && SENT_STATUSES.has(order.status));
      out.set(r.id, sent ? "sent" : isCurrent ? "unsent" : "stray");
    }
  }
  return out;
}

/** Rows as stored, nothing computed. */
async function storedRows(tx: Tx, ids: string[]): Promise<AssetRow[]> {
  if (!ids.length) return [];
  return tx
    .select(ASSET_COLUMNS)
    .from(assets)
    .where(and(inArray(assets.id, ids), isNull(assets.deletedAt)));
}

/** Rows with both looks, computing (and saving) whatever is missing. */
export async function loadAssets(tx: Tx, ids: string[]): Promise<AssetRow[]> {
  return Promise.all((await storedRows(tx, ids)).map((r) => withHash(tx, r)));
}

/** Rows with a dHash, hashing the ones stored before migration 0060. */
async function withDhash(tx: Tx, rows: AssetRow[]): Promise<AssetRow[]> {
  return Promise.all(rows.map((r) => (r.dhash ? r : withHash(tx, r))));
}

/**
 * The candidates within dHash reach of the target, nearest first, ready for the
 * second look: one with no fine signature yet gets it now (and saved) while
 * the per-check budget lasts; past the budget it simply cannot match.
 */
async function inReach(tx: Tx, target: AssetRow, rows: AssetRow[], budget: { left: number }): Promise<AssetRow[]> {
  if (!target.dhash || !target.fineSig) return [];
  const near = rows
    .map((r) => ({ r, d: hamming(target.dhash, r.dhash) }))
    .filter((x) => x.d <= SAME_PICTURE_DISTANCE)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);
  return Promise.all(
    near.map((r) => {
      if (r.fineSig || budget.left <= 0) return r;
      budget.left--;
      return withHash(tx, r);
    }),
  );
}

/** The whole check inside a transaction that can see every order of the business (system context). */
export async function checkWrongFileTx(tx: Tx, orderId: string, assetId: string): Promise<WrongFileResult> {
  const [target] = await loadAssets(tx, [assetId]);
  if (!target) return { blocked: false, reasons: [] };
  const [order] = await tx
    .select({ businessId: orders.businessId, notes: orders.notes })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return { blocked: false, reasons: [] };
  const budget = { left: HASH_ON_THE_SPOT };

  // The buyer's other orders first: the incident road, so they get the budget first.
  const ctx = await loadSameBuyerContext(tx, orderId, { artwork: true });
  const sibIds = (ctx?.others ?? []).map((o) => o.artworkAssetId).filter((v): v is string => !!v);
  const sibNumbers = new Map((ctx?.others ?? []).filter((o) => o.artworkAssetId).map((o) => [o.artworkAssetId as string, o.number]));
  const siblings = (await inReach(tx, target, await withDhash(tx, await storedRows(tx, sibIds)), budget)).map((r) => ({
    assetId: r.id,
    dhash: r.dhash,
    fineSig: r.fineSig,
    orderNumber: sibNumbers.get(r.id),
  }));

  // Only photos the customer sent (uploaded_by null: the upload link or an importer).
  const refRows = await tx
    .select({ ...ASSET_COLUMNS, uploadedBy: assets.uploadedBy })
    .from(assets)
    .where(and(eq(assets.orderId, orderId), eq(assets.type, "reference"), isNull(assets.deletedAt)))
    .limit(30);
  const customerRefs = await withDhash(
    tx,
    refRows.filter((r) => r.uploadedBy === null),
  );
  const references = (await inReach(tx, target, customerRefs, budget)).map((r) => ({
    assetId: r.id,
    dhash: r.dhash,
    fineSig: r.fineSig,
    fromCustomer: true,
  }));

  // Recent artwork: scan the dHashes, then the second look for the nearest.
  const since = new Date(Date.now() - RECENT_ART_DAYS * 24 * 3600 * 1000);
  const recentRows = await tx
    .select({
      id: assets.id,
      dhash: assets.dhash,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
    })
    .from(assets)
    .innerJoin(orders, eq(orders.id, assets.orderId))
    .where(
      and(
        eq(assets.businessId, order.businessId),
        ne(assets.orderId, orderId),
        inArray(assets.type, ["submission", "final"]),
        isNull(assets.deletedAt),
        sql`${assets.dhash} is not null`,
        gte(assets.createdAt, since),
      ),
    )
    .orderBy(desc(assets.createdAt))
    .limit(20000);
  const nearIds = target.fineSig
    ? recentRows
        .map((r) => ({ id: r.id, d: hamming(target.dhash, r.dhash) }))
        .filter((x) => x.d <= SAME_PICTURE_DISTANCE)
        .sort((a, b) => a.d - b.d)
        .slice(0, RECENT_SECOND_LOOKS)
        .map((x) => x.id)
    : [];
  const recentNumbers = new Map(recentRows.map((r) => [r.id, orderNumberOf(r)]));
  const recent = (await inReach(tx, target, await storedRows(tx, nearIds), budget)).map((r) => ({
    assetId: r.id,
    dhash: r.dhash,
    fineSig: r.fineSig,
    orderNumber: recentNumbers.get(r.id),
  }));

  // Only the files that match get looked up on their own order: strays drop out, the rest say sent or not.
  const matched = [...new Set([...siblings, ...recent].filter((c) => samePicture(target, c)).map((c) => c.assetId))];
  const standing = await standingOf(tx, matched);
  const placed = <C extends MatchCandidate>(list: C[]): C[] =>
    list
      .filter((c) => standing.get(c.assetId) !== "stray")
      .map((c) => (standing.has(c.assetId) ? { ...c, sent: standing.get(c.assetId) === "sent" } : c));

  const lineRows = await tx
    .select({
      title: orderItems.title,
      variation: orderItems.variation,
      sku: orderItems.sku,
      options: orderItems.options,
      figureCount: orderItems.figureCount,
      style: orderItems.style,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .limit(60);

  return evaluateWrongFile({
    target: { assetId: target.id, dhash: target.dhash, fineSig: target.fineSig, width: target.width, height: target.height },
    references,
    siblings: placed(siblings),
    recent: placed(recent),
    expectedOrientation: orientationOf(lineRows, order.notes),
  });
}

/**
 * Is this file the wrong one for this order? Read-only lookups (hashes and
 * order numbers only, nothing about the buyer leaves) run in a system-context
 * transaction of their own, because a designer's row-level security hides the
 * other orders the file has to be compared with. Never throws: a failed lookup
 * must not stop real work, so it reads as "not blocked".
 */
export async function checkWrongFile(orderId: string, assetId: string): Promise<WrongFileResult> {
  try {
    return await withSystemContext((tx) => checkWrongFileTx(tx, orderId, assetId));
  } catch (error) {
    console.error("wrong-file check failed", orderId, assetId, error);
    return { blocked: false, reasons: [] };
  }
}

export type WrongFileRefusal = { code: "wrong_file"; message: string; reasons: WrongFileReason[] };

/**
 * Auto QC's wrongFile on the newest check, as a blocking reason, while the file
 * it flagged is still going out. Before 22 Oct one shared file was enough, so a
 * 2-portrait order stayed blocked after the flagged portrait was replaced and its
 * designer could not hand the fix in.
 */
async function autoQcReason(tx: Tx, orderId: string, assetIds: string[]): Promise<WrongFileReason | null> {
  const [row] = await tx
    .select({ assetIds: autoQcChecks.assetIds, portraits: autoQcChecks.portraits, wrongFile: autoQcChecks.wrongFile })
    .from(autoQcChecks)
    .where(eq(autoQcChecks.orderId, orderId))
    .orderBy(desc(autoQcChecks.createdAt))
    .limit(1);
  return autoQcWrongFileReason(row, assetIds);
}

export type AutoQcWrongFileCheck = { assetIds: unknown; portraits?: unknown; wrongFile: unknown };

/**
 * Does Auto QC's wrongFile still apply to these outgoing files? A note that
 * names its portrait ("Portrait 2 (other_order): ...", how the judge writes
 * them on 2+ portrait orders) applies while that portrait's judged file is
 * still going out; any other note applies only to exactly the files judged.
 * Pure (tested); the Approve screen uses the same rule (approveStopOf).
 */
export function autoQcWrongFileApplies(check: AutoQcWrongFileCheck | null | undefined, outgoing: string[]): boolean {
  const wf = check?.wrongFile as { note?: unknown } | null | undefined;
  if (!check || !wf || typeof wf !== "object") return false;
  const n = typeof wf.note === "string" ? /^\s*Portrait (\d+)\b/i.exec(wf.note)?.[1] : undefined;
  const portraits = Array.isArray(check.portraits) ? (check.portraits as { portrait?: unknown; assetId?: unknown }[]) : [];
  const flagged = n ? portraits.find((p) => Number(p?.portrait) === Number(n) && typeof p?.assetId === "string" && p.assetId) : undefined;
  if (flagged) return outgoing.includes(flagged.assetId as string);
  return sameIds(check.assetIds, [...new Set(outgoing)]);
}

/** autoQcReason's verdict as a blocking reason (tested). */
export function autoQcWrongFileReason(check: AutoQcWrongFileCheck | null | undefined, assetIds: string[]): WrongFileReason | null {
  if (!autoQcWrongFileApplies(check, assetIds)) return null;
  const wf = check!.wrongFile as { kind?: string; note?: string };
  return { kind: "auto_qc", note: String(wf.note || wf.kind || "not this order's artwork").slice(0, 300) };
}

/**
 * The one gate every road uses: null when the order's current artwork may go
 * on (nothing blocks, or staff gave an override reason, which is logged on the
 * order), else a refusal with the plain message. Designers and helpers never
 * override. `system` (importers, the AI Studio's own pipeline, cron) passes:
 * Auto QC's wrongFile and the owner's Approve check that work.
 * Orientation warnings never block; read them with wrongFileWarningsFor.
 */
export async function wrongFileGate(
  tx: Tx,
  actor: { id: string; role: RequestUser["role"] | "system" },
  input: {
    orderId: string;
    businessId: string;
    assetIds?: string[];
    overrideReason?: unknown;
    /** An owner's pass ("<name> approved it"): covers Auto QC's finding, which every QC screen shows; a picture match still needs overrideReason. */
    ownerApproval?: string;
    via: "submit" | "qc_pass";
    /** Filled with the heads-up a designer's hand-in went through with (shown once it is in). */
    warnings?: string[];
  },
): Promise<WrongFileRefusal | null> {
  if (actor.role === "system") return null;
  // The AI Studio's own submission is judged by Auto QC (wrongFile), not by this hash check.
  if (input.via === "submit" && (await isAgentAssigned(tx, input.orderId))) return null;
  // A QC pass checks every portrait's file going out, not only the first (portraits 2..N too).
  const ids = input.assetIds?.length
    ? input.assetIds
    : input.via === "qc_pass"
      ? await outgoingArtworkIds(tx, input.orderId)
      : await currentArtworkIds(tx, input.orderId);
  if (!ids.length) return null;
  const reasons: WrongFileReason[] = [];
  for (const id of ids) {
    const res = await checkWrongFile(input.orderId, id);
    reasons.push(...res.reasons.filter((r) => r.kind !== "orientation"));
  }
  const ai = await autoQcReason(tx, input.orderId, ids);
  if (ai) reasons.push(ai);
  if (!reasons.length) return null;

  // A designer's hand-in says which order the picture is for: the same picture on
  // another order that never went out is a heads-up, logged for QC, never a wall
  // (2026-10-27, Jerome). QC pass still stops on it, so a person looks first.
  if (input.via === "submit" && isDesignerLike(actor.role) && reasons.every(isDesignerHeadsUp)) {
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: actor.id,
      action: WRONG_FILE_HEADS_UP_ACTION,
      metadata: {
        via: input.via,
        matches: reasons.map((r) => ({
          kind: r.kind,
          assetId: r.assetId,
          matchAssetId: r.matchAssetId,
          matchOrderNumber: r.matchOrderNumber,
          distance: r.distance,
          inkDiff: r.inkDiff,
        })),
      },
    });
    const note = designerHeadsUpMessage(reasons);
    if (note) input.warnings?.push(note);
    return null;
  }

  const given = typeof input.overrideReason === "string" ? input.overrideReason.trim().replace(/\s+/g, " ").slice(0, 500) : "";
  const owner = actor.role === "admin" && reasons.every((r) => r.kind === "auto_qc") ? (input.ownerApproval ?? "").trim() : "";
  const reason = given || owner;
  if ((actor.role === "admin" || actor.role === "va") && reason.length >= MIN_OVERRIDE_REASON) {
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: actor.id,
      action: WRONG_FILE_OVERRIDE_ACTION,
      metadata: {
        reason,
        via: input.via,
        kinds: [...new Set(reasons.map((r) => r.kind))],
        matches: reasons.map((r) => ({
          kind: r.kind,
          assetId: r.assetId,
          matchAssetId: r.matchAssetId,
          matchOrderNumber: r.matchOrderNumber,
          distance: r.distance,
          inkDiff: r.inkDiff,
          note: r.note,
        })),
      },
    });
    return null;
  }
  return { code: "wrong_file", message: wrongFileMessage(reasons) ?? "This looks like the wrong file. Upload the right file for this order.", reasons };
}

/** Orientation warnings (and any block, for the screen to show first) for the order's current artwork. */
export async function wrongFileWarningsFor(orderId: string): Promise<{ warnings: string[]; blocking: string | null }> {
  const ids = await withSystemContext((tx) => currentArtworkIds(tx, orderId)).catch(() => [] as string[]);
  const reasons: WrongFileReason[] = [];
  for (const id of ids) reasons.push(...(await checkWrongFile(orderId, id)).reasons);
  return { warnings: wrongFileWarnings(reasons), blocking: wrongFileMessage(reasons) };
}
