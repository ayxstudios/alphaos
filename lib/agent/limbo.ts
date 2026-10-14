// No limbo (docs/NO_LIMBO.md). Yousif 2026-10-14: "There shouldn't ever be
// anything unassigned." Every live order and every open exception is owned by
// a designer, the buyer (with a live chase), a pipeline queue (QC, print, an
// add-on riding on its portrait order) or the owner (an open exception the
// owner digest raises). This file:
//   L1  autoCloseStaleExceptions: an exception whose problem has gone closes itself.
//   L4  watchWaitingStates: an order nobody owns gets a stuck_order row.
//   L6  getLimboCensus: who owns what, per business (target: limbo 0).
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import {
  activityLog,
  assignments,
  businesses,
  customers,
  designerBusinesses,
  designerProfiles,
  exceptions,
  orders,
  shops,
  users,
} from "@/lib/db/schema";
import { reassignOrder } from "./ai-designer";
import { agentOrderScope } from "./scope";
import { openExceptionTx } from "./exceptions";

const HOUR = 3_600_000;
export const CLOSED_STATUSES = ["cancelled", "complete", "delivered", "shipped"];
const INTAKE_STATUSES = ["awaiting_details", "triage"];
/** Someone started drawing it, or later. */
const STARTED_STATUSES = ["in_design", "awaiting_qc", "awaiting_approval", "approved", "printing"];
/**
 * Exceptions about something a buyer or a mailbox said. A closed order makes
 * them moot only when it closed AFTER they opened: a buyer writing about a
 * delivered print is new work, not a stale card.
 */
const MESSAGE_KINDS = new Set(["reply_unclear", "buyer_question", "email_send_failed", "legacy_order", "unmatched_reply"]);
/** Kinds the L1 pass never judges: L2 (./junk-mail.ts), L4 and L3 own these. */
const NOT_L1 = ["unmatched_reply", "stuck_order", "designer_backlog"];
/** How long an order may sit in a waiting state before a person must own it. */
export const WAIT_GRACE_HOURS = 2;
/**
 * No buyer email yet: the buyer-email filler reads it off the Etsy order page,
 * and a shop desk busy with buyer replies can take hours to give it a turn.
 * The filler owns the gap this long before the owner hears about it (Yousif
 * 2026-10-13: the email can always be read, never ask a person for it first).
 */
export const EMAIL_GRACE_HOURS = 12;
/** An add-on with no portrait order gets a day for the link to show up. */
export const ADDON_GRACE_HOURS = 24;
/** A buyer chase (photo request or reminder) counts as live this long. */
export const CHASE_LIVE_DAYS = 7;

// ---------------------------------------------------------------------------
// L1: stale exceptions close themselves
// ---------------------------------------------------------------------------

export type ExceptionFacts = {
  kind: string;
  hasOrder: boolean;
  status: string | null;
  archived: boolean;
  /** The order was archived, or moved into its current closed status, after the exception opened. */
  closedAfterOpen: boolean;
  needsReview: boolean;
  activeAssignment: boolean;
  activeIsAgent: boolean;
  /** reply_unclear / buyer_question: a written email to the buyer went out after it opened. */
  replySentAfter: boolean;
  /** email_send_failed: its email(s) went out, or a later email to the same address did. */
  failedMailSent: boolean;
  /** new_product: someone mapped the product (its style is no longer auto-created). */
  styleMapped: boolean;
  /** new_product: an order on the card is still held at intake. */
  productOrdersHeld: boolean;
  /** reply_unclear / buyer_question: what the buyer wrote. */
  excerpt?: string | null;
};

