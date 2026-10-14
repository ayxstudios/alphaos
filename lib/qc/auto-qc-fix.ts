/**
 * Auto QC fix samples (Yousif 2026-10-14): "On top of identifying the
 * problems ... provide a sample where you have gone and changed up the
 * portrait yourself to fix those things ... make sure not to change anything
 * else ... It should only be a suggestion but if I decide to send it instead
 * of the designers portrait then that should now be the portrait we work with."
 *
 * The agent (on the Mac) repaints only the flagged spots and posts the result
 * here; /approve shows it next to the designer's version. Nothing in this file
 * sends anything by itself: applyAiFixes runs only inside the owner's own
 * Approve tap ("Send AI fix"), where the fix becomes the order's newest
 * artwork version and the normal proof email carries it. Contract:
 * docs/AUTO_QC.md "Fix samples".
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import type { RequestUser, Tx } from "@/lib/db";
import { activityLog, assets, autoQcFixes, orders } from "@/lib/db/schema";
import { getAgentDesignerId } from "@/lib/agent/ai-core";
import { getOrderPortraits, slotKeyOf } from "@/lib/orders/portraits";
import { loadProofFilePick, type ProofFilePick } from "@/lib/proofs/files";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import { AUTO_QC_CHECKS, AUTO_QC_RESULTS, AUTO_QC_VERDICTS, latestSlots, type AutoQcCheck, type AutoQcVerdict } from "./auto-qc";
import { claimHolder, claimedMessage } from "./claims";
import type { QcVersion } from "./data";

/** Fix images are full print size (4800 x 6000 and up), so the cap is well above a phone photo's. */
export const MAX_FIX_BYTES = 40 * 1024 * 1024;

export type FixBox = { x0: number; y0: number; x1: number; y1: number };
/** One spot the AI repainted, and which Auto QC checks it answers. */
export type AutoQcFixArea = { keys: number[]; label: string; what: string; box: FixBox | null };
/** A flagged problem the AI did not touch, and why (e.g. the whole style is wrong). */
export type AutoQcFixMiss = { keys: number[]; label: string; why: string };

/** Auto QC's own look at a fix image (Yousif 2026-10-14: the Auto QC judges the AI fix too). */
export type AutoQcFixQc = { verdict: AutoQcVerdict; summary: string | null; checks: AutoQcCheck[]; at: string };

/** A ready fix as /approve shows it. */
export type AutoQcFixView = {
  id: string;
  portrait: number | null;
  sourceAssetId: string;
  url: string | null;
  width: number | null;
  height: number | null;
  fixed: AutoQcFixArea[];
  notFixed: AutoQcFixMiss[];
  summary: string | null;
  createdAt: string;
  /** Null until the Auto QC judge has looked at the fix itself. */
  qc: AutoQcFixQc | null;
};

export function fixKeyPrefix(orderId: string): string {
  return `qc-fix/${orderId}/`;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().replace(/[–—]/g, "-").slice(0, max) : "";
}

/** Auto QC check keys (lib/qc/auto-qc.ts); room above 11 so a new check never drops off a fix. */
function keysOf(v: unknown): number[] {
  return Array.isArray(v) ? [...new Set(v.map(Number).filter((k) => Number.isInteger(k) && k >= 1 && k <= 20))].sort((a, b) => a - b) : [];
}

function boxOf(v: unknown): FixBox | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const n = (k: string) => Math.min(1, Math.max(0, Number(b[k])));
  const box = { x0: n("x0"), y0: n("y0"), x1: n("x1"), y1: n("y1") };
  if (![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) || box.x1 <= box.x0 || box.y1 <= box.y0) return null;
  return box;
}

export function parseFixAreas(raw: unknown): AutoQcFixArea[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
    .filter((r): r is Record<string, unknown> => !!r)
    .map((r) => ({ keys: keysOf(r.keys), label: str(r.label, 120), what: str(r.what, 400), box: boxOf(r.box) }))
    .filter((a) => a.what || a.label)
    .slice(0, 12);
}

export function parseFixMisses(raw: unknown): AutoQcFixMiss[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
    .filter((r): r is Record<string, unknown> => !!r)
    .map((r) => ({ keys: keysOf(r.keys), label: str(r.label, 120), why: str(r.why, 400) }))
    .filter((m) => m.why || m.label)
    .slice(0, 12);
}

