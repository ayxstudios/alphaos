/**
 * Auto QC (Yousif 2026-10-14): an AI pass over every order waiting for QC,
 * shown as a "Has been Auto QC'd" badge plus notes on /approve and the QC
 * screens. INTERMEDIATE STEP ONLY: nothing here approves, sends, fails or
 * moves an order; the owner still decides. Contract: docs/AUTO_QC.md.
 *
 * The judge runs outside the app (the agent, on the Mac) and talks to
 * /api/agent-qc/{queue,result}. Pure helpers first so the test and the routes
 * share one rule.
 */
import { and, desc, inArray, isNull, max } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, assets, autoQcChecks } from "@/lib/db/schema";
import type { OrderPortrait } from "@/lib/orders/portraits";
import type { QcVersion } from "./data";

/** Yousif's checks, keys stable (11 applies to revisions only, 12 to every portrait). */
export const AUTO_QC_CHECKS: { key: number; label: string }[] = [
  { key: 1, label: "Portrait style" },
  { key: 2, label: "Rings and jewellery" },
  { key: 3, label: "Tattoos" },
  { key: 4, label: "Visible text" },
  { key: 5, label: "Eye colour" },
  { key: 6, label: "Pet fur, markings and texture" },
  { key: 7, label: "Hair colour and style" },
  { key: 8, label: "Hands and fingers" },
  { key: 9, label: "Ear shape" },
  { key: 10, label: "Count of people, pets, hands, fingers" },
  { key: 11, label: "Revision done fully" },
  { key: 12, label: "Looks obviously AI" },
];

export const AUTO_QC_VERDICTS = ["pass", "issues", "unsure"] as const;
export type AutoQcVerdict = (typeof AUTO_QC_VERDICTS)[number];
export const AUTO_QC_RESULTS = ["pass", "fail", "na", "unsure"] as const;
export type AutoQcResult = (typeof AUTO_QC_RESULTS)[number];

export type AutoQcCheck = { key: number; label: string; result: AutoQcResult; note: string };
export type AutoQcPortrait = {
  /** 1-based portrait number on a 2+ portrait order, else null. */
  portrait: number | null;
  assetId: string;
  verdict: AutoQcVerdict;
  summary: string;
  checks: AutoQcCheck[];
};
export type AutoQcRevision = { done: "yes" | "partly" | "no"; missed: string[]; note: string };

export type AutoQcBody = {
  orderId: string;
  assetIds: string[];
  verdict: AutoQcVerdict;
  summary: string;
  portraits: AutoQcPortrait[];
  revision: AutoQcRevision | null;
  model: string | null;
};

/** What the screens show: the newest row and whether it judged the current artwork. */
export type AutoQcView = {
  id: string;
  verdict: AutoQcVerdict;
  summary: string | null;
  portraits: AutoQcPortrait[];
  revision: AutoQcRevision | null;
  model: string | null;
  createdAt: string;
  /** False when the designer uploaded again after this check (a re-check is due). */
  current: boolean;
  /** Failed checks across every portrait. */
  issues: number;
};

/** One slot to judge: the newest version of a portrait and the one before it. */
export type AutoQcSlot = { portrait: number | null; latest: QcVersion; previous: QcVersion | null };

/**
 * The newest version per portrait, the same grouping the Approve screen uses:
 * a 2+ portrait order whose designer tagged uploads is judged per portrait
 * (plus any untagged uploads as their own group); otherwise the order's newest
 * version is the one. Versions arrive oldest first.
 */
export function latestSlots(versions: QcVersion[], portraits: OrderPortrait[]): AutoQcSlot[] {
  const slot = (portrait: number | null, list: QcVersion[]): AutoQcSlot | null =>
    list.length ? { portrait, latest: list[list.length - 1], previous: list.length > 1 ? list[list.length - 2] : null } : null;
  if (portraits.length >= 2 && versions.some((v) => v.portrait)) {
    const slots = portraits.map((p) => slot(p.n, versions.filter((v) => v.portrait === p.n)));
    slots.push(slot(null, versions.filter((v) => !v.portrait)));
    return slots.filter((s): s is AutoQcSlot => !!s);
  }
  const one = slot(null, versions);
  return one ? [one] : [];
}

export function slotAssetIds(slots: AutoQcSlot[]): string[] {
  return slots.map((s) => s.latest.id).sort();
}

