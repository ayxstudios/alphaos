// Which orders the agent (and the automatic reminders) may touch at all.
// Orders that came over from Trello stay with the team on Trello, and orders
// placed before the business's go-live cutoff (agentConfig.agentFrom) belong
// to the old process. Read straight from the business row in SQL so every
// query can add it without passing config around; an unset cutoff = no cutoff.
import { sql, type SQL } from "drizzle-orm";

import { messages, orders } from "@/lib/db/schema";

// An order marked URGENT (lib/orders/urgent.ts: a buyer is chasing it, legacy
// or not) is always in scope, so the agent works it whatever its origin.
export function agentOrderScope(): SQL {
  return sql`(${orders.urgentAt} is not null or (${orders.source} not in ('legacy', 'trello')
    and ${orders.trelloCardId} is null
    and coalesce(${orders.placedAt}, ${orders.createdAt}) >= coalesce(
      (select (b.agent_config->>'agentFrom')::timestamptz from businesses b where b.id = ${orders.businessId}),
      '-infinity'::timestamptz
    )))`;
}

/**
 * Outbound mail the agent may send by itself: written on/after the go-live
 * cutoff, and either not about an order or about an order inside
 * agentOrderScope. Anything older stays where it is for a human.
 */
export function agentMessageScope(): SQL {
  return sql`(${messages.createdAt} >= coalesce(
      (select (b.agent_config->>'agentFrom')::timestamptz from businesses b where b.id = ${messages.businessId}),
      '-infinity'::timestamptz
    )
    and (${messages.orderId} is null or ${messages.orderId} in (select ${orders.id} from ${orders} where ${agentOrderScope()})))`;
}

/**
 * LEGACY QUIET (owner, 2026-10-17 01:09 AEDT): "Don't action legacy threads
 * unless the customer follows up. I'm taking anything prior to October 12 don't
 * go and open cans of worms unless the customer comes and reaches out."
 *
 * An order is LEGACY when it was placed before LEGACY_BEFORE (12 Oct 2026
 * 00:00 Sydney = 11 Oct 13:00 UTC; ALPHAOS_LEGACY_BEFORE overrides it for
 * tests). A legacy order stays QUIET until its buyer reaches out. While it is
 * quiet the agent takes no initiative on it: no reminders, chasers, nudges,
 * reassignments or owner-digest lines. Everything a buyer's own message or
 * proof decision sets off, the outbox, the QC queue and approvals, intake,
 * print drafts and the staff screens stay exactly as they were.
 *
 * The buyer REACHED OUT when, at or after LEGACY_BEFORE, any of:
 *   (a) an inbound message row sits on the order (any channel);
 *   (b) the customer decided one of its proofs on the proof page (approved, or
 *       asked for a revision). Only that decision counts: not the 7-day silence
 *       auto-approve, an owner's review fix, a staff-made revision or a reply
 *       the agent applied from an email (an inbound message covers that one);
 *   (c) it was marked URGENT by a person, or by the agent because a buyer
 *       chased. The agent's own deadline and paid-order flags do not count.
 *
 * Separate from agentOrderScope on purpose: scope says what the agent may ever
 * touch, this says what it may start by itself right now.
 */
export const LEGACY_BEFORE = process.env.ALPHAOS_LEGACY_BEFORE || "2026-10-11T13:00:00.000Z";

/**
 * Reasons the agent writes on an urgent flag it raised by itself (a deadline
 * nearly gone, a paid order older than its go-live). Case-insensitive prefix,
 * the same text in SQL (~*) and in TypeScript, so the two cannot drift apart.
 */
export const AGENT_OWN_URGENT_PATTERN = "^(customer deadline close|paid (shopify|etsy) order|website order)";

/**
 * SQL: true for an order that is LEGACY and has not been reached out on. Never
 * NULL (an unmatched left join reads as "not quiet"). Used as
 * `not ${legacyQuiet()}` in an agent step's where list, or as a select field.
 */
export function legacyQuiet(): SQL {
  const quiet = sql`coalesce(
    coalesce(${orders.placedAt}, ${orders.createdAt}) < ${LEGACY_BEFORE}::timestamptz
    and not exists (
      select 1 from messages lq_m
      where lq_m.order_id = ${orders.id} and lq_m.direction = 'inbound' and lq_m.created_at >= ${LEGACY_BEFORE}::timestamptz
    )
    and not exists (
      select 1 from activity_log lq_a
      where lq_a.order_id = ${orders.id} and lq_a.created_at >= ${LEGACY_BEFORE}::timestamptz
        and lq_a.actor_id is null and lq_a.action in ('order.approved', 'order.in_design')
        and lq_a.metadata->>'via' = 'proof_portal'
    )
    and not (
      coalesce(${orders.urgentAt} >= ${LEGACY_BEFORE}::timestamptz, false)
      and not (coalesce(${orders.urgentBy}, '') = 'agent' and coalesce(${orders.urgentReason}, '') ~* ${AGENT_OWN_URGENT_PATTERN})
    ),
    false
  )`;
  // Wrapped once more so a select field (where drizzle strips the table name off
  // top-level columns) leaves the correlated columns above qualified.
  return sql`(${quiet})`;
}

/** What legacyQuiet reads off one order, for the pure twin below. */
export type LegacyFacts = {
  placedAt: Date | null;
  createdAt: Date;
  /** created_at of each inbound message on the order, any channel. */
  inboundAt: Date[];
  /** created_at of each proof decision the customer made on the proof page. */
  customerDecisionAt: Date[];
  urgentAt: Date | null;
  urgentBy: string | null;
  urgentReason: string | null;
};

/** The same rule as legacyQuiet(), for tests and any JS-side filter. */
export function isLegacyQuiet(f: LegacyFacts, before: Date = new Date(LEGACY_BEFORE)): boolean {
  if (!((f.placedAt ?? f.createdAt) < before)) return false;
  if (f.inboundAt.some((t) => t >= before)) return false;
  if (f.customerDecisionAt.some((t) => t >= before)) return false;
  if (f.urgentAt && f.urgentAt >= before) {
    const ownFlag = f.urgentBy === "agent" && new RegExp(AGENT_OWN_URGENT_PATTERN, "i").test(f.urgentReason ?? "");
    if (!ownFlag) return false;
  }
  return true;
}
