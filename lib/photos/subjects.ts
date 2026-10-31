// The pet slots on the server (./subject-types.ts has the shape and why):
// which photos a check saw, the agent's photo check jobs and answers, a staff
// "the photo is fine", and the assignment gate.
//
// Delaney 4200623137 (CPS, Oct 2026): the order was for Jax and Rambo, her
// photos never showed Rambo's face clearly, the designer drew him from a guess
// and the clear photo she sent on 23 Oct never reached the card. Yousif
// (31 Oct): "Our job is to give the designers all the photos they need to
// create the portrait. Don't check after them after that." So the hold is at
// OUR step: an order with a pet that has no clear face photo is not given to a
// designer (staff need a reason, the agent parks it in awaiting_photos), and it
// goes on by itself when a check finds the photo or staff say the one she has
// is fine. A designer is never stopped or messaged about it.

import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { SYSTEM_ACTOR_ID, withSystemContext, type RequestUser, type Tx } from "@/lib/db";
import { activityLog, assets, businesses, exceptions, messages, orderItems, orders, users } from "@/lib/db/schema";
import { parseEtsyReceiptReview } from "@/lib/integrations/etsy/receipt-review";
import { liveOrderWhere } from "@/lib/orders/archive";
import { orderNumberOf } from "@/lib/orders/same-buyer";
import { MIN_OVERRIDE_REASON } from "@/lib/qc/wrong-file";
import { buyerWordsWhere } from "@/lib/reminders/buyer-replied";
import { headObject, isR2Configured, presignGetStable } from "@/lib/storage/r2";

import { holdingSubjects, joinNames, type PhotoSubject, type PhotoSubjects, type SubjectFace } from "./subject-types";

export const PHOTO_SUBJECTS_CHECKED_ACTION = "order.photo_subjects_checked";
export const PHOTO_SUBJECT_CLEARED_ACTION = "order.photo_subject_cleared";
export const PHOTO_SUBJECTS_OVERRIDE_ACTION = "order.photo_subjects_override";
export const PHOTO_SUBJECT_FILLED_ACTION = "order.photo_subject_filled";
/** A new order waited for its photo check past CHECK_WAIT_HOURS and was assigned unchecked. */
export const PHOTO_CHECK_MISSED_ACTION = "agent.photo_check_missed";

/** Statuses the photo check looks at: before anyone draws, while drawing, in QC. */
const CHECK_STATUSES = ["awaiting_photos", "ready_to_assign", "in_design", "awaiting_qc"] as const;
/** Waiting on her approval: looked at again only when a new photo arrives after an earlier check. */
const RECHECK_ONLY_STATUSES = ["awaiting_approval"] as const;
const CHECK_WINDOW_DAYS = 60;
const MAX_SUBJECTS = 24;

/** Same as lib/qc/data.ts resolveAssetUrl, kept here so the hand-in gate's module stays light. */
async function photoUrl(a: { url: string | null; storage: string; r2Key: string | null }): Promise<string | null> {
  if (a.url) return a.url;
  if (a.storage !== "r2" || !a.r2Key || !isR2Configured()) return null;
  return presignGetStable(a.r2Key).catch(() => null);
}

/** SQL condition on `orders`: a pet or person bought still has no clear face photo and no staff clear (holdingSubjects). */
export function photoHoldingWhere() {
  return sql`exists (select 1 from jsonb_array_elements(case jsonb_typeof(${orders.photoSubjects}->'subjects')
      when 'array' then ${orders.photoSubjects}->'subjects' else '[]'::jsonb end) s
    where coalesce(s->>'face', '') <> 'clear' and coalesce(jsonb_typeof(s->'cleared'), 'null') = 'null')`;
}

/** The set of reference photos a check saw. Order-free: the same photos always give the same answer. */
export function photoSigOf(assetIds: string[]): string {
  return crypto.createHash("sha1").update([...new Set(assetIds)].sort().join(",")).digest("hex").slice(0, 20);
}

export async function referenceIds(tx: Tx, orderId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.orderId, orderId), eq(assets.type, "reference"), isNull(assets.deletedAt)));
  return rows.map((r) => r.id);
}

const squash = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const sameName = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/^(your|the)\s+/, "").replace(/[^a-z0-9]+/g, "");
  return n(a) === n(b);
};
const FACES: SubjectFace[] = ["clear", "unclear", "none"];
const KINDS: PhotoSubject["kind"][] = ["pet", "person", "other"];