export function sameIds(a: unknown, b: string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const x = [...a].map(String).sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Validate the judge's POST body. Returns the clean body or an error message. */
export function parseAutoQcBody(raw: unknown): { ok: true; body: AutoQcBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body must be an object" };
  const r = raw as Record<string, unknown>;
  const orderId = str(r.orderId, 100);
  if (!orderId) return { ok: false, error: "orderId required" };
  if (!Array.isArray(r.assetIds) || r.assetIds.length === 0 || !r.assetIds.every((a) => typeof a === "string" && a))
    return { ok: false, error: "assetIds must be a non-empty string array" };
  const verdict = r.verdict as AutoQcVerdict;
  if (!AUTO_QC_VERDICTS.includes(verdict)) return { ok: false, error: "verdict must be pass, issues or unsure" };
  if (!Array.isArray(r.portraits) || r.portraits.length === 0) return { ok: false, error: "portraits required" };
  const portraits: AutoQcPortrait[] = [];
  for (const p of r.portraits as Record<string, unknown>[]) {
    if (!p || typeof p !== "object") return { ok: false, error: "bad portrait entry" };
    const pv = p.verdict as AutoQcVerdict;
    if (!AUTO_QC_VERDICTS.includes(pv)) return { ok: false, error: "portrait verdict must be pass, issues or unsure" };
    const n = p.portrait == null ? null : Number(p.portrait);
    if (n !== null && (!Number.isInteger(n) || n < 1)) return { ok: false, error: "portrait must be a positive integer or null" };
    if (!Array.isArray(p.checks)) return { ok: false, error: "checks must be an array" };
    const checks: AutoQcCheck[] = [];
    for (const c of p.checks as Record<string, unknown>[]) {
      const key = Number(c?.key);
      const known = AUTO_QC_CHECKS.find((k) => k.key === key);
      if (!known) return { ok: false, error: `unknown check key ${String(c?.key)}` };
      const result = c.result as AutoQcResult;
      if (!AUTO_QC_RESULTS.includes(result)) return { ok: false, error: `check ${key}: result must be pass, fail, na or unsure` };
      checks.push({ key, label: str(c.label, 120) || known.label, result, note: str(c.note, 600) });
    }
    checks.sort((a, b) => a.key - b.key);
    portraits.push({ portrait: n, assetId: str(p.assetId, 100), verdict: pv, summary: str(p.summary, 600), checks });
  }
  let revision: AutoQcRevision | null = null;
  if (r.revision && typeof r.revision === "object") {
    const rv = r.revision as Record<string, unknown>;
    const done = rv.done as AutoQcRevision["done"];
    if (!["yes", "partly", "no"].includes(done)) return { ok: false, error: "revision.done must be yes, partly or no" };
    const missed = Array.isArray(rv.missed) ? rv.missed.map((m) => str(m, 300)).filter(Boolean).slice(0, 20) : [];
    revision = { done, missed, note: str(rv.note, 600) };
  }
  return {
    ok: true,
    body: {
      orderId,
      assetIds: (r.assetIds as string[]).slice().sort(),
      verdict,
      summary: str(r.summary, 800),
      portraits,
      revision,
      model: str(r.model, 60) || null,
    },
  };
}

export function countIssues(portraits: AutoQcPortrait[]): number {
  return portraits.reduce((n, p) => n + p.checks.filter((c) => c.result === "fail").length, 0);
}

/** The newest auto QC per order, marked current when it judged the given asset ids. */
export async function getAutoQcViews(
  tx: Tx,
  current: Map<string, string[]>,
): Promise<Map<string, AutoQcView>> {
  const ids = [...current.keys()];
  const out = new Map<string, AutoQcView>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select()
    .from(autoQcChecks)
    .where(inArray(autoQcChecks.orderId, ids))
    .orderBy(desc(autoQcChecks.createdAt));
  for (const r of rows) {
    if (out.has(r.orderId)) continue;
    const portraits = (Array.isArray(r.portraits) ? r.portraits : []) as AutoQcPortrait[];
    out.set(r.orderId, {
      id: r.id,
      verdict: (AUTO_QC_VERDICTS.includes(r.verdict as AutoQcVerdict) ? r.verdict : "unsure") as AutoQcVerdict,
      summary: r.summary,
      portraits,
      revision: (r.revision as AutoQcRevision | null) ?? null,
      model: r.model,
      createdAt: r.createdAt.toISOString(),
      current: sameIds(r.assetIds, current.get(r.orderId) ?? []),
      issues: countIssues(portraits),
    });
  }
  return out;
}

/** Orders (from the given ids) that already have an auto QC on exactly these versions. */
export async function judgedOrderIds(tx: Tx, current: Map<string, string[]>): Promise<Set<string>> {
  const views = await getAutoQcViews(tx, current);
  return new Set([...views.entries()].filter(([, v]) => v.current).map(([id]) => id));
}

/** Store one judge result plus an activity row. Never touches order state. */
export async function insertAutoQc(tx: Tx, businessId: string, body: AutoQcBody): Promise<string> {
  const [row] = await tx
    .insert(autoQcChecks)
    .values({
      businessId,
      orderId: body.orderId,
      assetIds: body.assetIds,
      verdict: body.verdict,
      summary: body.summary || null,
      portraits: body.portraits,
      revision: body.revision,
      model: body.model,
    })
    .returning({ id: autoQcChecks.id });
  await tx.insert(activityLog).values({
    businessId,
    orderId: body.orderId,
    actorId: null,
    action: "qc.auto_checked",
    metadata: { verdict: body.verdict, issues: countIssues(body.portraits), autoQcId: row.id },
  });
  return row.id;
}

/** Newest auto QC for one order (used where only one order is on screen). */
export async function getAutoQcView(tx: Tx, orderId: string, currentIds: string[]): Promise<AutoQcView | null> {
  const m = await getAutoQcViews(tx, new Map([[orderId, currentIds]]));
  return m.get(orderId) ?? null;
}


/**
 * Badge views for a list of orders (the /qc queue cards). Cheaper than the
 * exact version match: a check counts as current when it is newer than the
 * order's newest upload, the same rule the judge's queue uses.
 */
export async function getAutoQcBadgeViews(tx: Tx, orderIds: string[]): Promise<Map<string, AutoQcView>> {
  const out = new Map<string, AutoQcView>();
  if (orderIds.length === 0) return out;
  const uploads = await tx
    .select({ orderId: assets.orderId, at: max(assets.createdAt) })
    .from(assets)
    .where(and(inArray(assets.orderId, orderIds), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
    .groupBy(assets.orderId);
  const lastUpload = new Map(uploads.map((u) => [u.orderId, u.at]));
  const views = await getAutoQcViews(tx, new Map(orderIds.map((id) => [id, []])));
  for (const [id, v] of views) {
    const up = lastUpload.get(id);
    out.set(id, { ...v, current: !up || new Date(v.createdAt) >= up });
  }
  return out;
}
