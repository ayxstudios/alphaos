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
  type StyleDailyLimit,
} from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { sendDesignerBrief } from "@/lib/notifications/designer-events";
import { findStyle, getAgentDesignerId, markQueuedForAgent } from "@/lib/agent/ai-core";
import { getAgentConfig } from "@/lib/agent/config";
import { getOrderPortraits } from "@/lib/orders/portraits";
import { loadOrderTotal, toOrderTotal, type OrderTotal } from "@/lib/orders/order-total";
import { routeDisneyPeople } from "@/lib/orders/disney-people";
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

export async function loadIsDisneyOrder(tx: Tx, orderId: string): Promise<boolean> {
  const items = await tx
    .select({ style: orderItems.style, title: orderItems.title })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  return isDisneyOrder(items);
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
  },
): Promise<{ assignmentId: string; dueAt: Date }> {
  // Hard stop: a Disney order never goes to a designer who does not draw Disney.
  const refusal = await disneyRefusal(tx, input.orderId, input.designerId);
  if (refusal) throw new DisneyOnlyError(refusal);

  // Hard stop: a revision or failed QC stays with the designer who has it or
  // drew it unless an owner approved the move (Yousif 2026-10-16).
  const approval = input.ownerApproved?.trim() || null;
  const hold = await loadReworkHold(tx, input.orderId);
  const needsApproval = !reworkAllows(hold, input.designerId);
  if (needsApproval && !approval) throw new ReworkStaysError(await reworkStaysMessage(tx, hold));

  const hours = input.dueAtHours ?? (await businessSlaHours(tx, input.businessId)).order;
  const dueAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  // Hard stop (Yousif 2026-10-18, "designers keep saying there's photos
  // missing"): no designer ever receives an order without a reference photo.
  if (!(await hasReferencePhoto(tx, input.orderId))) throw new MissingReferencePhotoError(input.orderId);

  await tx
    .update(assignments)
    .set({ active: false })
    .where(and(eq(assignments.orderId, input.orderId), eq(assignments.active, true)));
  // The approval opens the database guard (migration 0063) for this one insert only.
  if (needsApproval && approval) await setReworkMoveApproval(tx, approval);
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
  if (needsApproval) await setReworkMoveApproval(tx, "");

  // The AI Studio agent has no phone or chat: it reads its jobs from the API.
  const [profile] = await tx
    .select({ isAgent: designerProfiles.isAgent })
    .from(designerProfiles)
    .where(eq(designerProfiles.userId, input.designerId))
    .limit(1);
  if (!profile?.isAgent) {
    await sendDesignerBrief(tx, {
      orderId: input.orderId,
      designerId: input.designerId,
      dueAt,
      reason: input.reason ?? null,
    });
  }

  return { assignmentId: row.id, dueAt };
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
   */
  styleQuota?: { limit: number; priority: number; usedToday: number; overflow?: boolean } | null;
};