/** A Gmail / Outlook emoji reaction: nothing to read, nothing to answer. Pure. */
export function isReactionOnly(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.replace(/<https?:[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return t.length < 200 && /\breacted (via gmail|to your (message|email))\b/i.test(t);
}

/** Why this open exception no longer needs anyone, or null while it still does. Pure. */
export function staleReason(f: ExceptionFacts): string | null {
  if (f.hasOrder) {
    const closed = f.archived || (f.status !== null && CLOSED_STATUSES.includes(f.status));
    if (closed && (!MESSAGE_KINDS.has(f.kind) || f.closedAfterOpen)) return "order closed";
  }
  const st = f.status ?? "";
  switch (f.kind) {
    case "no_eligible_designer":
      if (f.activeAssignment) return "a designer has it";
      if (f.hasOrder && st !== "ready_to_assign") return "no longer waiting for a designer";
      return null;
    case "ai_designer_failed":
      if (f.activeAssignment && !f.activeIsAgent) return "a designer has it";
      if (STARTED_STATUSES.includes(st) && st !== "in_design") return "past design";
      return null;
    case "photo_count_mismatch":
      if (f.activeAssignment) return "went to a designer with the photos it had";
      if (STARTED_STATUSES.includes(st)) return "went to design";
      return null;
    case "intake_unparsed":
    case "legacy_order":
      if (f.hasOrder && !INTAKE_STATUSES.includes(st) && !f.needsReview) return "details complete";
      return null;
    case "new_product":
      if (f.styleMapped) return "product mapped to a style";
      if (!f.productOrdersHeld) return "no order waiting on it";
      return null;
    case "addon_only":
      if (st === "fulfillment_only") return "linked to its portrait order";
      if (f.activeAssignment) return "a designer has it";
      return null;
    case "reply_unclear":
    case "buyer_question":
      if (f.replySentAfter) return "the buyer was answered";
      if (isReactionOnly(f.excerpt)) return "an emoji reaction, nothing to answer";
      return null;
    case "email_send_failed":
      return f.failedMailSent ? "the email went out" : null;
    default:
      return null;
  }
}

async function loadExceptionFacts(tx: Tx, businessId: string) {
  const closedList = sql.join(CLOSED_STATUSES.map((s) => sql`${s}`), sql`, `);
  const intakeList = sql.join(INTAKE_STATUSES.map((s) => sql`${s}`), sql`, `);
  return tx
    .select({
      id: exceptions.id,
      kind: exceptions.kind,
      orderId: exceptions.orderId,
      status: sql<string | null>`${orders.status}::text`,
      archived: sql<boolean>`${orders.archivedAt} is not null`,
      needsReview: sql<boolean>`coalesce(${orders.needsReview}, false)`,
      closedAfterOpen: sql<boolean>`coalesce(
        ${orders.archivedAt} >= ${exceptions.createdAt}
        or (${orders.status}::text in (${closedList}) and exists (
          select 1 from activity_log a where a.order_id = ${orders.id}
            and a.to_state = ${orders.status} and a.created_at >= ${exceptions.createdAt})), false)`,
      activeAssignment: sql<boolean>`${assignments.id} is not null`,
      activeIsAgent: sql<boolean>`coalesce(${designerProfiles.isAgent}, false)`,
      replySentAfter: sql<boolean>`(${exceptions.kind} in ('reply_unclear', 'buyer_question') and exists (
        select 1 from messages m where m.order_id = ${exceptions.orderId}
          and m.direction = 'outbound' and m.status = 'sent'
          and coalesce(m.sent_at, m.manual_sent_at, m.created_at) > ${exceptions.createdAt}
          and (m.template_key is null or m.template_key = 'revision_received')))`,
      failedMailSent: sql<boolean>`(${exceptions.kind} = 'email_send_failed' and (
        (${exceptions.detail}->>'messageId' is not null and not exists (
          select 1 from messages m where (m.id = ${exceptions.detail}->>'messageId'
            or m.id in (select jsonb_array_elements_text(coalesce(${exceptions.detail}->'messageIds', '[]'::jsonb))))
            and m.status <> 'sent'))
        or exists (
          select 1 from messages m2 where m2.business_id = ${exceptions.businessId}
            and m2.direction = 'outbound' and m2.status = 'sent'
            and ${exceptions.detail}->>'to' is not null
            and lower(m2.address) = lower(${exceptions.detail}->>'to')
            and coalesce(m2.sent_at, m2.manual_sent_at, m2.created_at) > ${exceptions.createdAt})))`,
      excerpt: sql<string | null>`${exceptions.detail}->>'excerpt'`,
      styleMapped: sql<boolean>`(${exceptions.kind} = 'new_product' and exists (
        select 1 from styles s where s.id = ${exceptions.detail}->>'styleId' and not s.auto_created))`,
      productOrdersHeld: sql<boolean>`(${exceptions.kind} = 'new_product' and exists (
        select 1 from orders o2 where (o2.id = ${exceptions.orderId}
            or o2.id in (select jsonb_array_elements_text(coalesce(${exceptions.detail}->'orderIds', '[]'::jsonb))))
          and o2.archived_at is null and o2.status::text in (${intakeList})))`,
    })
    .from(exceptions)
    .leftJoin(orders, eq(orders.id, exceptions.orderId))
    .leftJoin(assignments, and(eq(assignments.orderId, exceptions.orderId), eq(assignments.active, true)))
    .leftJoin(designerProfiles, eq(designerProfiles.userId, assignments.designerId))
    .where(
      and(
        eq(exceptions.businessId, businessId),
        eq(exceptions.status, "open"),
        sql`${exceptions.kind} not in (${sql.join(NOT_L1.map((k) => sql`${k}`), sql`, `)})`,
      ),
    );
}

/** Resolve open exceptions by the system with an "auto:" note and one activity row each. */
export async function autoResolveTx(
  tx: Tx,
  rows: { id: string; businessId: string; orderId: string | null; kind: string; reason: string }[],
  now: Date,
): Promise<number> {
  let closed = 0;
  const byReason = new Map<string, typeof rows>();
  for (const r of rows) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r]);
  for (const [reason, group] of byReason) {
    const done = await tx
      .update(exceptions)
      .set({ status: "resolved", resolvedAt: now, resolvedBy: null, resolutionNote: `auto: ${reason}` })
      .where(and(inArray(exceptions.id, group.map((g) => g.id)), eq(exceptions.status, "open")))
      .returning({ id: exceptions.id });
    const doneIds = new Set(done.map((d) => d.id));
    const logged = group.filter((g) => doneIds.has(g.id));
    if (logged.length) {
      await tx.insert(activityLog).values(
        logged.map((g) => ({
          businessId: g.businessId,
          orderId: g.orderId,
          actorId: null,
          action: "agent.exception_auto_closed",
          metadata: { exceptionId: g.id, kind: g.kind, reason },
        })),
      );
    }
    closed += logged.length;
  }
  return closed;
}

export type AutoCloseResult = { checked: number; closed: number; byReason: Record<string, number>; ids: string[] };