export type CleanCheck = { subjects: PhotoSubject[]; photos: Record<string, string[]>; extra: string[] };

/**
 * The agent's answer made safe to store: only this order's reference photos,
 * unique keys, a "clear" face always names the photo to draw it from (else it
 * is not clear), and which photo shows whom is derived from the subjects so
 * the two can never disagree.
 */
export function cleanSubjectCheck(input: { subjects?: unknown; extra?: unknown }, refIds: string[]): CleanCheck | { error: string } {
  if (!Array.isArray(input.subjects)) return { error: "subjects must be a list" };
  if (input.subjects.length > MAX_SUBJECTS) return { error: `at most ${MAX_SUBJECTS} subjects` };
  const known = new Set(refIds);
  const used = new Set<string>();
  const subjects: PhotoSubject[] = [];
  for (const raw of input.subjects) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "every subject must be an object" };
    const o = raw as Record<string, unknown>;
    const name = squash(o.name, 80);
    if (!name) return { error: "every subject needs a name" };
    const base = (squash(o.key, 40) || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `subject-${subjects.length + 1}`;
    let key = base;
    for (let i = 2; used.has(key); i++) key = `${base}-${i}`;
    used.add(key);
    const assetIds = Array.isArray(o.assetIds)
      ? [...new Set(o.assetIds.filter((a): a is string => typeof a === "string" && known.has(a)))]
      : [];
    let best = typeof o.bestAssetId === "string" && known.has(o.bestAssetId) ? o.bestAssetId : null;
    let face: SubjectFace = FACES.includes(o.face as SubjectFace) ? (o.face as SubjectFace) : "unclear";
    if (face === "clear" && !best) best = assetIds[0] ?? null;
    if (face === "clear" && !best) face = "unclear";
    if (best && !assetIds.includes(best)) assetIds.unshift(best);
    // In a photo but no face to draw from is "unclear"; "none" is only for one in no photo at all.
    if (face === "none" && assetIds.length) face = "unclear";
    subjects.push({
      key,
      name,
      kind: KINDS.includes(o.kind as PhotoSubject["kind"]) ? (o.kind as PhotoSubject["kind"]) : "other",
      description: squash(o.description, 200) || null,
      face,
      bestAssetId: best,
      assetIds,
      note: squash(o.note, 300) || null,
    });
  }
  const photos: Record<string, string[]> = {};
  for (const id of refIds) photos[id] = subjects.filter((s) => s.assetIds.includes(id)).map((s) => s.key);
  const extra = Array.isArray(input.extra) ? input.extra.map((e) => squash(e, 160)).filter(Boolean).slice(0, 10) : [];
  return { subjects, photos, extra };
}

/** A staff "the photo is fine" survives a new check of the same one (same key or same name) that still finds no clear face. */
export function keepStaffClears(prev: PhotoSubjects | null | undefined, next: PhotoSubject[]): PhotoSubject[] {
  const before = (prev?.subjects ?? []).filter((p) => p.cleared);
  if (!before.length) return next;
  return next.map((s) => {
    if (s.face === "clear") return s;
    const was = before.find((p) => p.key === s.key || sameName(p.name, s.name));
    return was?.cleared ? { ...s, cleared: was.cleared } : s;
  });
}

export type SaveSubjectsResult =
  | { ok: true; holding: string[]; subjects: number }
  | { ok: false; status: number; error: string; photoSig?: string };

