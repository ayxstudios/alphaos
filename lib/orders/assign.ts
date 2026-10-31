import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import {
  businesses,
  designerBusinesses,
  designerProfiles,
  users,
  assignments,
  assets,
  orders,
  orderItems,
  earnings,
  activityLog,
  type StyleDailyLimit,
} from "@/lib/db/schema";
import { isSettledArchiveReason, liveOrderWhere } from "@/lib/orders/archive";
import { sendDesignerBrief } from "@/lib/notifications/designer-events";
import { findStyle, getAgentDesignerId, markQueuedForAgent } from "@/lib/agent/ai-core";
import { getAgentConfig } from "@/lib/agent/config";
import { getOrderPortraits } from "@/lib/orders/portraits";
import { loadOrderTotal, toOrderTotal, type OrderTotal } from "@/lib/orders/order-total";
import { routeDisneyPeople } from "@/lib/orders/disney-people";
import { fillRoutingStyles, hasRoutingStyles } from "@/lib/designers/styles";
import {
  loadReworkHold,
  reworkAllows,
  reworkBound,
  reworkKeeper,
  reworkStaysMessage,
  ReworkStaysError,
  setReworkMoveApproval,
  type ReworkHold,
} from "@/lib/orders/rework";
import {
  boardHolds,
  loadBoardHolder,
  onPersonsBoard,
  setBoardHandBack,
  staysOnBoardMessage,
  StaysOnBoardError,
} from "@/lib/orders/board-hold";
import { portraitStylesOf } from "@/lib/orders/portrait-item";
import { BEFORE_DESIGNER, PHOTO_CHECK_MISSED_ACTION, photoStanding, photoSubjectsGate } from "@/lib/photos/subjects";
import {
  coveredCount,
  coversStyles,
  missingStyles,
  STYLE_FALLBACK_ACTION,
  styleFallbackNote,
  stylesOfInput,
} from "@/lib/orders/order-styles";

export const DESIGNER_SLA_HOURS = 24;

/** Assignment is the last hard stop before a designer sees an order. */
/** True when the order carries at least one live reference photo (assets.type = reference, not deleted). */
export async function hasReferencePhoto(tx: Tx, orderId: string): Promise<boolean> {
  const [reference] = await tx
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.orderId, orderId), eq(assets.type, "reference"), isNull(assets.deletedAt)))
    .limit(1);
  return Boolean(reference);
}

export class ArchivedOrderError extends Error {
  constructor(orderId: string, reason: string) {
    super(`Order ${orderId} was archived as not owed (${reason}); a person has to reopen it before it is assigned.`);
    this.name = "ArchivedOrderError";
  }
}

/**
 * A pet or person bought has no clear face photo yet, so the order is not given
 * to a designer (Yousif 2026-10-31: "our job is to give the designers all the
 * photos they need"). Admin or va can assign with a reason. The agent never
 * throws this: runAutoAssign answers photosHeld and autopilot parks the order.
 */
export class PhotoSubjectsHeldError extends Error {
  code = "photo_subject_missing" as const;
  constructor(message: string) {
    super(message);
    this.name = "PhotoSubjectsHeldError";
  }
}