export type RankedCandidate = Candidate & {
  styleMatch: boolean;
  remainingCapacity: number;
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
 *     that style are eligible. An order with no style is open to everyone.
 *     (If no eligible designer exists the order stays unassigned — the caller
 *     surfaces it in the VA "Unassigned" tab.)
 *  4. Disney only — a Disney order (a Disney style, or `disney` from its
 *     titles when no style is set) goes only to a designer who draws Disney.
 *
 * Order among the eligible: manual rank (asc) -> most remaining capacity ->
 * lowest work-in-progress -> best 30-day on-time rate.
 */
export function rankCandidates(
  candidates: Candidate[],
  order: { style?: string | null; disney?: boolean },
): RankedCandidate[] {
  const style = order.style?.trim().toLowerCase() || null;
  const disney = !!order.disney || isDisneyStyle(style);
  const quotaOpen = (c: Candidate) => !c.styleQuota || c.styleQuota.usedToday < c.styleQuota.limit;

  const eligible = candidates
    .map((c) => ({
      ...c,
      styleMatch: !!style && c.styles.some((s) => s.trim().toLowerCase() === style),
      remainingCapacity: c.dailyCapacity - c.ordersAssignedToday,
    }))
    .filter(
      (c) =>
        c.ordersAssignedToday < c.dailyCapacity &&
        (c.maxActiveOrders === 0 || c.wipCount < c.maxActiveOrders) &&
        // Under the per-style daily quota, when one covers this style
        // (an overflow group stays eligible past it, see quotaPriority).
        (quotaOpen(c) || !!c.styleQuota?.overflow) &&
        // Strict: a styled order goes only to a matching designer.
        (style === null || c.styleMatch) &&
        // A Disney order, styled or not, goes only to a Disney designer.
        (!disney || drawsDisney(c.styles)),
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
 * Ranked, eligible candidates for a business + style, straight from the DB.
 * Shared by auto-assign (entry into ready_to_assign) and the SLA-sweep
 * reassign step (48 h, no submission) — `excludeDesignerId` drops the
 * currently-assigned designer so a reassignment never picks the same person.
 * `orderId` lets value-gated quota groups read the order's total; without it
 * (or with an unknown total) no value gate matches.
 */
export async function loadRankedCandidates(
  tx: Tx,
  input: { businessId: string; style: string | null; excludeDesignerId?: string | null; orderId?: string | null },
): Promise<RankedCandidate[]> {
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
  const total = input.orderId ? await loadOrderTotal(tx, input.orderId) : null;
  const quotaFor = new Map<string, NonNullable<Candidate["styleQuota"]>>();
  const holders = roster.flatMap((r) => {
    const group = quotaGroupFor(r.styleDailyLimits, { businessId: input.businessId, style: input.style, total });
    return group ? [{ designerId: r.designerId, group }] : [];
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
          inArray(assignments.businessId, [...new Set(holders.flatMap((h) => quotaPool(h.group)))]),
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
      quotaFor.set(h.designerId, {
        limit: h.group.limit,
        priority: h.group.priority,
        usedToday: quotaUsed(h.group, uses),
        overflow: h.group.overflow === true,
      });
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

  const disney = isDisneyStyle(input.style) || (input.orderId ? await loadIsDisneyOrder(tx, input.orderId) : false);
  return rankCandidates(candidates, { style: input.style, disney });
}

/**
 * Runs when an order enters ready_to_assign. Builds candidates from the DB,
 * ranks them, and assigns the top one (deactivating any prior active
 * assignment). If nobody is eligible the order stays ready_to_assign with no
 * active assignment — it surfaces in the VA "Unassigned" tab.
 *
 * A revision or failed QC never goes through the ranking: it goes back to the
 * designer who has it or drew it, at any load (keepRework). When none of them
 * can take it the order waits with reworkHeld set, for an owner to say who does.
 */
export async function runAutoAssign(
  tx: Tx,
  order: { orderId: string; businessId: string; assignedBy: string | null },
): Promise<{ assigned: string | null; reworkHeld?: ReworkHold; missingPhoto?: boolean }> {
  // No photo = nobody is picked and nothing throws: the caller parks the order
  // (autopilot raises a card, a transition still succeeds) until a reference
  // photo is attached, then the next pass assigns it.
  if (!(await hasReferencePhoto(tx, order.orderId))) return { assigned: null, missingPhoto: true };

  const [item] = await tx
    .select({ style: orderItems.style })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.orderId))
    .limit(1);
  let style = item?.style ?? null;

  const hold = await loadReworkHold(tx, order.orderId);
  if (reworkBound(hold)) return keepRework(tx, order, hold, style);

  // A PixArt Disney order whose buyer names a person becomes Disneyfy People,
  // so only the Disney people designer is offered it (Yousif 2026-10-21).
  style = (await routeDisneyPeople(tx, order.orderId, order.businessId)) ?? style;

  // A product with the AI designer switched on goes to the agent, not a human,
  // unless the order needs 2+ separate portraits (two lines, or one bought
  // twice): the AI draws one portrait per job, so those go to a person. A
  // Disney order never goes to the agent, only to a Disney designer.
  const agentId = await aiDesignerFor(tx, order.businessId, order.orderId, style);
  if (agentId) {
    await queueForAgent(tx, order, agentId);
    return { assigned: agentId };
  }

  const ranked = await loadRankedCandidates(tx, { businessId: order.businessId, style, orderId: order.orderId });
  if (!ranked.length) return { assigned: null };
  const chosen = ranked[0].designerId;

  await createAssignment(tx, {
    orderId: order.orderId,
    businessId: order.businessId,
    designerId: chosen,
    assignedBy: order.assignedBy,
  });

  return { assigned: chosen };
}

/** The business's AI Studio when the AI may draw this order (style switched on, not Disney, one portrait); else null. */
async function aiDesignerFor(tx: Tx, businessId: string, orderId: string, style: string | null): Promise<string | null> {
  const styleRow = await findStyle(tx, businessId, style);
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
  style: string | null,
): Promise<{ assigned: string | null; reworkHeld?: ReworkHold }> {
  const keeper = await reworkKeeper(tx, order.businessId, hold);
  if (!keeper) return { assigned: null, reworkHeld: hold };

  if (keeper.isAgent) {
    const agentId = await aiDesignerFor(tx, order.businessId, order.orderId, style);
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
  input: { businessId: string; style: string | null; excludeDesignerId: string; orderId?: string | null },
): Promise<string | null> {
  const ranked = await loadRankedCandidates(tx, input);
  return ranked[0]?.designerId ?? null;
}