/** Store the agent's photo check, refusing one about a set of photos that has since changed. */
export async function saveSubjectCheck(
  tx: Tx,
  input: { orderId: string; photoSig: unknown; model?: unknown; subjects?: unknown; extra?: unknown },
): Promise<SaveSubjectsResult> {
  const [order] = await tx
    .select({ id: orders.id, businessId: orders.businessId, photoSubjects: orders.photoSubjects })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for("update");
  if (!order) return { ok: false, status: 404, error: "order not found" };
  const refIds = await referenceIds(tx, order.id);
  const sig = photoSigOf(refIds);
  if (input.photoSig !== sig) return { ok: false, status: 409, error: "stale: the order's photos changed since the job was read", photoSig: sig };
  const clean = cleanSubjectCheck(input, refIds);
  if ("error" in clean) return { ok: false, status: 400, error: clean.error };
  const value: PhotoSubjects = {
    checkedAt: new Date().toISOString(),
    photoSig: sig,
    model: squash(input.model, 60) || null,
    subjects: keepStaffClears(order.photoSubjects, clean.subjects),
    photos: clean.photos,
    extra: clean.extra,
  };
  await tx.update(orders).set({ photoSubjects: value }).where(eq(orders.id, order.id));
  const holding = holdingSubjects(value).map((s) => s.name);
  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: order.id,
    actorId: null,
    action: PHOTO_SUBJECTS_CHECKED_ACTION,
    metadata: { subjects: value.subjects.map((s) => ({ name: s.name, face: s.face })), holding, photos: refIds.length, model: value.model },
  });
  await noteFilledSlots(tx, { orderId: order.id, businessId: order.businessId, before: order.photoSubjects, after: value });
  await releaseWhenClear(tx, { orderId: order.id, via: "photo_check" });
  return { ok: true, holding, subjects: value.subjects.length };
}

/** Statuses before a designer has the order: the hold applies here, and only here. */
export const BEFORE_DESIGNER = ["awaiting_details", "awaiting_photos", "ready_to_assign", "on_hold"] as const;

/**
 * A slot that was holding the order and now has a clear face photo, on an
 * order a designer already has: one plain line on the timeline ("New photo of
 * Rambo added, photo 7"). Nothing is sent to the designer (Yousif 2026-10-31).
 */
async function noteFilledSlots(
  tx: Tx,
  input: { orderId: string; businessId: string; before: PhotoSubjects | null | undefined; after: PhotoSubjects },
): Promise<void> {
  const was = holdingSubjects(input.before);
  if (!was.length) return;
  const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, input.orderId));
  if (!o || (BEFORE_DESIGNER as readonly string[]).includes(o.status)) return;
  const refs = await tx
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.orderId, input.orderId), eq(assets.type, "reference"), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt), asc(assets.id));
  for (const w of was) {
    const now = input.after.subjects.find((s) => s.key === w.key || sameName(s.name, w.name));
    if (!now || now.face !== "clear") continue;
    const n = now.bestAssetId ? refs.findIndex((r) => r.id === now.bestAssetId) + 1 : 0;
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: null,
      action: PHOTO_SUBJECT_FILLED_ACTION,
      metadata: { name: now.name, photoNumber: n || null, assetId: now.bestAssetId },
    });
  }
}

/**
 * An order parked in awaiting_photos for a pet's missing face photo goes on to
 * ready_to_assign by itself once no slot holds it (the move runs auto-assign).
 * A system move, logged like any other. Null when it did not move.
 */
export async function releaseWhenClear(tx: Tx, input: { orderId: string; via: "photo_check" | "staff_clear" }): Promise<boolean> {
  const [o] = await tx.select({ status: orders.status, photoSubjects: orders.photoSubjects }).from(orders).where(eq(orders.id, input.orderId));
  if (!o || o.status !== "awaiting_photos" || !o.photoSubjects?.subjects?.length || holdingSubjects(o.photoSubjects).length) return false;
  if (!(await referenceIds(tx, input.orderId)).length) return false;
  // Imported lazily: transitions -> assign -> this file.
  const { runTransition } = await import("@/lib/orders/transitions");
  await runTransition(tx, { id: SYSTEM_ACTOR_ID, role: "system" }, {
    orderId: input.orderId,
    to: "ready_to_assign",
    expectedFrom: "awaiting_photos",
    metadata: { via: "photo_subjects", reason: input.via === "staff_clear" ? "Every pet has a photo to draw from (staff said the photo is fine)." : "Every pet has a clear face photo." },
  });
  return true;
}

/**
 * Staff only: the photo she has is good enough for this one (she has no other,
 * or the check was wrong). Logged on the order; the slot stops holding it, and
 * an open "no clear face photo" card closes once no slot holds.
 */