export type AutoQcFixBody = {
  orderId: string;
  autoQcId: string;
  sourceAssetId: string;
  portrait: number | null;
  status: "ready" | "failed";
  key: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  fixed: AutoQcFixArea[];
  notFixed: AutoQcFixMiss[];
  summary: string;
  model: string | null;
  engine: string | null;
};

/** Validate the agent's POST body. */
export function parseFixBody(raw: unknown): { ok: true; body: AutoQcFixBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  const r = raw as Record<string, unknown>;
  const orderId = str(r.orderId, 100);
  const autoQcId = str(r.autoQcId, 100);
  const sourceAssetId = str(r.sourceAssetId, 100);
  if (!orderId || !autoQcId || !sourceAssetId) return { ok: false, error: "orderId, autoQcId and sourceAssetId are required" };
  const status = r.status === "failed" ? "failed" : r.status === "ready" ? "ready" : null;
  if (!status) return { ok: false, error: "status must be ready or failed" };
  const portrait = r.portrait == null ? null : Number(r.portrait);
  if (portrait !== null && (!Number.isInteger(portrait) || portrait < 1)) return { ok: false, error: "portrait must be a positive integer or null" };
  const key = str(r.key, 300) || null;
  const contentType = str(r.contentType, 40) || null;
  const fixed = parseFixAreas(r.fixed);
  if (status === "ready") {
    if (!key || !key.startsWith(fixKeyPrefix(orderId))) return { ok: false, error: "key must be an upload key for this order" };
    if (!contentType || !/^image\/(jpeg|png)$/.test(contentType)) return { ok: false, error: "contentType must be image/jpeg or image/png" };
    if (!fixed.length) return { ok: false, error: "a ready fix lists what it fixed" };
  }
  const dim = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    ok: true,
    body: {
      orderId,
      autoQcId,
      sourceAssetId,
      portrait,
      status,
      key: status === "ready" ? key : null,
      contentType: status === "ready" ? contentType : null,
      width: dim(r.width),
      height: dim(r.height),
      fixed,
      notFixed: parseFixMisses(r.notFixed),
      summary: str(r.summary, 800),
      model: str(r.model, 60) || null,
      engine: str(r.engine, 40) || null,
    },
  };
}

/** Checks in the auto_qc_checks shape, validated: unknown keys and bad results are dropped. */
export function parseFixQcChecks(raw: unknown): AutoQcCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: AutoQcCheck[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    const key = Number(c?.key);
    const known = AUTO_QC_CHECKS.find((k) => k.key === key);
    const result = c?.result as AutoQcCheck["result"];
    if (!known || !AUTO_QC_RESULTS.includes(result)) continue;
    out.push({ key, label: str(c.label, 120) || known.label, result, note: str(c.note, 600) });
  }
  return out.sort((a, b) => a.key - b.key);
}

/** The fix's own Auto QC, as stored on the row (null until judged). */
export function fixQcOf(r: { qcVerdict: string | null; qcSummary: string | null; qcChecks: unknown; qcAt: Date | null }): AutoQcFixQc | null {
  if (!r.qcVerdict || !r.qcAt || !AUTO_QC_VERDICTS.includes(r.qcVerdict as AutoQcVerdict)) return null;
  return { verdict: r.qcVerdict as AutoQcVerdict, summary: r.qcSummary, checks: parseFixQcChecks(r.qcChecks), at: r.qcAt.toISOString() };
}

export type FixQcBody = {
  orderId: string;
  fixId: string;
  verdict: AutoQcVerdict;
  summary: string;
  checks: AutoQcCheck[];
  model: string | null;
};

/** Validate the judge's POST body for the Auto QC of a fix. */
export function parseFixQcBody(raw: unknown): { ok: true; body: FixQcBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  const r = raw as Record<string, unknown>;
  const orderId = str(r.orderId, 100);
  const fixId = str(r.fixId, 100);
  if (!orderId || !fixId) return { ok: false, error: "orderId and fixId are required" };
  const verdict = r.verdict as AutoQcVerdict;
  if (!AUTO_QC_VERDICTS.includes(verdict)) return { ok: false, error: "verdict must be pass, issues or unsure" };
  const checks = parseFixQcChecks(r.checks);
  if (verdict !== "unsure" && !checks.length) return { ok: false, error: "checks required unless the judge could not judge" };
  return { ok: true, body: { orderId, fixId, verdict, summary: str(r.summary, 800), checks, model: str(r.model, 60) || null } };
}