/** L1 for one business. dryRun counts what would close and writes nothing. */
export async function autoCloseStaleExceptions(
  businessId: string,
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<AutoCloseResult> {
  const now = opts.now ?? new Date();
  return withSystemContext(async (tx) => {
    const facts = await loadExceptionFacts(tx, businessId);
    const stale: { id: string; businessId: string; orderId: string | null; kind: string; reason: string }[] = [];
    for (const f of facts) {
      const reason = staleReason({ ...f, hasOrder: !!f.orderId });
      if (reason) stale.push({ id: f.id, businessId, orderId: f.orderId, kind: f.kind, reason });
    }
    const byReason: Record<string, number> = {};
    for (const s of stale) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
    const closed = opts.dryRun ? stale.length : await autoResolveTx(tx, stale, now);
    return { checked: facts.length, closed, byReason, ids: stale.map((s) => s.id) };
  });
}

// ---------------------------------------------------------------------------
// L4 + L6: who owns each live order
// ---------------------------------------------------------------------------

export type OrderFacts = {
  id: string;
  number: string;
  status: string;
  needsReview: boolean;
  inScope: boolean;
  /** When the order entered its current status (falls back to when it was made). */
  enteredAt: Date;
  activeAssignment: boolean;
  /** The buyer can be reached: an email on file. */
  hasContact: boolean;
  /** Latest photo request / reminder / shortfall email sent or queued. */
  lastChaseAt: Date | null;
  /** fulfillment_only: linked to a portrait order that is not cancelled or archived. */
  parentLive: boolean;
  /** Kinds of the open exceptions on this order. */
  openKinds: string[];
  style: string | null;
};

export type Owner =
  | { bucket: "designer" | "buyer" | "pipeline" | "owner"; why: string }
  | { bucket: "limbo"; why: string; reason: StuckReason; graceHours: number };

export type StuckReason =
  | "details"
  | "needs_review"
  | "no_contact"
  | "no_photos"
  | "addon_orphan"
  | "not_assigned"
  | "no_designer"
  | "on_hold";

/**
 * Who owns a live, open order. Pure. `ignoreStuck` judges the order as if its
 * own stuck_order row were not there (used to close that row).
 */
export function ownerOf(o: OrderFacts, now: Date, opts: { ignoreStuck?: boolean } = {}): Owner {
  const age = now.getTime() - o.enteredAt.getTime();
  if (o.activeAssignment) return { bucket: "designer", why: "has a designer" };
  if (o.status === "awaiting_approval") return { bucket: "buyer", why: "proof with the buyer" };
  if (["awaiting_qc", "approved", "printing"].includes(o.status)) return { bucket: "pipeline", why: `in ${o.status.replace(/_/g, " ")}` };
  if (o.status === "fulfillment_only" && o.parentLive) return { bucket: "pipeline", why: "add-on with its portrait order" };
  const kinds = opts.ignoreStuck ? o.openKinds.filter((k) => k !== "stuck_order") : o.openKinds;
  if (kinds.length) return { bucket: "owner", why: `raised: ${kinds.join(", ")}` };

  // Inside the grace the automatic passes still own it: intake re-parses and the
  // buyer-email filler run (buyer side), the assigner runs every tick (pipeline).
  const limbo = (reason: StuckReason, why: string, graceHours = WAIT_GRACE_HOURS): Owner => {
    if (age >= graceHours * HOUR) return { bucket: "limbo", why, reason, graceHours };
    const gathering = ["details", "needs_review", "no_contact", "no_photos"].includes(reason);
    return gathering ? { bucket: "buyer", why: "details still being gathered" } : { bucket: "pipeline", why: "just arrived" };
  };

  if (o.needsReview && ["awaiting_details", "triage", "ready_to_assign", "awaiting_photos"].includes(o.status)) {
    return limbo("needs_review", "held for a check");
  }
  switch (o.status) {
    case "awaiting_details":
    case "triage":
      return limbo("details", "waiting on order details", o.hasContact ? WAIT_GRACE_HOURS : EMAIL_GRACE_HOURS);
    case "awaiting_photos": {
      if (!o.hasContact) return limbo("no_contact", "no way to reach the buyer", EMAIL_GRACE_HOURS);
      const chased = o.lastChaseAt && now.getTime() - o.lastChaseAt.getTime() < CHASE_LIVE_DAYS * 24 * HOUR;
      if (chased) return { bucket: "buyer", why: "photos asked for" };
      return limbo("no_photos", o.lastChaseAt ? "no photos since the last reminder" : "photos never asked for");
    }
    case "fulfillment_only":
      return limbo("addon_orphan", "add-on with no portrait order", ADDON_GRACE_HOURS);
    case "ready_to_assign":
      return limbo("not_assigned", o.inScope ? "nobody assigned" : "older order nobody assigned");
    case "in_design":
      return limbo("no_designer", "in design with no designer");
    case "on_hold":
      return limbo("on_hold", "on hold with nobody on it", ADDON_GRACE_HOURS);
    default:
      return limbo("not_assigned", `in ${o.status} with nobody on it`);
  }
}

async function loadOrderFacts(tx: Tx, businessId: string): Promise<OrderFacts[]> {
  const closedList = sql.join(CLOSED_STATUSES.map((s) => sql`${s}`), sql`, `);
  const rows = await tx
    .select({
      id: orders.id,
      number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
      status: sql<string>`${orders.status}::text`,
      needsReview: orders.needsReview,
      inScope: sql<boolean>`${agentOrderScope()}`,
      enteredAt: sql<string>`coalesce((select max(a.created_at) from activity_log a
        where a.order_id = ${orders.id} and a.to_state = ${orders.status}), ${orders.createdAt})`,
      activeAssignment: sql<boolean>`exists (select 1 from assignments a where a.order_id = ${orders.id} and a.active)`,
      hasContact: sql<boolean>`coalesce(nullif(trim(${customers.email}), ''), null) is not null and ${customers.email} not like '%.invalid'`,
      lastChaseAt: sql<string | null>`(select max(m.created_at) from messages m where m.order_id = ${orders.id}
        and m.direction = 'outbound' and m.status in ('sent', 'queued')
        and m.template_key in ('photo_request', 'photo_reminder', 'photo_shortfall'))`,
      parentLive: sql<boolean>`exists (select 1 from activity_log l join orders p on p.id::text = l.metadata->>'parentOrderId'
        where l.order_id = ${orders.id} and l.action = 'agent.addon_linked'
          and p.archived_at is null and p.status <> 'cancelled')`,
      openKinds: sql<string[]>`coalesce((select array_agg(e.kind) from exceptions e
        where e.order_id = ${orders.id} and e.status = 'open'), '{}'::text[])`,
      style: sql<string | null>`(select i.style from order_items i where i.order_id = ${orders.id} and i.style is not null order by i.id limit 1)`,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.businessId, businessId), sql`${orders.archivedAt} is null`, sql`${orders.status}::text not in (${closedList})`));
  return rows.map((r) => ({
    ...r,
    enteredAt: new Date(r.enteredAt),
    lastChaseAt: r.lastChaseAt ? new Date(r.lastChaseAt) : null,
    openKinds: r.openKinds ?? [],
  }));
}