export class MissingReferencePhotoError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} cannot be assigned until at least one reference photo is attached.`);
    this.name = "MissingReferencePhotoError";
  }
}

/**
 * The business's designer deadlines (businesses.agent_config designerSlaHours /
 * revisionSlaHours / qcFailSlaHours / urgentRevisionSlaHours). Yousif
 * 2026-10-14: orders and customer revisions 24 h, PixArt new orders 48 h, a
 * failed QC 12 h, any revision on an urgent order 3 h.
 */
export async function businessSlaHours(
  tx: Tx,
  businessId: string,
): Promise<{ order: number; revision: number; qcFail: number; urgentRevision: number }> {
  const [b] = await tx
    .select({ agentConfig: businesses.agentConfig })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const cfg = getAgentConfig(b ?? null);
  return {
    order: cfg.designerSlaHours,
    revision: cfg.revisionSlaHours,
    qcFail: cfg.qcFailSlaHours,
    urgentRevision: cfg.urgentRevisionSlaHours,
  };
}

/**
 * Disney orders only ever go to a designer who draws Disney (Yousif
 * 2026-10-16: "Abdul should never get disney pet"). An order is Disney when a
 * line's style is a Disney style (PixArt "cartoon", CPS "Disney Pet" /
 * "Disneyfy People", any style naming Disney or Pixar) or its title names
 * Disney, Pixar or a cartoon pet, so an order with no style set is caught too.
 * CPS "Cartoon Portrait" (people, not Disney) is not a Disney style.
 */
const DISNEY_STYLES = new Set(["cartoon", "disney pet", "disneyfy people"]);

export function isDisneyStyle(style: string | null | undefined): boolean {
  const s = style?.trim().toLowerCase() ?? "";
  return DISNEY_STYLES.has(s) || /disney|pixar/.test(s);
}

export function isDisneyOrder(items: { style?: string | null; title?: string | null }[]): boolean {
  return items.some((i) => isDisneyStyle(i.style) || /disney|pixar|cartoon pet|pet cartoon/i.test(i.title ?? ""));
}

/** Draws at least one Disney style (Wahyu, Febri and Mar today). */
export function drawsDisney(styles: string[] | null | undefined): boolean {
  return (styles ?? []).some(isDisneyStyle);
}

/** Titles of the Etsy receipt lines kept in orders.raw_import (legacy backfilled orders have no order_items rows). */
function rawImportTitles(raw: unknown): string[] {
  const transactions = (raw as { transactions?: unknown } | null)?.transactions;
  if (!Array.isArray(transactions)) return [];
  return transactions
    .map((t) => (t as { title?: unknown } | null)?.title)
    .filter((t): t is string => typeof t === "string");
}

export async function loadIsDisneyOrder(tx: Tx, orderId: string): Promise<boolean> {
  const items = await tx
    .select({ style: orderItems.style, title: orderItems.title })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (items.length) return isDisneyOrder(items);
  // No item rows (legacy backfill): the raw receipt still names the product, so a
  // Disney order is not mistaken for a plain one and handed to anyone.
  const [o] = await tx.select({ rawImport: orders.rawImport }).from(orders).where(eq(orders.id, orderId)).limit(1);
  return isDisneyOrder(rawImportTitles(o?.rawImport).map((title) => ({ title })));
}

/** Draws only Disney styles (Mar today): never a plain order. */
export function drawsOnlyDisney(styles: string[] | null | undefined): boolean {
  const list = (styles ?? []).filter((s) => s.trim());
  return list.length > 0 && list.every(isDisneyStyle);
}

/** Thrown by createAssignment when a Disney order would go to a designer who draws no Disney style. */
export class DisneyOnlyError extends Error {
  readonly code = "disney_only";
}

/** Why this designer may not have this order (a Disney order, a designer who draws no Disney style), or null. */
export async function disneyRefusal(tx: Tx, orderId: string, designerId: string): Promise<string | null> {
  if (!(await loadIsDisneyOrder(tx, orderId))) return null;
  const [d] = await tx
    .select({ name: users.name, styles: designerProfiles.styles })
    .from(users)
    .leftJoin(designerProfiles, eq(designerProfiles.userId, users.id))
    .where(eq(users.id, designerId))
    .limit(1);
  if (drawsDisney(d?.styles)) return null;
  return `This is a Disney order and ${d?.name ?? "that designer"} does not draw Disney. Only a designer who draws Disney can take it.`;
}

export type EligibilityRefusal = { code: "not_eligible"; message: string };

/**
 * The same routing rules auto-assign applies, for a person or a script picking
 * the designer by hand (reassignOrder). A Disney order is handled by
 * disneyRefusal; this covers the rest: a styled order only to a designer who
 * draws that style, a plain order never to a Disney-only designer (Mar), and the
 * AI Studio only where the order's style has the AI designer switched on (the
 * designer-only businesses and styles never do) and it needs one portrait.
 * Portraits in 2+ styles: a designer who draws every one of them, else
 * (nobody eligible does) one who draws the primary portrait's style.
 * Callers let an owner or admin override it.
 */
export async function eligibilityRefusal(
  tx: Tx,
  input: { orderId: string; businessId: string; designerId: string },
): Promise<EligibilityRefusal | null> {
  const [d] = await tx
    .select({ name: users.name, styles: designerProfiles.styles, isAgent: designerProfiles.isAgent })
    .from(users)
    .leftJoin(designerProfiles, eq(designerProfiles.userId, users.id))
    .where(eq(users.id, input.designerId))
    .limit(1);
  const who = d?.name ?? "that designer";
  const refuse = (message: string): EligibilityRefusal => ({ code: "not_eligible", message });

  const disney = await loadIsDisneyOrder(tx, input.orderId);
  // Every portrait's style (2026-10-29): one designer draws the whole order.
  const styles = await fillRoutingStyles(tx, input.businessId, input.orderId);
  const style = styles[0] ?? null;
  const both = styles.length === 2 ? "both" : "all of them";

  if (d?.isAgent) {
    if (disney) return refuse(`This is a Disney order and the AI Studio does not draw Disney. Give it to a Disney designer.`);
    if (styles.length > 1) {
      return refuse(`This order has portraits in ${styles.join(" and ")}, and the AI Studio draws one portrait per job. Give it to a designer who draws ${both}.`);
    }
    const styleRow = await findStyle(tx, input.businessId, style);
    if (!styleRow?.aiDesignerEnabled) {
      return refuse(
        style
          ? `The AI Studio is not switched on for ${style}. Give it to a designer who draws ${style}.`
          : "This order has no style yet, and the AI Studio only takes a style it is switched on for.",
      );
    }
    return null;
  }

  const missing = missingStyles(d?.styles, styles);
  // Portraits in 2+ styles, the same rule as auto-assign (rankForOrder): a
  // designer missing one is refused only while someone eligible draws every
  // style; with nobody like that, a designer who draws the primary portrait's
  // style may take it and draws the other one in its own style.
  const multi = async (gaps: string[]): Promise<EligibilityRefusal | null> => {
    const all = (await loadRankedCandidates(tx, { businessId: input.businessId, styles, orderId: input.orderId })).filter(
      (c) => c.designerId !== input.designerId,
    );
    if (all.length) {
      const named = await tx
        .select({ name: users.name })
        .from(users)
        .where(inArray(users.id, all.slice(0, 3).map((c) => c.designerId)));
      const names = named.map((n) => n.name ?? "a designer").join(" or ");
      return refuse(`${who} does not draw ${gaps.join(" or ")}. This order has portraits in ${styles.join(" and ")}: give it to ${names}, who draws ${both}.`);
    }
    const primary = styles[0];
    const drawsPrimary = coversStyles(d?.styles, [primary]) || (disney && isDisneyStyle(primary) && drawsDisney(d?.styles));
    if (drawsPrimary) return null;
    return refuse(
      `${who} does not draw ${primary}. Nobody free draws ${styles.join(" and ")} together, so it goes to a designer who draws ${primary}, the main portrait.`,
    );
  };
  if (disney) {
    // disneyRefusal already limits it to a Disney designer; a second portrait
    // in a plain style (Watercolor People next to a Disney Pet) still needs drawing.
    const plainGaps = styles.length > 1 ? missing.filter((s) => !isDisneyStyle(s)) : [];
    return plainGaps.length ? multi(plainGaps) : null;
  }
  if (drawsOnlyDisney(d?.styles)) {
    return refuse(`${who} draws only Disney and this is not a Disney order. Give it to a designer who draws ${style ?? "its style"}.`);
  }
  if (missing.length && styles.length > 1) return multi(missing);
  if (missing.length) return refuse(`${who} does not draw ${missing[0]}. Give it to a designer who does.`);
  return null;
}

export type RevisionKind = "qc_fail" | "customer";

/**
 * A revision gives the designer a fresh deadline: the active assignment's
 * due_at becomes now + qcFailSlaHours (QC fail, default 12) or revisionSlaHours
 * (customer change, default 24), capped at urgentRevisionSlaHours (default 3)
 * when the order is urgent. No active assignment = nothing to do. Returns the
 * new deadline, or null.
 */
export async function resetRevisionDeadline(
  tx: Tx,
  orderId: string,
  businessId: string,
  kind: RevisionKind,
): Promise<Date | null> {
  const sla = await businessSlaHours(tx, businessId);
  const [o] = await tx.select({ urgentAt: orders.urgentAt }).from(orders).where(eq(orders.id, orderId)).limit(1);
  let hours = kind === "qc_fail" ? sla.qcFail : sla.revision;
  if (o?.urgentAt) hours = Math.min(hours, sla.urgentRevision);
  const dueAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  const rows = await tx
    .update(assignments)
    .set({ dueAt })
    .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)))
    .returning({ id: assignments.id });
  return rows.length ? dueAt : null;
}

/**
 * The one place an assignment row is created. Deactivates any prior active
 * assignment, inserts the new one, and sends the designer their brief
 * (Alpha event `designer.brief`) — this is what makes "every assignment, auto
 * or manual, gets a brief" true without duplicating the send at every call
 * site. `reason` is shown in the brief text (e.g. "Reassigned from another
 * designer." on an SLA-sweep reassignment).
 */
export async function createAssignment(
  tx: Tx,
  input: {
    orderId: string;
    businessId: string;
    designerId: string;
    assignedBy: string | null;
    dueAtHours?: number;
    reason?: string | null;
    /** An owner's yes (who, and their words) to move a revision or failed QC to someone new (lib/orders/rework.ts). */
    ownerApproved?: string | null;
    /**
     * A person assigning by hand: refused (PhotoSubjectsHeldError) while a pet has no clear face
     * photo, unless admin or va give overrideReason. Left out = the agent, never stopped here.
     */
    photoGate?: { role: "admin" | "va" | "designer"; overrideReason?: string | null };
  },
): Promise<{ assignmentId: string; dueAt: Date }> {
  // Hard stop: a Disney order never goes to a designer who does not draw Disney.
  const refusal = await disneyRefusal(tx, input.orderId, input.designerId);
  if (refusal) throw new DisneyOnlyError(refusal);

  // Hard stop: a revision or failed QC stays with the designer who has it or
  // drew it unless an owner approved the move (Yousif 2026-10-16).
  const approval = input.ownerApproved?.trim() || null;
  const hold = await loadReworkHold(tx, input.orderId);
  const reworkMove = !reworkAllows(hold, input.designerId);
  if (reworkMove && !approval) throw new ReworkStaysError(await reworkStaysMessage(tx, hold));

  // Hard stop: an order on a person's board stays there unless an owner
  // approved the move (Yousif 2026-10-21, lib/orders/board-hold.ts).
  const holder = await loadBoardHolder(tx, input.orderId);
  const boardMove = boardHolds(holder, input.designerId);
  if (boardMove && !approval) throw new StaysOnBoardError(staysOnBoardMessage(holder));
  const needsApproval = reworkMove || boardMove;
  const handBack = onPersonsBoard(holder) && holder.designerId === input.designerId;

  const hours = input.dueAtHours ?? (await businessSlaHours(tx, input.businessId)).order;
  const dueAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  // Hard stop (Yousif 2026-10-18, "designers keep saying there's photos
  // missing"): no designer ever receives an order without a reference photo.
  if (!(await hasReferencePhoto(tx, input.orderId))) throw new MissingReferencePhotoError(input.orderId);

  // Hard stop (Yousif 2026-10-31): a pet or person with no clear face photo is
  // not given to a designer until the photo is on the card. Only before a
  // designer has the order, never on a rework or a hand-back, and never a
  // check on the designer after that. Admin or va may go on with a reason.
  if (input.photoGate && input.assignedBy) {
    const [st] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, input.orderId));
    if (st && (BEFORE_DESIGNER as readonly string[]).includes(st.status)) {
      const held = await photoSubjectsGate(
        tx,
        { id: input.assignedBy, role: input.photoGate.role },
        { orderId: input.orderId, businessId: input.businessId, overrideReason: input.photoGate.overrideReason, via: "assign" },
      );
      if (held) throw new PhotoSubjectsHeldError(held.message);
    }
  }

  // An assigned order is live work (audit 2026-10-25: #CPS10281 sat archived
  // on Slamet's board with a revision owed, so no live-only view saw it). An
  // archive settled on purpose ("not needed", duplicate, "ignore this order")
  // refuses; any other archive is lifted here, on the record.
  const [arch] = await tx
    .select({ archivedAt: orders.archivedAt, archiveReason: orders.archiveReason })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);
  if (arch?.archivedAt) {
    if (isSettledArchiveReason(arch.archiveReason)) throw new ArchivedOrderError(input.orderId, arch.archiveReason ?? "");
    await tx.update(orders).set({ archivedAt: null, archiveReason: null }).where(eq(orders.id, input.orderId));
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: input.assignedBy,
      action: "order.unarchived_on_assign",
      metadata: { archivedAt: arch.archivedAt.toISOString(), archiveReason: arch.archiveReason ?? null, designerId: input.designerId },
    });
  }

  // The approval opens the database guards (migrations 0063 and 0064) for this
  // one move only; a hand-back to the same designer opens 0064 for that alone.
  if (needsApproval && approval) await setReworkMoveApproval(tx, approval);
  if (handBack) await setBoardHandBack(tx, input.orderId, input.designerId);
  await tx
    .update(assignments)
    .set({ active: false })
    .where(and(eq(assignments.orderId, input.orderId), eq(assignments.active, true)));
  const [row] = await tx
    .insert(assignments)
    .values({
      businessId: input.businessId,
      orderId: input.orderId,
      designerId: input.designerId,
      assignedBy: input.assignedBy,
      dueAt,
      active: true,
    })
    .returning({ id: assignments.id });
  if (handBack) await setBoardHandBack(tx, input.orderId, null);
  if (needsApproval) await setReworkMoveApproval(tx, "");

  // The AI Studio agent has no phone or chat: it reads its jobs from the API.
  const [profile] = await tx
    .select({ isAgent: designerProfiles.isAgent, styles: designerProfiles.styles, name: users.name })
    .from(designerProfiles)
    .innerJoin(users, eq(users.id, designerProfiles.userId))
    .where(eq(designerProfiles.userId, input.designerId))
    .limit(1);
  if (!profile?.isAgent) {
    const styleNote = await noteStyleFallback(tx, {
      orderId: input.orderId,
      businessId: input.businessId,
      designerId: input.designerId,
      designerStyles: profile?.styles ?? [],
      designerName: profile?.name ?? null,
      actorId: input.assignedBy,
    });
    await sendDesignerBrief(tx, {
      orderId: input.orderId,
      designerId: input.designerId,
      dueAt,
      reason: input.reason ?? null,
      styleNote,
    });
  }

  return { assignmentId: row.id, dueAt };
}

/**
 * An order whose portraits are in 2+ styles went to a designer who does not
 * list them all (the primary-style fallback, or a move by hand): one
 * activity_log note on the order for the card, and the same words for the
 * brief. Written once per designer and wording. Null when they list every style.
 */
async function noteStyleFallback(
  tx: Tx,
  input: {
    orderId: string;
    businessId: string;
    designerId: string;
    designerStyles: string[];
    designerName: string | null;
    actorId: string | null;
  },
): Promise<string | null> {
  const styles = await portraitStylesOf(tx, input.orderId);
  if (styles.length < 2 || coversStyles(input.designerStyles, styles)) return null;
  const roster = await tx
    .select({ styles: designerProfiles.styles })
    .from(designerBusinesses)
    .innerJoin(users, and(eq(users.id, designerBusinesses.userId), eq(users.active, true), eq(users.role, "designer")))
    .innerJoin(designerProfiles, eq(designerProfiles.userId, designerBusinesses.userId))
    .where(and(eq(designerBusinesses.businessId, input.businessId), eq(designerProfiles.isAgent, false)));
  const nobodyListsAll = !roster.some((r) => coversStyles(r.styles, styles));
  const note = styleFallbackNote(styles, input.designerStyles, input.designerName, nobodyListsAll);
  if (!note) return null;
  const [last] = await tx
    .select({ metadata: activityLog.metadata })
    .from(activityLog)
    .where(and(eq(activityLog.orderId, input.orderId), eq(activityLog.action, STYLE_FALLBACK_ACTION)))
    .orderBy(sql`${activityLog.createdAt} desc`)
    .limit(1);
  const prior = (last?.metadata ?? null) as { designerId?: string; note?: string } | null;
  if (prior?.designerId !== input.designerId || prior?.note !== note) {
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: input.actorId,
      action: STYLE_FALLBACK_ACTION,
      metadata: {
        note,
        designerId: input.designerId,
        designerName: input.designerName,
        styles,
        missing: missingStyles(input.designerStyles, styles),
        nobodyListsAll,
      },
    });
  }
  return note;
}

export type Candidate = {
  designerId: string;
  styles: string[];
  /** Manual priority — LOWER wins. Set by staff on the Designers page. */
  rank: number;
  dailyCapacity: number;
  ordersAssignedToday: number;
  wipCount: number;
  onTimeRate30d: number; // 0..1
  /** 0 = no cap on work in flight (designer_profiles.max_active_orders). */
  maxActiveOrders: number;
  /**
   * The designer's per-style daily quota group matching this order's style +
   * business (designer_profiles.style_daily_limits), with how many of today's
   * assignments already fell in the group. Null = no quota for this style:
   * eligible as before, but ordered after quota-holding designers.
   * overflow = past the limit they stay eligible as if unquota'd (by rank).
   * An order in 2+ styles touches a group per style: combineQuotas folds them.
   */
  styleQuota?: { limit: number; priority: number; usedToday: number; overflow?: boolean } | null;
};

export type RankedCandidate = Candidate & {
  styleMatch: boolean;
  remainingCapacity: number;
  /** How many of the order's styles the designer lists. */
  covers: number;
};

/**
 * PURE ranker (no DB) — testable in isolation.
 *
 * Hard filters (all must pass to be eligible):
 *  1. Under the daily capacity (a limit of 15 = at most 15 assigned today).
 *  2. Under their max active orders (0 = no cap) — work currently in flight
 *     (in_design / awaiting_qc), so a designer with a lot on their plate isn't
 *     handed more even if today's count is still low.
 *  3. STRICT style match — when the order has a style, only designers who list
 *     that style are eligible; an order whose portraits are in 2+ styles goes
 *     only to a designer who lists EVERY one of them (one designer per order).
 *     An order with no style is open to everyone.
 *     (If no eligible designer exists the order stays unassigned — the caller
 *     surfaces it in the VA "Unassigned" tab.)
 *  4. Disney only — a Disney order (a Disney style, or `disney` from its
 *     titles when no style is set) goes only to a designer who draws Disney.
 *
 * `match: "primary"` is the fallback for 2+ styles nobody eligible draws all
 * of (rankForOrder): designers who list the PRIMARY style (styles[0]), most of
 * the order's styles first, then the order below. Never a Disney-only designer
 * for a plain primary.
 *
 * Order among the eligible: manual rank (asc) -> most remaining capacity ->
 * lowest work-in-progress -> best 30-day on-time rate.
 */
export function rankCandidates(
  candidates: Candidate[],
  order: { style?: string | null; styles?: string[] | null; disney?: boolean; match?: "all" | "primary" },
): RankedCandidate[] {
  const styles = stylesOfInput(order);
  const disney = !!order.disney || styles.some(isDisneyStyle);
  const primaryOnly = order.match === "primary" && styles.length > 1;
  const required = primaryOnly ? styles.slice(0, 1) : styles;
  const quotaOpen = (c: Candidate) => !c.styleQuota || c.styleQuota.usedToday < c.styleQuota.limit;

  const eligible = candidates
    .map((c) => ({
      ...c,
      styleMatch: required.length > 0 && coversStyles(c.styles, required),
      remainingCapacity: c.dailyCapacity - c.ordersAssignedToday,
      covers: coveredCount(c.styles, styles),
    }))
    .filter(
      (c) =>
        c.ordersAssignedToday < c.dailyCapacity &&
        (c.maxActiveOrders === 0 || c.wipCount < c.maxActiveOrders) &&
        // Under the per-style daily quota, when one covers this style
        // (an overflow group stays eligible past it, see quotaPriority).
        (quotaOpen(c) || !!c.styleQuota?.overflow) &&
        // Strict: a styled order goes only to a designer who draws every style.
        (styles.length === 0 || c.styleMatch) &&
        // A Disney order, styled or not, goes only to a Disney designer.
        (!disney || drawsDisney(c.styles)) &&
        // The fallback never hands a plain primary to a Disney-only designer.
        !(primaryOnly && !isDisneyStyle(required[0]) && drawsOnlyDisney(c.styles)),
    );

  // Designers holding a per-style quota for this style are served first, in
  // quota priority order (CPS house/venue: Jerome's 1, then Reza's 3, then
  // the unquota'd rest). With no quotas in play every key is equal and the
  // ordering is unchanged. An overflow holder past their limit sorts with the
  // unquota'd rest, by rank.
  const quotaPriority = (c: RankedCandidate) =>
    c.styleQuota && quotaOpen(c) ? c.styleQuota.priority : Number.MAX_SAFE_INTEGER;
  eligible.sort(
    (a, b) =>
      (primaryOnly ? b.covers - a.covers : 0) ||
      quotaPriority(a) - quotaPriority(b) ||
      a.rank - b.rank ||
      b.remainingCapacity - a.remainingCapacity ||
      a.wipCount - b.wipCount ||
      b.onTimeRate30d - a.onTimeRate30d,
  );

  return eligible;
}

/** The businesses a quota group's ONE pool spans: businessId plus any businessIds. */
export function quotaPool(g: Pick<StyleDailyLimit, "businessId" | "businessIds">): string[] {
  return [...new Set([g.businessId, ...(g.businessIds ?? [])].filter((b): b is string => !!b))];
}

/** A value-gated group (orderTotalOver) only takes orders above its line; an unknown total never qualifies. */
export function passesValueGate(
  g: Pick<StyleDailyLimit, "orderTotalOver" | "currency">,
  total: OrderTotal | null | undefined,
): boolean {
  if (g.orderTotalOver == null) return true;
  if (!total || !Number.isFinite(total.amount)) return false;
  if (g.currency && (total.currency ?? "").trim().toUpperCase() !== g.currency.trim().toUpperCase()) return false;
  return total.amount > g.orderTotalOver;
}

/**
 * The designer's quota group for this order: the first group whose pool holds
 * the order's business, whose styles hold its style (any case) and whose value
 * gate the order passes. Null = no quota for this order.
 */
export function quotaGroupFor(
  limits: StyleDailyLimit[] | null | undefined,
  order: { businessId: string; style: string | null; total?: OrderTotal | null },
): StyleDailyLimit | null {
  const key = order.style?.trim().toLowerCase() || null;
  if (!key) return null;
  return (
    (limits ?? []).find(
      (g) =>
        quotaPool(g).includes(order.businessId) &&
        g.styles.some((s) => s.trim().toLowerCase() === key) &&
        passesValueGate(g, order.total),
    ) ?? null
  );
}

/**
 * Every quota group an order touches: one per style it uses (the first match
 * for each, as quotaGroupFor), each group once. An order in two styles is
 * counted in each style's group (quotaUsed reads every item's style), so it
 * has to fit in each of them too.
 */
export function quotaGroupsFor(
  limits: StyleDailyLimit[] | null | undefined,
  order: { businessId: string; styles: string[]; total?: OrderTotal | null },
): StyleDailyLimit[] {
  const out: StyleDailyLimit[] = [];
  for (const style of order.styles) {
    const g = quotaGroupFor(limits, { businessId: order.businessId, style, total: order.total });
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

type QuotaState = NonNullable<Candidate["styleQuota"]>;

/**
 * One quota state from the groups an order touches. Any group full (and not
 * overflow) = that one, so the designer is out; any group full with overflow =
 * eligible as if unquota'd; all open = the best (lowest) priority. One group =
 * itself, so a single-style order is ranked exactly as before. Pure.
 */
export function combineQuotas(states: QuotaState[]): QuotaState | null {
  if (!states.length) return null;
  const full = states.filter((q) => q.usedToday >= q.limit);
  const hard = full.find((q) => !q.overflow);
  if (hard) return hard;
  if (full.length) return full[0];
  return [...states].sort((a, b) => a.priority - b.priority)[0];
}

/** One of a designer's assignments today, as a quota group sees it. */
export type QuotaUse = {
  assignmentId: string;
  businessId: string;
  style: string | null;
  total: OrderTotal | null;
  /** No earlier assignment exists for the order: a new order, not a reassignment or rescue. */
  firstForOrder: boolean;
};

/** How many of today's assignments fall in the group: its pool, its styles, its value gate, new orders only when set. */
export function quotaUsed(group: StyleDailyLimit, uses: QuotaUse[]): number {
  const pool = new Set(quotaPool(group));
  const names = new Set(group.styles.map((s) => s.trim().toLowerCase()));
  const counted = new Set<string>();
  for (const u of uses) {
    if (!pool.has(u.businessId) || !names.has(u.style?.trim().toLowerCase() ?? "")) continue;
    if (group.newOrdersOnly && !u.firstForOrder) continue;
    if (!passesValueGate(group, u.total)) continue;
    counted.add(u.assignmentId);
  }
  return counted.size;
}

/**
 * Ranked, eligible candidates for a business + style(s), straight from the DB.
 * `styles` (every portrait's style) wins over `style` (one style, older callers).
 * Shared by auto-assign (entry into ready_to_assign) and the SLA-sweep
 * reassign step (48 h, no submission) — `excludeDesignerId` drops the
 * currently-assigned designer so a reassignment never picks the same person.
 * `orderId` lets value-gated quota groups read the order's total; without it
 * (or with an unknown total) no value gate matches.
 */
export async function loadRankedCandidates(
  tx: Tx,
  input: {
    businessId: string;
    style?: string | null;
    styles?: string[] | null;
    excludeDesignerId?: string | null;
    orderId?: string | null;
    /** "primary" = the 2+ style fallback (rankCandidates). */
    match?: "all" | "primary";
  },
): Promise<RankedCandidate[]> {
  const styles = stylesOfInput(input);
  const roster = await tx
    .select({
      designerId: designerProfiles.userId,
      dailyCapacity: designerProfiles.dailyCapacity,
      styles: designerProfiles.styles,
      rank: designerProfiles.rank,
      maxActiveOrders: designerProfiles.maxActiveOrders,
      styleDailyLimits: designerProfiles.styleDailyLimits,
    })
    .from(designerBusinesses)
    .innerJoin(
      users,
      and(eq(users.id, designerBusinesses.userId), eq(users.active, true), eq(users.role, "designer")),
    )
    .innerJoin(designerProfiles, eq(designerProfiles.userId, designerBusinesses.userId))
    .where(
      and(
        eq(designerBusinesses.businessId, input.businessId),
        // The AI Studio agent is never a human candidate and never uses human capacity.
        eq(designerProfiles.isAgent, false),
        ...(input.excludeDesignerId ? [ne(designerProfiles.userId, input.excludeDesignerId)] : []),
      ),
    );

  if (!roster.length) return [];
  const ids = roster.map((r) => r.designerId);

  // assigned today
  const assignedToday = new Map<string, number>();
  for (const r of await tx
    .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(inArray(assignments.designerId, ids), gte(assignments.assignedAt, sql`date_trunc('day', now())`)))
    .groupBy(assignments.designerId)) {
    assignedToday.set(r.designerId, Number(r.n));
  }

  // work in progress (active assignments on actively-worked orders)
  const wip = new Map<string, number>();
  for (const r of await tx
    .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(
      and(
        eq(assignments.active, true),
        inArray(assignments.designerId, ids),
        inArray(orders.status, ["in_design", "awaiting_qc"]),
        liveOrderWhere(),
      ),
    )
    .groupBy(assignments.designerId)) {
    wip.set(r.designerId, Number(r.n));
  }

  // Per-style daily quota usage: for each designer whose style_daily_limits
  // holds a group covering this order (its business pool, its style, its value
  // gate), count today's assignments in that pool whose order style falls
  // inside the group (only an order's first assignment when newOrdersOnly).
  // An order in 2+ styles touches each style's group (combineQuotas).
  const total = input.orderId ? await loadOrderTotal(tx, input.orderId) : null;
  const quotaFor = new Map<string, QuotaState>();
  const holders = roster.flatMap((r) => {
    const groups = quotaGroupsFor(r.styleDailyLimits, { businessId: input.businessId, styles, total });
    return groups.length ? [{ designerId: r.designerId, groups }] : [];
  });
  if (holders.length) {
    const today = await tx
      .select({
        assignmentId: assignments.id,
        designerId: assignments.designerId,
        businessId: assignments.businessId,
        style: orderItems.style,
        total: orders.orderTotal,
        currency: orders.orderCurrency,
        firstForOrder: sql<boolean>`not exists (select 1 from assignments p where p.order_id = ${assignments.orderId} and (p.created_at < ${assignments.assignedAt} or (p.created_at = ${assignments.assignedAt} and p.id < ${assignments.id})))`,
      })
      .from(assignments)
      .innerJoin(orderItems, eq(orderItems.orderId, assignments.orderId))
      .innerJoin(orders, eq(orders.id, assignments.orderId))
      .where(
        and(
          inArray(
            assignments.designerId,
            holders.map((h) => h.designerId),
          ),
          inArray(assignments.businessId, [...new Set(holders.flatMap((h) => h.groups.flatMap(quotaPool)))]),
          gte(assignments.assignedAt, sql`date_trunc('day', now())`),
        ),
      );
    for (const h of holders) {
      const uses: QuotaUse[] = today
        .filter((r) => r.designerId === h.designerId)
        .map((r) => ({
          assignmentId: r.assignmentId,
          businessId: r.businessId,
          style: r.style,
          total: toOrderTotal(r.total, r.currency),
          firstForOrder: r.firstForOrder === true,
        }));
      const state = combineQuotas(
        h.groups.map((g) => ({ limit: g.limit, priority: g.priority, usedToday: quotaUsed(g, uses), overflow: g.overflow === true })),
      );
      if (state) quotaFor.set(h.designerId, state);
    }
  }

  // 30-day on-time rate (earnings.created_at ~= completion time)
  const onTime = new Map<string, number>();
  for (const r of await tx
    .select({
      designerId: earnings.designerId,
      total: sql<number>`count(*)::int`,
      ontime: sql<number>`count(*) filter (where ${earnings.createdAt} <= ${orders.dueAt})::int`,
    })
    .from(earnings)
    .innerJoin(orders, eq(orders.id, earnings.orderId))
    .where(and(inArray(earnings.designerId, ids), gte(earnings.createdAt, sql`now() - interval '30 days'`)))
    .groupBy(earnings.designerId)) {
    onTime.set(r.designerId, Number(r.total) ? Number(r.ontime) / Number(r.total) : 1);
  }

  const candidates: Candidate[] = roster.map((r) => ({
    designerId: r.designerId,
    styles: r.styles ?? [],
    rank: r.rank,
    dailyCapacity: r.dailyCapacity,
    ordersAssignedToday: assignedToday.get(r.designerId) ?? 0,
    wipCount: wip.get(r.designerId) ?? 0,
    onTimeRate30d: onTime.get(r.designerId) ?? 1,
    maxActiveOrders: r.maxActiveOrders,
    styleQuota: quotaFor.get(r.designerId) ?? null,
  }));

  const disney = styles.some(isDisneyStyle) || (input.orderId ? await loadIsDisneyOrder(tx, input.orderId) : false);
  return rankCandidates(candidates, { styles, disney, match: input.match });
}

/**
 * The ranking an order's portraits get (2026-10-29): a designer who draws
 * every style first; nobody eligible like that = the fallback, designers who
 * draw the primary portrait's style, most of the order's styles first
 * (fallback true), so a two-style order never strands because nobody lists
 * both. One style = loadRankedCandidates as before.
 */
export async function rankForOrder(
  tx: Tx,
  input: { businessId: string; styles: string[]; orderId?: string | null; excludeDesignerId?: string | null },
): Promise<{ ranked: RankedCandidate[]; fallback: boolean }> {
  const all = await loadRankedCandidates(tx, input);
  if (all.length || input.styles.length < 2) return { ranked: all, fallback: false };
  const primary = await loadRankedCandidates(tx, { ...input, match: "primary" });
  return { ranked: primary, fallback: primary.length > 0 };
}

/**
 * Runs when an order enters ready_to_assign. Builds candidates from the DB,
 * ranks them, and assigns the top one (deactivating any prior active
 * assignment). If nobody is eligible the order stays ready_to_assign with no
 * active assignment — it surfaces in the VA "Unassigned" tab.
 *
 * An order with portraits in 2+ styles (2026-10-29) goes to ONE designer, so
 * the buyer gets all her portraits together: one who draws every style, else
 * one who draws the primary portrait's style (rankForOrder; the order and the
 * brief carry a note saying so). Nobody for the primary either = unassigned,
 * and the autopilot card says why.
 *
 * A revision or failed QC never goes through the ranking: it goes back to the
 * designer who has it or drew it, at any load (keepRework). When none of them
 * can take it the order waits with reworkHeld set, for an owner to say who does.
 * An order already on a person's board stays with them (lib/orders/board-hold.ts).
 */
export async function runAutoAssign(
  tx: Tx,
  order: { orderId: string; businessId: string; assignedBy: string | null },
): Promise<{
  assigned: string | null;
  reworkHeld?: ReworkHold;
  missingPhoto?: boolean;
  noStyle?: boolean;
  styles?: string[];
  /** A pet or person has no clear face photo: nobody is picked; the caller parks the order in awaiting_photos. */
  photosHeld?: boolean;
  /** The names of the pets or people with no clear face photo (with photosHeld). */
  subjects?: string[];
  /** The photos have not been checked yet: nobody is picked; the next pass tries again. */
  photosUnchecked?: boolean;
}> {
  // No photo = nobody is picked and nothing throws: the caller parks the order
  // (autopilot raises a card, a transition still succeeds) until a reference
  // photo is attached, then the next pass assigns it.
  if (!(await hasReferencePhoto(tx, order.orderId))) return { assigned: null, missingPhoto: true };

  // The styles come off the order's PORTRAIT items, never an add-on line
  // (portrait-item.ts): every portrait's style, the primary first.
  let styles = await portraitStylesOf(tx, order.orderId);

  const hold = await loadReworkHold(tx, order.orderId);
  if (reworkBound(hold)) return keepRework(tx, order, hold, styles);

  // Already on a person's board: it stays there, never re-ranked away
  // (Yousif 2026-10-21, lib/orders/board-hold.ts).
  const holder = await loadBoardHolder(tx, order.orderId);
  if (onPersonsBoard(holder)) return { assigned: holder.designerId };

  // Our job is to give the designer every photo they need (Yousif 2026-10-31):
  // a pet or person with no clear face photo is not assigned; an order whose
  // photos were not checked yet waits for the check, then goes anyway.
  const standing = await photoStanding(tx, order.orderId);
  if (standing.state === "held") return { assigned: null, photosHeld: true, subjects: standing.subjects };
  if (standing.state === "unchecked_waiting") return { assigned: null, photosUnchecked: true };
  if (standing.state === "unchecked_missed") await noteCheckMissed(tx, order);

  // No style = no route (2026-10-23: CPS watercolor pets and couples saved with
  // no style went to whoever ranked first). Read it off the catalog; still none
  // in a business that has styles = nobody is picked and the caller raises it.
  // A Disney order keeps its Disney-only route even unstyled. A second
  // portrait with no style yet gets its own catalog style here too.
  styles = await fillRoutingStyles(tx, order.businessId, order.orderId);
  if (!styles.length && !(await loadIsDisneyOrder(tx, order.orderId)) && (await hasRoutingStyles(tx, order.businessId))) {
    return { assigned: null, noStyle: true };
  }

  // A PixArt Disney order whose buyer names a person becomes Disneyfy People,
  // so only the Disney people designer is offered it (Yousif 2026-10-21).
  if (await routeDisneyPeople(tx, order.orderId, order.businessId)) styles = await portraitStylesOf(tx, order.orderId);

  // A product with the AI designer switched on goes to the agent, not a human,
  // unless the order needs 2+ separate portraits (two lines, or one bought
  // twice): the AI draws one portrait per job, so those go to a person. A
  // Disney order never goes to the agent, only to a Disney designer.
  const agentId = await aiDesignerFor(tx, order.businessId, order.orderId, styles);
  if (agentId) {
    await queueForAgent(tx, order, agentId);
    return { assigned: agentId };
  }

  const { ranked } = await rankForOrder(tx, { businessId: order.businessId, styles, orderId: order.orderId });
  if (!ranked.length) return { assigned: null, styles };
  const chosen = ranked[0].designerId;

  await createAssignment(tx, {
    orderId: order.orderId,
    businessId: order.businessId,
    designerId: chosen,
    assignedBy: order.assignedBy,
  });

  return { assigned: chosen };
}

/** The wait for the photo check ran out and the order goes to a designer unchecked: said once on the order. */
async function noteCheckMissed(tx: Tx, order: { orderId: string; businessId: string }): Promise<void> {
  const [seen] = await tx
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(eq(activityLog.orderId, order.orderId), eq(activityLog.action, PHOTO_CHECK_MISSED_ACTION)))
    .limit(1);
  if (seen) return;
  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: order.orderId,
    actorId: null,
    action: PHOTO_CHECK_MISSED_ACTION,
    metadata: { note: "The photo check had not run, so the order was assigned without it." },
  });
}

/** The business's AI Studio when the AI may draw this order (one style, switched on, not Disney, one portrait); else null. */
async function aiDesignerFor(tx: Tx, businessId: string, orderId: string, styles: string[]): Promise<string | null> {
  // Portraits in 2+ styles are 2+ portraits: the AI draws one per job.
  if (styles.length > 1) return null;
  const styleRow = await findStyle(tx, businessId, styles[0] ?? null);
  if (!styleRow?.aiDesignerEnabled) return null;
  if (await loadIsDisneyOrder(tx, orderId)) return null;
  if ((await getOrderPortraits(tx, orderId)).length >= 2) return null;
  return getAgentDesignerId(tx, businessId);
}

async function queueForAgent(
  tx: Tx,
  order: { orderId: string; businessId: string; assignedBy: string | null },
  agentId: string,
): Promise<void> {
  await createAssignment(tx, {
    orderId: order.orderId,
    businessId: order.businessId,
    designerId: agentId,
    assignedBy: order.assignedBy,
  });
  await markQueuedForAgent(tx, {
    orderId: order.orderId,
    businessId: order.businessId,
    byUserId: order.assignedBy,
    via: "auto_assign",
  });
}

const REWORK_REASON = "This revision stays with you.";

/**
 * runAutoAssign for a revision or failed QC (Yousif 2026-10-16): back to the
 * designer who has it or drew it, never to the ranking and never to AI Studio
 * unless AI Studio drew it. Already theirs = same row and deadline, and a
 * brief so they know it is ready again (not when they moved it back
 * themselves). Nobody of theirs can take it = reworkHeld, for an owner.
 */
async function keepRework(
  tx: Tx,
  order: { orderId: string; businessId: string; assignedBy: string | null },
  hold: ReworkHold,
  styles: string[],
): Promise<{ assigned: string | null; reworkHeld?: ReworkHold }> {
  const keeper = await reworkKeeper(tx, order.businessId, hold);
  if (!keeper) return { assigned: null, reworkHeld: hold };

  // Someone else has it on their board: it stays with them (Yousif 2026-10-21).
  const holder = await loadBoardHolder(tx, order.orderId);
  if (boardHolds(holder, keeper.designerId)) return { assigned: holder!.designerId };

  if (keeper.isAgent) {
    const agentId = await aiDesignerFor(tx, order.businessId, order.orderId, styles);
    if (agentId !== keeper.designerId) return { assigned: null, reworkHeld: hold };
    await queueForAgent(tx, order, agentId);
    return { assigned: agentId };
  }

  if (await disneyRefusal(tx, order.orderId, keeper.designerId)) return { assigned: null, reworkHeld: hold };
  const [active] = await tx
    .select({ designerId: assignments.designerId, dueAt: assignments.dueAt })
    .from(assignments)
    .where(and(eq(assignments.orderId, order.orderId), eq(assignments.active, true)))
    .limit(1);
  if (active?.designerId === keeper.designerId) {
    if (order.assignedBy !== keeper.designerId) {
      await sendDesignerBrief(tx, { orderId: order.orderId, designerId: keeper.designerId, dueAt: active.dueAt, reason: REWORK_REASON });
    }
    return { assigned: keeper.designerId };
  }

  // Back on their board on a revision clock (capped for an urgent order), as resetRevisionDeadline sets it.
  const sla = await businessSlaHours(tx, order.businessId);
  const [o] = await tx.select({ urgentAt: orders.urgentAt }).from(orders).where(eq(orders.id, order.orderId)).limit(1);
  await createAssignment(tx, {
    orderId: order.orderId,
    businessId: order.businessId,
    designerId: keeper.designerId,
    assignedBy: order.assignedBy,
    dueAtHours: o?.urgentAt ? Math.min(sla.revision, sla.urgentRevision) : sla.revision,
    reason: REWORK_REASON,
  });
  return { assigned: keeper.designerId };
}

/**
 * The next eligible designer for an order, excluding whoever currently holds
 * it — used by the 48 h SLA-sweep reassignment. Same ranking as auto-assign.
 * Returns null when nobody else is eligible (the sweep then leaves the order
 * with its current designer and only pings the VA).
 */
export async function findNextEligibleDesigner(
  tx: Tx,
  input: { businessId: string; style?: string | null; styles?: string[] | null; excludeDesignerId: string; orderId?: string | null },
): Promise<string | null> {
  const { ranked } = await rankForOrder(tx, { ...input, styles: stylesOfInput(input) });
  return ranked[0]?.designerId ?? null;
}