export async function clearPhotoSubject(
  tx: Tx,
  user: RequestUser,
  input: { orderId: string; key: string; reason: unknown },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (user.role !== "admin" && user.role !== "va") return { ok: false, error: "Only staff can mark a photo as fine." };
  const reason = squash(input.reason, 300);
  if (reason.length < 3) return { ok: false, error: "Say in a few words why the photo is fine." };
  const [order] = await tx
    .select({ id: orders.id, businessId: orders.businessId, photoSubjects: orders.photoSubjects })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for("update");
  const ps = order?.photoSubjects;
  const slot = ps?.subjects?.find((s) => s.key === input.key);
  if (!order || !ps || !slot) return { ok: false, error: "That photo slot has changed. Reload the page." };
  if (slot.face === "clear" || slot.cleared) return { ok: true };
  // Name only: designers read the slot on their card, never a staff email.
  const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, user.id));
  const cleared = { by: user.id, byName: me?.name ?? null, at: new Date().toISOString(), reason };
  const next: PhotoSubjects = { ...ps, subjects: ps.subjects.map((s) => (s.key === slot.key ? { ...s, cleared } : s)) };
  await tx.update(orders).set({ photoSubjects: next }).where(eq(orders.id, order.id));
  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: order.id,
    actorId: user.id,
    action: PHOTO_SUBJECT_CLEARED_ACTION,
    metadata: { key: slot.key, name: slot.name, face: slot.face, reason },
  });
  if (!holdingSubjects(next).length) {
    await tx
      .update(exceptions)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: user.id, resolutionNote: `Photo marked fine: ${reason}` })
      .where(and(eq(exceptions.orderId, order.id), eq(exceptions.kind, "photo_subject_missing"), eq(exceptions.status, "open")));
    await releaseWhenClear(tx, { orderId: order.id, via: "staff_clear" });
  }
  return { ok: true };
}

/** How long a new order waits for its photo check before it is assigned unchecked (autopilot's CHECK_WAIT_HOURS). */
export const PHOTO_CHECK_WAIT_HOURS = 2;

export type PhotoStanding =
  /** Every pet has a clear face photo (or a staff clear), or nothing was bought that needs one. */
  | { state: "ok" }
  /** A pet or person has no clear face photo: the order is not given to a designer. */
  | { state: "held"; subjects: string[] }
  /** The photos were never checked (or changed since): wait for the check. */
  | { state: "unchecked_waiting" }
  /** Still unchecked after the wait: assign anyway and say so. */
  | { state: "unchecked_missed" };

/** What the assigning step should do about this order's pet photos. Read only. */
export async function photoStanding(tx: Tx, orderId: string, now: Date = new Date()): Promise<PhotoStanding> {
  const [o] = await tx.select({ photoSubjects: orders.photoSubjects, placedAt: orders.placedAt }).from(orders).where(eq(orders.id, orderId));
  if (!o) return { state: "ok" };
  const refs = await tx
    .select({ id: assets.id, createdAt: assets.createdAt })
    .from(assets)
    .where(and(eq(assets.orderId, orderId), eq(assets.type, "reference"), isNull(assets.deletedAt)));
  if (!refs.length) return { state: "ok" };
  const checked = o.photoSubjects && o.photoSubjects.photoSig === photoSigOf(refs.map((r) => r.id));
  if (checked) {
    const waiting = holdingSubjects(o.photoSubjects);
    return waiting.length ? { state: "held", subjects: waiting.map((s) => s.name) } : { state: "ok" };
  }
  const newest = Math.max(...refs.map((r) => new Date(r.createdAt).getTime()), o.placedAt ? new Date(o.placedAt).getTime() : 0);
  return now.getTime() - newest < PHOTO_CHECK_WAIT_HOURS * 3_600_000 ? { state: "unchecked_waiting" } : { state: "unchecked_missed" };
}

/**
 * True when the photo check has looked at the order's current photos and a
 * pet or person still has no clear face photo. The auto-moves out of
 * awaiting_photos leave such an order where it is; an unchecked order may move.
 */
export async function holdsPhotoSlot(tx: Tx, orderId: string): Promise<boolean> {
  return (await photoStanding(tx, orderId)).state === "held";
}

export type PhotoSubjectsRefusal = { code: "photo_subject_missing"; message: string };

export function photoSubjectsMessage(waiting: Pick<PhotoSubject, "name">[], orderNumber: string | null, fresh: boolean): string {
  const head = orderNumber ? `Order ${orderNumber}: ` : "";
  const what = `there is no clear face photo of ${joinNames(waiting.map((s) => s.name))} yet, so it cannot go to a designer.`;
  const next = fresh
    ? " We are getting one from the buyer, and the order goes on to a designer as soon as it lands on the card."
    : " A new photo just came in and is being checked: try again in about 20 minutes.";
  return `${head}${what[0].toUpperCase()}${what.slice(1)}${next}`;
}