/** The newest version of every portrait slot, keyed by slot (null = the order's one portrait / untagged). */
export function latestBySlot(
  versions: QcVersion[],
  portraits: Parameters<typeof latestSlots>[1],
  pick?: ProofFilePick,
): Map<number | null, string> {
  return new Map(latestSlots(versions, portraits, pick).map((s) => [s.portrait, s.latest.id]));
}

/**
 * Ready fixes still painted on the newest version of their portrait (one per
 * slot, the newest), with a link the browser can open. Older ones are left
 * out: the designer uploaded again, so that fix no longer applies.
 */
export async function getFixViews(
  tx: Tx,
  orderId: string,
  versions: QcVersion[],
  portraits: Parameters<typeof latestSlots>[1],
  pick?: ProofFilePick,
): Promise<AutoQcFixView[]> {
  const latest = latestBySlot(versions, portraits, pick);
  const sources = [...latest.values()];
  if (!sources.length) return [];
  const rows = await tx
    .select()
    .from(autoQcFixes)
    .where(and(eq(autoQcFixes.orderId, orderId), eq(autoQcFixes.status, "ready"), inArray(autoQcFixes.sourceAssetId, sources)))
    .orderBy(desc(autoQcFixes.createdAt));
  const seen = new Set<string>();
  const out: AutoQcFixView[] = [];
  for (const r of rows) {
    if (seen.has(r.sourceAssetId) || latest.get(r.portrait) !== r.sourceAssetId) continue;
    seen.add(r.sourceAssetId);
    let url: string | null = null;
    if (r.r2Key && isR2Configured()) {
      try { url = await presignGet(r.r2Key); } catch { url = null; }
    }
    out.push({
      id: r.id,
      portrait: r.portrait,
      sourceAssetId: r.sourceAssetId,
      url,
      width: r.width,
      height: r.height,
      fixed: parseFixAreas(r.fixed),
      notFixed: parseFixMisses(r.notFixed),
      summary: r.summary,
      createdAt: r.createdAt.toISOString(),
      qc: fixQcOf(r),
    });
  }
  return out;
}

export type AppliedFix = { fixId: string; assetId: string; portrait: number | null; fixed: AutoQcFixArea[]; key: string };

/**
 * The owner chose the AI fix (inside their Approve tap): each fix becomes the
 * newest artwork version of its portrait, so the proof, the designer's card
 * and every later revision work from it. Refuses a fix whose designer version
 * is no longer the newest (the designer uploaded again meanwhile), and an order
 * the other owner has open (lib/qc/claims.ts), before anything is written.
 * Safe to repeat: a fix already applied whose version is still the newest
 * counts as applied, so Retry after a failed send goes through.
 */