export type LimboCensus = {
  businessId: string;
  businessName: string;
  live: number;
  withDesigner: number;
  waitingOnBuyer: number;
  inPipeline: number;
  withOwner: number;
  limbo: number;
  limboOrders: { id: string; number: string; status: string; why: string }[];
};

/** L6: who owns every live order of one business (read-only). */
export async function getLimboCensus(businessId: string, opts: { now?: Date } = {}): Promise<LimboCensus> {
  const now = opts.now ?? new Date();
  return withSystemContext(async (tx) => {
    const [biz] = await tx.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId));
    const facts = await loadOrderFacts(tx, businessId);
    const c: LimboCensus = {
      businessId,
      businessName: biz?.name ?? businessId,
      live: facts.length,
      withDesigner: 0,
      waitingOnBuyer: 0,
      inPipeline: 0,
      withOwner: 0,
      limbo: 0,
      limboOrders: [],
    };
    for (const o of facts) {
      const w = ownerOf(o, now);
      if (w.bucket === "designer") c.withDesigner++;
      else if (w.bucket === "buyer") c.waitingOnBuyer++;
      else if (w.bucket === "pipeline") c.inPipeline++;
      else if (w.bucket === "owner") c.withOwner++;
      else {
        c.limbo++;
        c.limboOrders.push({ id: o.id, number: o.number, status: o.status, why: w.why });
      }
    }
    return c;
  });
}

/** The one plain line for a stuck order, and what I would do about it. */
export function stuckWords(
  reason: StuckReason,
  o: Pick<OrderFacts, "status" | "lastChaseAt" | "hasContact" | "style">,
  suggestion: string | null,
  now: Date,
): { summary: string; recommendation: string } {
  const days = o.lastChaseAt ? Math.max(1, Math.floor((now.getTime() - o.lastChaseAt.getTime()) / (24 * HOUR))) : null;
  const give = suggestion ? `Give it to ${suggestion}.` : "Pick a designer on the order page.";
  switch (reason) {
    case "details":
      return {
        summary: "waiting on order details for over 2 hours",
        recommendation: o.hasContact
          ? "Open it and fill in what is missing (style, people count, product)."
          : "Open it and fill in what is missing (style, people count, product). The buyer's email is still being read from the Etsy order.",
      };
    case "needs_review":
      return { summary: "held for a check before it can go to a designer", recommendation: "Open it, confirm the details, then it goes to a designer." };
    case "no_contact":
      return {
        summary: `waiting for photos, and I could not read the buyer's email from the Etsy order in ${EMAIL_GRACE_HOURS} hours`,
        recommendation: "Message the buyer on Etsy for the photos. I keep trying for the email.",
      };
    case "no_photos":
      return {
        summary: days ? `no photos ${days} day${days === 1 ? "" : "s"} after the last reminder` : "waiting for photos and they were never asked for",
        recommendation: days ? "Message the buyer once more on Etsy, or put the order on hold." : "Send the photo request from the order page.",
      };
    case "addon_orphan":
      return {
        summary: "add-on (print or extra) with no portrait order linked",
        recommendation: "Match it to the buyer's portrait order, or fulfil it on its own.",
      };
    case "not_assigned":
      return { summary: `ready for a designer${o.style ? ` (${o.style})` : ""} but nobody has it`, recommendation: give };
    case "no_designer":
      return { summary: "in design but no designer holds it", recommendation: give };
    case "on_hold":
      return { summary: "on hold with nobody on it for over a day", recommendation: "Decide: resume it, cancel it, or keep it on hold with a note." };
  }
}