/** "Waiting on a photo of Rambo": the one line the board card, order page and assign dialog show for a held order. */
export function waitingOnPhotoLine(waiting: Pick<PhotoSubject, "name">[]): string {
  return `Waiting on a photo of ${joinNames(waiting.map((s) => s.name))}`;
}

/**
 * The assignment gate: null when every pet and person bought has a clear face
 * photo (or a staff clear), when the order was never checked, or when admin or
 * va gave a reason (logged on the order). Designers never reach this. The
 * agent's own assigning is never stopped here: runAutoAssign parks the order
 * instead (lib/orders/assign.ts).
 */
export async function photoSubjectsGate(
  tx: Tx,
  actor: { id: string; role: RequestUser["role"] | "system" },
  input: { orderId: string; businessId: string; overrideReason?: unknown; via: "assign" },
): Promise<PhotoSubjectsRefusal | null> {
  if (actor.role === "system") return null;
  const [order] = await tx
    .select({ photoSubjects: orders.photoSubjects, platformOrderName: orders.platformOrderName, platformOrderId: orders.platformOrderId })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  const waiting = holdingSubjects(order?.photoSubjects);
  if (!order || !waiting.length) return null;
  const reason = typeof input.overrideReason === "string" ? input.overrideReason.trim().replace(/\s+/g, " ").slice(0, 500) : "";
  if ((actor.role === "admin" || actor.role === "va") && reason.length >= MIN_OVERRIDE_REASON) {
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: actor.id,
      action: PHOTO_SUBJECTS_OVERRIDE_ACTION,
      metadata: { reason, via: input.via, subjects: waiting.map((s) => s.name) },
    });
    return null;
  }
  const fresh = order.photoSubjects?.photoSig === photoSigOf(await referenceIds(tx, input.orderId));
  return { code: "photo_subject_missing", message: photoSubjectsMessage(waiting, orderNumberOf(order), fresh) };
}

// ---------------------------------------------------------------------------
// Jobs for the agent's photo check (GET /api/agent-photos/subjects).

export type SubjectJobPhoto = {
  assetId: string;
  n: number;
  url: string | null;
  name: string | null;
  createdAt: string;
  width: number | null;
  height: number | null;
  /** The stored file's md5 (R2 ETag of a single-part upload); only when asked for. */
  md5?: string | null;
};

export type SubjectJob = {
  orderId: string;
  orderNumber: string;
  businessId: string;
  businessName: string;
  status: string;
  placedAt: string | null;
  orderSays: {
    items: { title: string | null; productType: string | null; quantity: number | null; figureCount: number | null; options: { name: string; value: string }[] }[];
    personalization: string | null;
    buyerNote: string | null;
    notes: string | null;
  };
  /** Her own words on the order (email replies, Etsy messages), newest last. */
  buyerWrote: { at: string; text: string }[];
  photos: SubjectJobPhoto[];
  photoSig: string;
  previous: PhotoSubjects | null;
};

const STATUS_RANK: Record<string, number> = { awaiting_photos: 0, ready_to_assign: 0, in_design: 1, awaiting_qc: 2, awaiting_approval: 3 };

/** Orders whose photos were never checked, or changed since the last check, most urgent first. */
export async function listSubjectQueue(opts: { businessIds: string[] | null; limit: number }): Promise<string[]> {
  // A join, never a subquery in the select list: in a one-table select Drizzle
  // writes orders.id as a bare "id", which inside "from assets" means the
  // asset's own id, so every order read as having no photos and came back due
  // on every pass.
  const rows = await withSystemContext((tx) =>
    tx
      .select({
        id: orders.id,
        status: orders.status,
        at: sql<string>`coalesce(${orders.placedAt}, ${orders.createdAt})`,
        checkedSig: sql<string | null>`${orders.photoSubjects}->>'photoSig'`,
        refIds: sql<string[]>`array_agg(${assets.id})`,
      })
      .from(orders)
      .innerJoin(assets, and(eq(assets.orderId, orders.id), eq(assets.type, "reference"), isNull(assets.deletedAt)))
      .where(
        and(
          liveOrderWhere(),
          inArray(orders.status, [...CHECK_STATUSES, ...RECHECK_ONLY_STATUSES]),
          opts.businessIds?.length ? inArray(orders.businessId, opts.businessIds) : undefined,
          sql`coalesce(${orders.placedAt}, ${orders.createdAt}) > now() - make_interval(days => ${CHECK_WINDOW_DAYS})`,
        ),
      )
      .groupBy(orders.id),
  );
  const due = rows.filter((r) => {
    const sig = photoSigOf(r.refIds ?? []);
    if (r.checkedSig) return r.checkedSig !== sig;
    return (CHECK_STATUSES as readonly string[]).includes(r.status);
  });
  due.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || String(a.at).localeCompare(String(b.at)));
  return due.slice(0, opts.limit).map((r) => r.id);
}