export async function applyAiFixes(
  tx: Tx,
  user: RequestUser,
  orderId: string,
  fixIds: string[],
): Promise<{ ok: true; applied: AppliedFix[] } | { ok: false; code: string; message: string }> {
  const ids = [...new Set(fixIds)].slice(0, 12);
  if (!ids.length) return { ok: true, applied: [] };
  const [order] = await tx.select({ businessId: orders.businessId, status: orders.status }).from(orders).where(eq(orders.id, orderId)).for("update");
  if (!order) return { ok: false, code: "not_found", message: "This order could not be found." };
  if (order.status !== "awaiting_qc") return { ok: false, code: "stale", message: "Someone already checked this one." };
  const holder = await claimHolder(tx, orderId, user.id);
  if (holder) return { ok: false, code: "claimed", message: claimedMessage(holder.holder) };
  const rows = await tx.select().from(autoQcFixes).where(and(eq(autoQcFixes.orderId, orderId), inArray(autoQcFixes.id, ids)));
  if (rows.length !== ids.length || rows.some((r) => (r.status !== "ready" && r.status !== "used") || !r.r2Key)) {
    return { ok: false, code: "stale", message: "This AI fix is gone. Refresh to see the order now." };
  }
  // The newest designer version per slot, read inside this transaction with
  // the same grouping as the QC screens (lib/qc/auto-qc.ts latestSlots).
  const versionRows = await tx
    .select({
      id: assets.id,
      type: assets.type,
      orderItemId: assets.orderItemId,
      portraitUnit: assets.portraitUnit,
      createdAt: assets.createdAt,
    })
    .from(assets)
    .where(and(eq(assets.orderId, orderId), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt), asc(assets.id));
  const portraits = await getOrderPortraits(tx, orderId);
  const pick = await loadProofFilePick(tx, orderId, portraits);
  const portraitNo = new Map(portraits.map((p) => [p.key, p.n]));
  const versions: QcVersion[] = versionRows.map((v) => {
    const slotKey = slotKeyOf({ orderItemId: v.orderItemId, portraitUnit: v.portraitUnit });
    return {
      id: v.id,
      url: null,
      type: v.type,
      uploadedBy: null,
      createdAt: v.createdAt.toISOString(),
      portrait: pick.mode === "slots" ? (pick.slotOf[v.id] ?? null) : (slotKey && portraitNo.get(slotKey)) || null,
    };
  });
  const latest = latestBySlot(versions, portraits, pick);
  const source = new Map(versionRows.map((v) => [v.id, v]));
  for (const r of rows) {
    // Already applied by an earlier try of this same tap: fine while it is still the newest version.
    if (r.status === "used") {
      if (r.usedAssetId && latest.get(r.portrait) === r.usedAssetId) continue;
      return { ok: false, code: "stale", message: "This AI fix was already used. Refresh to see the order now." };
    }
    if (!source.has(r.sourceAssetId) || latest.get(r.portrait) !== r.sourceAssetId) {
      return { ok: false, code: "stale_asset", message: "The designer added a newer portrait, so this AI fix no longer applies. Check the new one." };
    }
  }
  const uploader = (await getAgentDesignerId(tx, order.businessId)) ?? user.id;
  const now = new Date();
  const applied: AppliedFix[] = [];
  for (const r of rows) {
    if (r.status === "used") {
      applied.push({ fixId: r.id, assetId: r.usedAssetId!, portrait: r.portrait, fixed: parseFixAreas(r.fixed), key: r.r2Key! });
      continue;
    }
    const src = source.get(r.sourceAssetId)!;
    const [asset] = await tx
      .insert(assets)
      .values({
        businessId: order.businessId,
        orderId,
        orderItemId: src.orderItemId,
        type: "submission",
        storage: "r2",
        r2Key: r.r2Key!,
        uploadedBy: uploader,
      })
      .returning({ id: assets.id });
    await tx
      .update(autoQcFixes)
      .set({ status: "used", usedAssetId: asset.id, decidedBy: user.id, decidedAt: now })
      .where(eq(autoQcFixes.id, r.id));
    const fixed = parseFixAreas(r.fixed);
    await tx.insert(activityLog).values({
      businessId: order.businessId,
      orderId,
      actorId: user.id,
      action: "qc.ai_fix_used",
      metadata: { fixId: r.id, sourceAssetId: r.sourceAssetId, assetId: asset.id, portrait: r.portrait, fixed: fixed.map((f) => f.label) },
    });
    applied.push({ fixId: r.id, assetId: asset.id, portrait: r.portrait, fixed, key: r.r2Key! });
  }
  return { ok: true, applied };
}

/**
 * "Add the AI fix as a picture for the designer" on Reject: each chosen fix
 * becomes a qc_feedback picture of this order (same stored file), so the
 * designer sees it beside the owner's note and gets its link on WhatsApp.
 */
export async function fixPictureAssets(tx: Tx, user: RequestUser, orderId: string, fixIds: string[]): Promise<string[]> {
  const ids = [...new Set(fixIds)].slice(0, 3);
  if (!ids.length) return [];
  const rows = await tx
    .select({ businessId: autoQcFixes.businessId, r2Key: autoQcFixes.r2Key, status: autoQcFixes.status })
    .from(autoQcFixes)
    .where(and(eq(autoQcFixes.orderId, orderId), inArray(autoQcFixes.id, ids)));
  const out: string[] = [];
  for (const r of rows) {
    if (!r.r2Key || (r.status !== "ready" && r.status !== "used")) continue;
    const [a] = await tx
      .insert(assets)
      .values({ businessId: r.businessId, orderId, type: "qc_feedback", storage: "r2", r2Key: r.r2Key, uploadedBy: user.id })
      .returning({ id: assets.id });
    out.push(a.id);
  }
  return out;
}