/** The designer I would give a style to: draws it, not AI Studio, not paused, biggest daily limit, then rank. */
export async function suggestDesigner(tx: Tx, businessId: string, style: string | null): Promise<string | null> {
  if (!style) return null;
  const want = style.trim().toLowerCase();
  const roster = await tx
    .select({ name: users.name, styles: designerProfiles.styles, cap: designerProfiles.dailyCapacity, rank: designerProfiles.rank })
    .from(designerBusinesses)
    .innerJoin(users, and(eq(users.id, designerBusinesses.userId), eq(users.active, true), eq(users.role, "designer")))
    .innerJoin(designerProfiles, eq(designerProfiles.userId, designerBusinesses.userId))
    .where(and(eq(designerBusinesses.businessId, businessId), eq(designerProfiles.isAgent, false)));
  const best = roster
    .filter((r) => r.cap > 0 && (r.styles ?? []).some((s) => s.trim().toLowerCase() === want))
    .sort((a, b) => b.cap - a.cap || a.rank - b.rank)[0];
  return best?.name ?? null;
}

export type WatchResult = { checked: number; opened: number; refreshed: number; closed: number; limbo: number; closedIds: string[] };

/**
 * L4 for one business: every live order nobody owns past its grace gets a
 * stuck_order row (summary + recommendation); a stuck_order whose order has an
 * owner again closes itself.
 */
export async function watchWaitingStates(
  businessId: string,
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<WatchResult> {
  const now = opts.now ?? new Date();
  return withSystemContext(async (tx) => {
    const facts = await loadOrderFacts(tx, businessId);
    const res: WatchResult = { checked: facts.length, opened: 0, refreshed: 0, closed: 0, limbo: 0, closedIds: [] };
    const stuckRows = await tx
      .select({ id: exceptions.id, orderId: exceptions.orderId, detail: exceptions.detail })
      .from(exceptions)
      .where(and(eq(exceptions.businessId, businessId), eq(exceptions.kind, "stuck_order"), eq(exceptions.status, "open")));
    const stuckByOrder = new Map(stuckRows.map((r) => [r.orderId, r]));
    const byId = new Map(facts.map((f) => [f.id, f]));
    const toClose: { id: string; businessId: string; orderId: string | null; kind: string; reason: string }[] = [];

    // A stuck_order whose order is closed, archived or owned again goes.
    for (const row of stuckRows) {
      const f = row.orderId ? byId.get(row.orderId) : undefined;
      if (!f) {
        toClose.push({ id: row.id, businessId, orderId: row.orderId, kind: "stuck_order", reason: "order closed" });
        continue;
      }
      const w = ownerOf(f, now, { ignoreStuck: true });
      if (w.bucket !== "limbo") toClose.push({ id: row.id, businessId, orderId: row.orderId, kind: "stuck_order", reason: w.why });
    }

    for (const f of facts) {
      const w = ownerOf(f, now, { ignoreStuck: true });
      if (w.bucket !== "limbo") continue;
      res.limbo++;
      const suggestion = ["not_assigned", "no_designer"].includes(w.reason) ? await suggestDesigner(tx, businessId, f.style) : null;
      const words = stuckWords(w.reason, f, suggestion, now);
      const detail = { reason: w.reason, status: f.status, since: f.enteredAt.toISOString(), recommendation: words.recommendation };
      const existing = stuckByOrder.get(f.id);
      if (existing) {
        if ((existing.detail as { reason?: string } | null)?.reason === w.reason) continue;
        res.refreshed++;
        if (!opts.dryRun) {
          await tx
            .update(exceptions)
            .set({ summary: `Order ${f.number}: ${words.summary}`, detail: sql`${exceptions.detail} || ${JSON.stringify(detail)}::jsonb` })
            .where(eq(exceptions.id, existing.id));
        }
        continue;
      }
      res.opened++;
      if (opts.dryRun) continue;
      const opened = await openExceptionTx(tx, {
        businessId,
        orderId: f.id,
        kind: "stuck_order",
        summary: `Order ${f.number}: ${words.summary}`,
        detail,
      });
      if (opened.created) {
        await tx.insert(activityLog).values({
          businessId,
          orderId: f.id,
          actorId: null,
          action: "agent.exception_opened",
          metadata: { exceptionId: opened.id, kind: "stuck_order", reason: w.reason },
        });
      }
    }
    res.closed = opts.dryRun ? toClose.length : await autoResolveTx(tx, toClose, now);
    res.closedIds = toClose.map((c) => c.id);
    return res;
  });
}

// ---------------------------------------------------------------------------
// designer_backlog: a designer whose not-started queue is past 3 days of cap
// ---------------------------------------------------------------------------

/** Not-started queue per designer: active assignments on ready_to_assign live orders, every business. */
export async function notStartedQueue(tx: Tx, designerIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!designerIds.length) return out;
  for (const r of await tx
    .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(
      and(
        eq(assignments.active, true),
        inArray(assignments.designerId, designerIds),
        eq(orders.status, "ready_to_assign"),
        sql`${orders.archivedAt} is null`,
      ),
    )
    .groupBy(assignments.designerId)) {
    out.set(r.designerId, Number(r.n));
  }
  return out;
}

/** The Sydney calendar day, YYYY-MM-DD (the backlog line goes out at most once a day). */
export function sydneyDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Open or refresh the designer_backlog row for (designer, style) when the
 * not-started queue is past 3 days of the designer's daily limit; close it once
 * the queue is back under.
 */