/** Everything the photo check needs for one order: what was bought, her words, her photos. */
export async function buildSubjectJob(orderId: string, opts: { md5?: boolean } = {}): Promise<SubjectJob | null> {
  const base = await withSystemContext(async (tx) => {
    const [o] = await tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        businessName: businesses.name,
        status: orders.status,
        placedAt: orders.placedAt,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        notes: orders.notes,
        rawImport: orders.rawImport,
        photoSubjects: orders.photoSubjects,
      })
      .from(orders)
      .innerJoin(businesses, eq(businesses.id, orders.businessId))
      .where(eq(orders.id, orderId));
    if (!o) return null;
    const items = await tx
      .select({ title: orderItems.title, productType: orderItems.productType, quantity: orderItems.quantity, figureCount: orderItems.figureCount, options: orderItems.options })
      .from(orderItems)
      .where(eq(orderItems.orderId, o.id));
    const words = await tx
      .select({ at: messages.createdAt, body: messages.body })
      .from(messages)
      .where(and(eq(messages.orderId, o.id), buyerWordsWhere()))
      .orderBy(desc(messages.createdAt))
      .limit(8);
    const refs = await tx
      .select({ id: assets.id, url: assets.url, storage: assets.storage, r2Key: assets.r2Key, createdAt: assets.createdAt, width: assets.width, height: assets.height })
      .from(assets)
      .where(and(eq(assets.orderId, o.id), eq(assets.type, "reference"), isNull(assets.deletedAt)))
      .orderBy(asc(assets.createdAt), asc(assets.id));
    return { o, items, words, refs };
  });
  if (!base) return null;
  const { o, items, words, refs } = base;
  const receipt = parseEtsyReceiptReview(o.rawImport);
  const photos: SubjectJobPhoto[] = [];
  for (const [i, r] of refs.entries()) {
    let md5: string | null | undefined;
    if (opts.md5) {
      md5 = null;
      if (r.r2Key && isR2Configured()) {
        try {
          const tag = (await headObject(r.r2Key)).eTag?.replace(/"/g, "") ?? "";
          md5 = /^[0-9a-f]{32}$/i.test(tag) ? tag.toLowerCase() : null;
        } catch {
          md5 = null;
        }
      }
    }
    photos.push({
      assetId: r.id,
      n: i + 1,
      url: await photoUrl(r),
      name: r.r2Key ? r.r2Key.split("/").pop() ?? null : null,
      createdAt: new Date(r.createdAt).toISOString(),
      width: r.width,
      height: r.height,
      ...(opts.md5 ? { md5 } : {}),
    });
  }
  return {
    orderId: o.id,
    orderNumber: orderNumberOf(o),
    businessId: o.businessId,
    businessName: o.businessName,
    status: o.status,
    placedAt: o.placedAt ? new Date(o.placedAt).toISOString() : null,
    orderSays: {
      items: items.map((it) => ({
        title: it.title,
        productType: it.productType,
        quantity: it.quantity,
        figureCount: it.figureCount,
        options: (Array.isArray(it.options) ? it.options : [])
          .filter((op) => op && String(op.value ?? "").trim() && !String(op.name ?? "").startsWith("_"))
          .map((op) => ({ name: String(op.name ?? ""), value: String(op.value ?? "").slice(0, 400) })),
      })),
      personalization: receipt.combinedPersonalization?.trim() || null,
      buyerNote: receipt.buyerNote?.trim() || null,
      notes: o.notes?.trim() || null,
    },
    buyerWrote: words
      .filter((w) => (w.body ?? "").trim())
      .reverse()
      .map((w) => ({ at: new Date(w.at).toISOString(), text: (w.body ?? "").replace(/\s+/g, " ").trim().slice(0, 600) })),
    photos,
    photoSig: photoSigOf(refs.map((r) => r.id)),
    previous: o.photoSubjects ?? null,
  };
}
