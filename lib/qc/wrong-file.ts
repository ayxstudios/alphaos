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
 *   auto_qc     Auto QC's judge reported wrongFile for this file                     BLOCKS
 * Files with no hash or no fine signature (PDF, HEIC, corrupt, not backfilled)
 * are never matched and never blocked.
 */
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";

import { isAgentAssigned } from "@/lib/agent/ai-core";
import { withSystemContext, type RequestUser, type Tx } from "@/lib/db";
import { activityLog, assets, autoQcChecks, orderItems, orders } from "@/lib/db/schema";
import { orderNumberOf, loadSameBuyerContext, orientationOf } from "@/lib/orders/same-buyer";
import { hashColumnsFor } from "@/lib/qc/asset-hash";
import { SAME_PICTURE_DISTANCE, aspectOf, hamming, samePicture } from "@/lib/qc/image-hash";

export const WRONG_FILE_OVERRIDE_ACTION = "order.wrong_file_override";
export const RECENT_ART_DAYS = 30;
export const MIN_OVERRIDE_REASON = 4;

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
};

export type WrongFileResult = { blocked: boolean; reasons: WrongFileReason[] };

// ---------------------------------------------------------------------------
// Pure core (tested without a database)
// ---------------------------------------------------------------------------

export type HashedFile = { assetId: string; dhash: string | null; fineSig?: string | null; width?: number | null; height?: number | null };
export type MatchCandidate = { assetId: string; dhash: string | null; fineSig?: string | null; orderNumber?: string };
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
    const sib = nearest(target, input.siblings);
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
      });
    }
    const rec = nearest(target, input.recent.filter((c) => !used.has(c.assetId)));
    if (rec && !sib) {
      reasons.push({
        kind: "recent_art",
        note: rec.c.orderNumber ? `artwork on order ${rec.c.orderNumber}` : "artwork on another order",
        assetId: target.assetId,
        matchAssetId: rec.c.assetId,
        matchOrderNumber: rec.c.orderNumber,
        distance: rec.distance,
        inkDiff: round3(rec.inkDiff),
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
  const blocking = reasons.find((r) => r.kind !== "orientation");
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
  return blocking.kind === "auto_qc"
    ? `Auto QC says this is the wrong file: ${blocking.note}. Upload the right file for this order.`
    : `This file looks like ${what}. Upload the right file for this order.`;
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
    siblings,
    recent,
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

/** Auto QC's wrongFile for the newest judged row that covers one of these assets, as a blocking reason. */
async function autoQcReason(tx: Tx, orderId: string, assetIds: string[]): Promise<WrongFileReason | null> {
  const [row] = await tx
    .select({ assetIds: autoQcChecks.assetIds, wrongFile: autoQcChecks.wrongFile })
    .from(autoQcChecks)
    .where(eq(autoQcChecks.orderId, orderId))
    .orderBy(desc(autoQcChecks.createdAt))
    .limit(1);
  const wf = row?.wrongFile as { kind?: string; note?: string } | null | undefined;
  if (!row || !wf || typeof wf !== "object") return null;
  const judged = Array.isArray(row.assetIds) ? (row.assetIds as unknown[]) : [];
  if (!assetIds.some((id) => judged.includes(id))) return null; // a newer upload than the one Auto QC flagged
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
  input: { orderId: string; businessId: string; assetIds?: string[]; overrideReason?: unknown; via: "submit" | "qc_pass" },
): Promise<WrongFileRefusal | null> {
  if (actor.role === "system") return null;
  // The AI Studio's own submission is judged by Auto QC (wrongFile), not by this hash check.
  if (input.via === "submit" && (await isAgentAssigned(tx, input.orderId))) return null;
  const ids = input.assetIds?.length ? input.assetIds : await currentArtworkIds(tx, input.orderId);
  if (!ids.length) return null;
  const reasons: WrongFileReason[] = [];
  for (const id of ids) {
    const res = await checkWrongFile(input.orderId, id);
    reasons.push(...res.reasons.filter((r) => r.kind !== "orientation"));
  }
  const ai = await autoQcReason(tx, input.orderId, ids);
  if (ai) reasons.push(ai);
  if (!reasons.length) return null;

  const reason = typeof input.overrideReason === "string" ? input.overrideReason.trim().replace(/\s+/g, " ").slice(0, 500) : "";
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