export async function checkDesignerBacklog(
  tx: Tx,
  input: { businessId: string; designerId: string; style: string; now: Date },
): Promise<"opened" | "refreshed" | "closed" | "none"> {
  const [d] = await tx
    .select({ name: users.name, cap: designerProfiles.dailyCapacity })
    .from(designerProfiles)
    .innerJoin(users, eq(users.id, designerProfiles.userId))
    .where(eq(designerProfiles.userId, input.designerId));
  if (!d || d.cap <= 0) return "none";
  const queue = (await notStartedQueue(tx, [input.designerId])).get(input.designerId) ?? 0;
  const [open] = await tx
    .select({ id: exceptions.id, detail: exceptions.detail })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.businessId, input.businessId),
        eq(exceptions.kind, "designer_backlog"),
        eq(exceptions.status, "open"),
        sql`${exceptions.detail}->>'designerId' = ${input.designerId}`,
        sql`lower(${exceptions.detail}->>'style') = lower(${input.style})`,
      ),
    )
    .limit(1);
  const over = queue > 3 * d.cap;
  if (!over) {
    if (!open) return "none";
    await autoResolveTx(tx, [{ id: open.id, businessId: input.businessId, orderId: null, kind: "designer_backlog", reason: "queue back under 3 days" }], input.now);
    return "closed";
  }
  const name = d.name ?? "The designer";
  const days = Math.round(queue / d.cap);
  const summary = `${name} has ${queue} ${input.style} orders waiting, about ${days} days at ${d.cap} a day`;
  const recommendation = `Raise ${name}'s daily limit or add a second ${input.style} designer.`;
  const day = sydneyDay(input.now);
  const detail = { designerId: input.designerId, designerName: name, style: input.style, queue, dailyCapacity: d.cap, day, recommendation };
  if (open) {
    if ((open.detail as { day?: string } | null)?.day === day) return "none";
    await tx
      .update(exceptions)
      .set({ summary, detail: sql`${exceptions.detail} || ${JSON.stringify(detail)}::jsonb` })
      .where(eq(exceptions.id, open.id));
    return "refreshed";
  }
  const opened = await openExceptionTx(tx, { businessId: input.businessId, orderId: null, kind: "designer_backlog", summary, detail });
  await tx.insert(activityLog).values({
    businessId: input.businessId,
    orderId: null,
    actorId: null,
    action: "agent.exception_opened",
    metadata: { exceptionId: opened.id, kind: "designer_backlog", designerId: input.designerId, queue },
  });
  return "opened";
}

/** Close designer_backlog rows whose queue went back under 3 days (run each tick). */
export async function closeClearedBacklogs(businessId: string, opts: { now?: Date; dryRun?: boolean } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  return withSystemContext(async (tx) => {
    const rows = await tx
      .select({ id: exceptions.id, detail: exceptions.detail })
      .from(exceptions)
      .where(and(eq(exceptions.businessId, businessId), eq(exceptions.kind, "designer_backlog"), eq(exceptions.status, "open")));
    if (!rows.length) return 0;
    const ids = rows.map((r) => String((r.detail as { designerId?: string }).designerId ?? "")).filter(Boolean);
    const queue = await notStartedQueue(tx, ids);
    const caps = new Map(
      (await tx.select({ id: designerProfiles.userId, cap: designerProfiles.dailyCapacity }).from(designerProfiles).where(inArray(designerProfiles.userId, ids.length ? ids : [""]))).map((r) => [r.id, r.cap]),
    );
    const done = rows.filter((r) => {
      const id = String((r.detail as { designerId?: string }).designerId ?? "");
      const cap = caps.get(id) ?? 0;
      return cap <= 0 || (queue.get(id) ?? 0) <= 3 * cap;
    });
    if (opts.dryRun) return done.length;
    return autoResolveTx(tx, done.map((r) => ({ id: r.id, businessId, orderId: null, kind: "designer_backlog", reason: "queue back under 3 days" })), now);
  });
}

// ---------------------------------------------------------------------------
// Add-on linking (L3): an add-on rides on the buyer's portrait order
// ---------------------------------------------------------------------------

export type AddonCandidate = { id: string; number: string; status: string; placedAt: Date | null };

/**
 * The buyer's portrait orders an add-on could belong to: same business and
 * customer, still open (a finished order would never see the note), never an
 * add-on itself, placed within 30 days.
 */
export async function findAddonParents(
  tx: Tx,
  addon: { id: string; businessId: string; customerId: string | null; placedAt: Date | null; createdAt: Date },
): Promise<AddonCandidate[]> {
  if (!addon.customerId) return [];
  const at = addon.placedAt ?? addon.createdAt;
  const rows = await tx
    .select({
      id: orders.id,
      number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
      status: sql<string>`${orders.status}::text`,
      placedAt: orders.placedAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.businessId, addon.businessId),
        eq(orders.customerId, addon.customerId),
        ne(orders.id, addon.id),
        sql`${orders.archivedAt} is null`,
        sql`${orders.status}::text not in ('cancelled', 'complete', 'delivered', 'shipped', 'fulfillment_only')`,
        sql`not exists (select 1 from exceptions e where e.order_id = ${orders.id} and e.kind = 'addon_only')`,
        sql`abs(extract(epoch from (coalesce(${orders.placedAt}, ${orders.createdAt}) - ${at.toISOString()}::timestamptz))) <= 30 * 86400`,
      ),
    );
  return rows;
}

/**
 * Link an add-on to its portrait order: the add-on becomes fulfillment_only,
 * both orders get a note and an `agent.addon_linked` row naming the other.
 */
export async function linkAddonTx(
  tx: Tx,
  addon: { id: string; businessId: string; number: string; status: string },
  parent: AddonCandidate,
  titles: string[],
): Promise<void> {
  const what = titles.filter(Boolean).join(", ") || "add-on";
  await tx
    .update(orders)
    .set({
      status: "fulfillment_only",
      updatedAt: new Date(),
      notes: sql`concat_ws(E'\n', nullif(${orders.notes}, ''), ${`Add-on to order ${parent.number}.`}::text)`,
    })
    .where(eq(orders.id, addon.id));
  await tx
    .update(orders)
    .set({ notes: sql`concat_ws(E'\n', nullif(${orders.notes}, ''), ${`Add-on order ${addon.number} (${what}) goes with this one.`}::text)` })
    .where(eq(orders.id, parent.id));
  await tx.insert(activityLog).values([
    {
      businessId: addon.businessId,
      orderId: addon.id,
      actorId: null,
      action: "agent.addon_linked",
      fromState: addon.status as typeof orders.$inferSelect.status,
      toState: "fulfillment_only",
      metadata: { parentOrderId: parent.id, parentNumber: parent.number },
    },
    {
      businessId: addon.businessId,
      orderId: parent.id,
      actorId: null,
      action: "agent.addon_linked_child",
      metadata: { addonOrderId: addon.id, addonNumber: addon.number, titles },
    },
  ]);
}

/** Order-level label for a shop, e.g. "CPS" from "The Custom Portrait Shop" (falls back to the shop name). */
export async function shopLabels(tx: Tx, shopIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!shopIds.length) return out;
  for (const r of await tx.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, shopIds))) {
    out.set(r.id, r.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overflow (L3): nobody free never means nobody
// ---------------------------------------------------------------------------

type RosterRow = {
  designerId: string;
  name: string | null;
  styles: string[] | null;
  cap: number;
  rank: number;
  maxActive: number;
  limits: unknown;
};

async function humanRoster(tx: Tx, businessId: string): Promise<RosterRow[]> {
  return tx
    .select({
      designerId: designerProfiles.userId,
      name: users.name,
      styles: designerProfiles.styles,
      cap: designerProfiles.dailyCapacity,
      rank: designerProfiles.rank,
      maxActive: designerProfiles.maxActiveOrders,
      limits: designerProfiles.styleDailyLimits,
    })
    .from(designerBusinesses)
    .innerJoin(users, and(eq(users.id, designerBusinesses.userId), eq(users.active, true), eq(users.role, "designer")))
    .innerJoin(designerProfiles, eq(designerProfiles.userId, designerBusinesses.userId))
    // AI Studio never takes overflow (and never cartoon or Disney pets).
    .where(and(eq(designerBusinesses.businessId, businessId), eq(designerProfiles.isAgent, false)));
}

const norm = (s: string) => s.trim().toLowerCase();
const draws = (r: Pick<RosterRow, "styles">, style: string) => (r.styles ?? []).some((s) => norm(s) === norm(style));

/** A per-style daily quota covering this style in this business, if the designer has one. */
export function styleQuotaLimit(limits: unknown, style: string, businessId: string): number | null {
  if (!Array.isArray(limits)) return null;
  for (const g of limits as { limit?: unknown; styles?: unknown; businessId?: unknown }[]) {
    if (!g || (g.businessId && g.businessId !== businessId)) continue;
    if (Array.isArray(g.styles) && g.styles.some((s) => typeof s === "string" && norm(s) === norm(style))) {
      const n = Number(g.limit);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

export type OverflowPick = { designerId: string; name: string | null; dailyCapacity: number; queue: number };

/**
 * The style's main designer, for an order everyone who draws the style is too
 * busy for: draws it, a daily limit of 2 or more (0 is paused, 1 a deliberate
 * throttle; a per-style quota counts the same way), under max active orders
 * when that is set. Biggest daily limit first, then rank, then the shortest
 * not-started queue.
 */
export async function pickOverflowDesigner(tx: Tx, businessId: string, style: string): Promise<OverflowPick | null> {
  const roster = (await humanRoster(tx, businessId))
    .filter((r) => draws(r, style))
    .map((r) => {
      const quota = styleQuotaLimit(r.limits, style, businessId);
      return { ...r, cap: quota == null ? r.cap : Math.min(r.cap, quota) };
    })
    .filter((r) => r.cap >= 2);
  if (!roster.length) return null;
  const ids = roster.map((r) => r.designerId);
  const queue = await notStartedQueue(tx, ids);
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
        sql`${orders.archivedAt} is null`,
      ),
    )
    .groupBy(assignments.designerId)) {
    wip.set(r.designerId, Number(r.n));
  }
  const best = roster
    .filter((r) => r.maxActive === 0 || (wip.get(r.designerId) ?? 0) < r.maxActive)
    .sort(
      (a, b) =>
        b.cap - a.cap || a.rank - b.rank || (queue.get(a.designerId) ?? 0) - (queue.get(b.designerId) ?? 0),
    )[0];
  return best ? { designerId: best.designerId, name: best.name, dailyCapacity: best.cap, queue: queue.get(best.designerId) ?? 0 } : null;
}

/** Words every other style name has: they say nothing about closeness (plurals already trimmed). */
const STYLE_STOPWORDS = new Set(["portrait", "custom", "the", "of", "and", "a", "an", "our", "my", "your", "style", "perfetta"]);

/** Word overlap between two style names, 0..1 ("Watercolor Pets" vs "Minimal Watercolor Pet" is high). */
export function styleSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(norm(s).replace(/s\b/g, "").split(/[^a-z0-9]+/).filter((w) => w && !STYLE_STOPWORDS.has(w)));
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/**
 * What I would do with an order no designer can take: the closest style a
 * designer draws (and who), or the style that needs adding, or the limit that
 * needs raising.
 */
export async function noDesignerRecommendation(
  tx: Tx,
  businessId: string,
  style: string | null,
  product: string | null,
): Promise<string> {
  if (!style) {
    return `Set the style on the order${product ? ` (or map "${product}" to a style)` : ""}, then it goes to a designer.`;
  }
  const roster = await humanRoster(tx, businessId);
  const drawers = roster.filter((r) => draws(r, style));
  if (drawers.length) {
    const names = drawers.map((r) => r.name ?? "a designer").join(" and ");
    return `${names} draw${drawers.length === 1 ? "s" : ""} ${style} but ${drawers.length === 1 ? "is" : "are"} paused or at a limit. Raise a daily limit, or give it to another designer.`;
  }
  let best: { name: string; style: string; score: number; cap: number; rank: number } | null = null;
  for (const r of roster) {
    if (r.cap <= 0) continue;
    for (const s of r.styles ?? []) {
      const score = styleSimilarity(style, s);
      if (score <= 0) continue;
      if (!best || score > best.score || (score === best.score && (r.cap > best.cap || (r.cap === best.cap && r.rank < best.rank)))) {
        best = { name: r.name ?? "a designer", style: s, score, cap: r.cap, rank: r.rank };
      }
    }
  }
  return best
    ? `Nobody draws ${style}. Give it to ${best.name} (draws ${best.style}), or add ${style} to a designer's styles.`
    : `Nobody draws ${style}. Add it to a designer's styles, or map the product to a style someone draws.`;
}

// ---------------------------------------------------------------------------
// L3: a portrait the AI designer gave up on goes to a person
// ---------------------------------------------------------------------------

export type AiHandoverResult = { checked: number; handed: number; kept: number; closedIds: string[] };

/**
 * An order the AI designer failed on (ai_state failed, still held by the
 * agent) goes to the style's main human designer, the same pick as overflow,
 * and its ai_designer_failed row closes. Nobody can take it: the row keeps a
 * recommendation for the owner digest.
 */
export async function handFailedAiToDesigners(
  businessId: string,
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<AiHandoverResult> {
  const now = opts.now ?? new Date();
  const rows = await withSystemContext((tx) =>
    tx
      .select({
        exceptionId: exceptions.id,
        orderId: orders.id,
        detail: exceptions.detail,
        style: sql<string | null>`(select i.style from order_items i where i.order_id = ${orders.id} and i.style is not null order by i.id limit 1)`,
        product: sql<string | null>`(select i.title from order_items i where i.order_id = ${orders.id} and i.title is not null order by i.id limit 1)`,
      })
      .from(exceptions)
      .innerJoin(orders, eq(orders.id, exceptions.orderId))
      .where(
        and(
          eq(exceptions.businessId, businessId),
          eq(exceptions.kind, "ai_designer_failed"),
          eq(exceptions.status, "open"),
          sql`${orders.archivedAt} is null`,
          sql`${orders.aiState} = 'failed'`,
          sql`${orders.status}::text in ('ready_to_assign', 'in_design')`,
          sql`exists (select 1 from assignments a join designer_profiles p on p.user_id = a.designer_id
            where a.order_id = ${orders.id} and a.active and p.is_agent)`,
        ),
      ),
  );
  const res: AiHandoverResult = { checked: rows.length, handed: 0, kept: 0, closedIds: [] };
  for (const r of rows) {
    const detail = (r.detail ?? {}) as Record<string, unknown>;
    const pick = r.style ? await withSystemContext((tx) => pickOverflowDesigner(tx, businessId, r.style!)) : null;
    if (pick && (opts.dryRun || (await reassignOrder(r.orderId, pick.designerId, null)).ok)) {
      res.handed++;
      res.closedIds.push(r.exceptionId);
      if (opts.dryRun) continue;
      await withSystemContext(async (tx) => {
        await tx.insert(activityLog).values({
          businessId,
          orderId: r.orderId,
          actorId: null,
          action: "agent.ai_failed_handed_over",
          metadata: { designerId: pick.designerId, exceptionId: r.exceptionId, reason: detail.reason ?? null },
        });
        await autoResolveTx(
          tx,
          [{ id: r.exceptionId, businessId, orderId: r.orderId, kind: "ai_designer_failed", reason: `given to ${pick.name ?? "a designer"}` }],
          now,
        );
      });
      continue;
    }
    res.kept++;
    if (opts.dryRun) continue;
    await withSystemContext(async (tx) => {
      const recommendation = await noDesignerRecommendation(tx, businessId, r.style, r.product);
      if (detail.recommendation === recommendation) return;
      await tx
        .update(exceptions)
        .set({ detail: sql`coalesce(${exceptions.detail}, '{}'::jsonb) || ${JSON.stringify({ recommendation })}::jsonb` })
        .where(eq(exceptions.id, r.exceptionId));
    });
  }
  return res;
}
