import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import {
  activityLog,
  assignments,
  businesses,
  customers,
  exceptions,
  messages,
  orderItems,
  orders,
  printJobs,
  proofs,
  users,
} from "@/lib/db/schema";
import { archivedUnfinishedWhere, liveOrderWhere } from "@/lib/orders/archive";
import { stageTimer } from "@/lib/orders/stage-timers";
import { stageLabel } from "@/lib/agent/overview";

/**
 * The All Seeing Eye: one read-only snapshot of every live order across every
 * business. Batched queries only (no per-order round trips).
 */

const CLOSED = ["complete", "cancelled", "delivered"] as const;
const OUT = ["shipped", "delivered", "complete"] as const;
const DAY = 24 * 60 * 60 * 1000;

export type EyeStageKey = "intake" | "drawing" | "qc" | "buyer" | "print" | "done";
export type EyeSentiment = "happy" | "neutral" | "attention" | "unhappy";

export type EyeOrder = {
  id: string;
  orderNumber: string;
  business: string;
  businessId: string;
  title: string | null;
  styleName: string | null;
  buyerFirstName: string | null;
  status: string;
  aiState: string | null;
  stage: { n: number; key: EyeStageKey; label: string };
  held: boolean;
  physical: boolean;
  stageSince: string;
  placedAt: string | null;
  dueAt: string | null;
  delayed: boolean;
  overdueHours: number;
  urgent: boolean;
  designer: string | null;
  revisionCount: number;
  waitingOnBuyer: boolean;
  print: { provider: string; status: string | null; tracking: string | null } | null;
  lastBuyerMessage: { snippet: string; at: string } | null;
  sentiment: EyeSentiment;
  exceptions: string[];
  href: string;
};

export type EyeEvent = { at: string; orderNumber: string; business: string; label: string };

export type EyeData = {
  generatedAt: string;
  businesses: { id: string; name: string; openCount: number }[];
  totals: {
    open: number;
    delayed: number;
    urgent: number;
    waitingOnBuyer: number;
    unhappy: number;
    printing: number;
    completedToday: number;
  };
  orders: EyeOrder[];
  events: EyeEvent[];
};

const STAGES: { key: EyeStageKey; label: string }[] = [
  { key: "intake", label: "Intake" },
  { key: "drawing", label: "Drawing" },
  { key: "qc", label: "QC" },
  { key: "buyer", label: "With buyer" },
  { key: "print", label: "Print" },
  { key: "done", label: "Done" },
];

/** Status (+ agent state) -> stage number. Covers every order_status value. */
export function eyeStage(status: string, aiState: string | null, physical: boolean): { n: number; label: string } {
  let n: number;
  switch (status) {
    case "awaiting_details":
    case "awaiting_photos":
    case "triage":
    case "ready_to_assign":
      n = 0;
      break;
    case "in_design":
      n = 1;
      break;
    case "awaiting_qc":
      n = 2;
      break;
    case "awaiting_approval":
      n = 3;
      break;
    case "approved":
    case "printing":
      n = 4;
      break;
    case "shipped":
    case "delivered":
    case "complete":
      n = 5;
      break;
    default:
      // on_hold, fulfillment_only, cancelled and anything new: intake until placed by ai_state below.
      n = 0;
  }
  // The agent's own state refines an in-flight order (never moves a finished one).
  if (n <= 3) {
    if (aiState === "qc" || aiState === "owner_review") n = 2;
    else if (aiState === "with_buyer") n = 3;
    else if ((aiState === "claimed" || aiState === "revision" || aiState === "revision_claimed" || aiState === "queued") && status === "in_design") n = 1;
  }
  let label = STAGES[n].label;
  if (n === 4 && !physical) label = "Delivering";
  return { n, label };
}

const UNHAPPY_RE = /refund|disappoint|upset|unacceptable|terrible|awful|wrong (order|portrait)|still (haven'?t|waiting)|never (received|got)|chargeback|cancel my/i;
const ANGRY_EXC_RE = /refund|angry|upset|complaint|chargeback|dispute|unhappy/i;
const HAPPY_RE = /thank|love|perfect|amazing|beautiful|gorgeous|awesome|wonderful|great job|so good/i;
const ATTENTION_KINDS = new Set(["reply_unclear", "buyer_question", "unmatched_reply", "stuck_order"]);

function plain(body: string | null): string {
  return (body ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/^>.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(body: string | null): string {
  const t = plain(body);
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

function eventLabel(action: string, from: string | null, to: string | null): string {
  if (to && to !== from) {
    if (to === "shipped") return "shipped";
    if (to === "complete" || to === "delivered") return "completed";
    return `moved to ${stageLabel(to)}`;
  }
  const a = action.replace(/[._-]+/g, " ").trim();
  if (/inbound|buyer.*repl|repl.*buyer|message.*received/i.test(a)) return "buyer replied";
  return a ? a.toLowerCase() : "updated";
}

export async function getEyeData(scope: RequestUser, nowInput: Date = new Date()): Promise<EyeData> {
  const now = nowInput;
  const recentCut = new Date(now.getTime() - 7 * DAY);
  const startToday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  return withUserContext(scope, async (tx) => {
    const biz = await tx.select({ id: businesses.id, name: businesses.name }).from(businesses).orderBy(businesses.name);
    const nameOf = new Map(biz.map((b) => [b.id, b.name]));

    const rows = await tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
        businessId: orders.businessId,
        status: orders.status,
        aiState: orders.aiState,
        revisionCount: orders.revisionCount,
        dueAt: orders.dueAt,
        placedAt: orders.placedAt,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
        urgentAt: orders.urgentAt,
        buyerFirst: customers.firstName,
        designer: users.name,
      })
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true)))
      .leftJoin(users, eq(users.id, assignments.designerId))
      .where(
        // Live orders, plus archived orders that are still owed: a bulk archive sweep
        // is not "done" and used to hide whole shops' backlogs from the Eye.
        and(
          or(liveOrderWhere(), archivedUnfinishedWhere()),
          or(
            notInArray(orders.status, [...CLOSED, "shipped"]),
            and(inArray(orders.status, [...OUT]), gte(orders.updatedAt, recentCut)),
          ),
        ),
      );

    const ids = rows.map((r) => r.id);
    const empty = <T,>() => Promise.resolve([] as T[]);

    const [items, transitions, inbound, excs, prints, decisions, feed] = await Promise.all([
      ids.length
        ? tx
            .select({
              orderId: orderItems.orderId,
              title: orderItems.title,
              style: orderItems.style,
              productType: orderItems.productType,
            })
            .from(orderItems)
            .where(inArray(orderItems.orderId, ids))
        : empty<{ orderId: string; title: string | null; style: string | null; productType: "digital" | "physical" }>(),
      ids.length
        ? tx
            .selectDistinctOn([activityLog.orderId, activityLog.toState], {
              orderId: activityLog.orderId,
              toState: activityLog.toState,
              at: activityLog.createdAt,
            })
            .from(activityLog)
            .where(and(inArray(activityLog.orderId, ids), sql`${activityLog.toState} is not null`))
            .orderBy(activityLog.orderId, activityLog.toState, desc(activityLog.createdAt))
        : empty<{ orderId: string | null; toState: string | null; at: Date }>(),
      ids.length
        ? tx
            .selectDistinctOn([messages.orderId], { orderId: messages.orderId, body: messages.body, at: messages.createdAt })
            .from(messages)
            .where(and(inArray(messages.orderId, ids), eq(messages.direction, "inbound"), isNull(messages.archivedAt)))
            .orderBy(messages.orderId, desc(messages.createdAt))
        : empty<{ orderId: string | null; body: string | null; at: Date }>(),
      ids.length
        ? tx
            .select({ orderId: exceptions.orderId, kind: exceptions.kind, summary: exceptions.summary })
            .from(exceptions)
            .where(and(eq(exceptions.status, "open"), inArray(exceptions.orderId, ids)))
        : empty<{ orderId: string | null; kind: string; summary: string }>(),
      ids.length
        ? tx
            .selectDistinctOn([printJobs.orderId], {
              orderId: printJobs.orderId,
              provider: printJobs.provider,
              status: printJobs.status,
              providerStatus: printJobs.providerStatus,
              tracking: printJobs.trackingNumber,
            })
            .from(printJobs)
            .where(inArray(printJobs.orderId, ids))
            .orderBy(printJobs.orderId, desc(printJobs.createdAt))
        : empty<{ orderId: string; provider: string; status: string | null; providerStatus: string | null; tracking: string | null }>(),
      ids.length
        ? tx
            .selectDistinctOn([proofs.orderId], { orderId: proofs.orderId, decision: proofs.decision })
            .from(proofs)
            .where(and(inArray(proofs.orderId, ids), sql`${proofs.decidedAt} is not null`))
            .orderBy(proofs.orderId, desc(proofs.decidedAt))
        : empty<{ orderId: string; decision: "approved" | "revision" | null }>(),
      tx
        .select({
          at: activityLog.createdAt,
          action: activityLog.action,
          from: activityLog.fromState,
          to: activityLog.toState,
          businessId: activityLog.businessId,
          number: orders.platformOrderName,
          fallbackNumber: orders.platformOrderId,
        })
        .from(activityLog)
        .innerJoin(orders, eq(orders.id, activityLog.orderId))
        .where(liveOrderWhere())
        .orderBy(desc(activityLog.createdAt))
        .limit(30),
    ]);

    const itemBy = new Map<string, (typeof items)[number]>();
    const physicalBy = new Map<string, boolean>();
    for (const i of items) {
      if (!itemBy.has(i.orderId)) itemBy.set(i.orderId, i);
      if (i.productType === "physical") physicalBy.set(i.orderId, true);
    }
    // Latest transition INTO the order's current status.
    const enteredBy = new Map<string, Date>();
    const transBy = new Map<string, Map<string, Date>>();
    for (const t of transitions) {
      if (!t.orderId || !t.toState) continue;
      const m = transBy.get(t.orderId) ?? new Map<string, Date>();
      m.set(t.toState, t.at);
      transBy.set(t.orderId, m);
    }
    const inboundBy = new Map(inbound.filter((m) => m.orderId).map((m) => [m.orderId as string, m]));
    const excBy = new Map<string, { kind: string; summary: string }[]>();
    for (const e of excs) {
      if (!e.orderId) continue;
      const l = excBy.get(e.orderId) ?? [];
      l.push(e);
      excBy.set(e.orderId, l);
    }
    const printBy = new Map(prints.map((p) => [p.orderId, p]));
    const decisionBy = new Map(decisions.map((d) => [d.orderId, d.decision]));

    const out: EyeOrder[] = rows.map((o) => {
      const item = itemBy.get(o.id);
      const physical = physicalBy.get(o.id) ?? false;
      const stage = eyeStage(o.status, o.aiState, physical);
      const since = transBy.get(o.id)?.get(o.status) ?? o.updatedAt ?? o.createdAt;
      enteredBy.set(o.id, since);
      const finished = (OUT as readonly string[]).includes(o.status);

      const timer = stageTimer({
        status: o.status,
        derivedStatus: "",
        isPhysical: physical,
        stageStartedAt: since.toISOString(),
        now,
      });
      // Delayed = past the order's own due date. Only an order with NO due date
      // falls back to the stage clock, and only when a real transition into this
      // stage was logged (a backfilled order's updatedAt says nothing about delay).
      const stageOver = !o.dueAt && !!timer.isOverdue && !!transBy.get(o.id)?.get(o.status);
      const dueOver = !!o.dueAt && o.dueAt.getTime() < now.getTime();
      const delayed = !finished && (stageOver || dueOver);
      const overdueHours = !finished && dueOver ? Math.round(((now.getTime() - (o.dueAt as Date).getTime()) / 3600000) * 10) / 10 : 0;

      const waitingOnBuyer =
        o.status === "awaiting_details" || o.status === "awaiting_photos" || o.aiState === "with_buyer" || stage.n === 3;
      const pj = printBy.get(o.id);
      const last = inboundBy.get(o.id);
      const lastText = last ? plain(last.body) : "";
      const exc = excBy.get(o.id) ?? [];
      const kinds = exc.map((e) => e.kind);
      const rev = o.revisionCount ?? 0;

      let sentiment: EyeSentiment = "neutral";
      const unhappy =
        UNHAPPY_RE.test(lastText) || rev >= 3 || exc.some((e) => ANGRY_EXC_RE.test(e.kind) || ANGRY_EXC_RE.test(e.summary));
      const attention = kinds.some((k) => ATTENTION_KINDS.has(k)) || delayed || rev === 2;
      if (unhappy) sentiment = "unhappy";
      else if (attention) sentiment = "attention";
      else if (HAPPY_RE.test(lastText) || decisionBy.get(o.id) === "approved") sentiment = "happy";

      return {
        id: o.id,
        orderNumber: o.number ?? o.fallbackNumber ?? "Order",
        business: nameOf.get(o.businessId) ?? "",
        businessId: o.businessId,
        title: item?.title ? item.title.slice(0, 80) : null,
        styleName: item?.style ?? null,
        buyerFirstName: o.buyerFirst ?? null,
        status: o.status,
        aiState: o.aiState ?? null,
        stage: { n: stage.n, key: STAGES[stage.n].key, label: stage.label },
        held: o.status === "on_hold" || o.status === "fulfillment_only",
        physical,
        stageSince: since.toISOString(),
        placedAt: (o.placedAt ?? o.createdAt).toISOString(),
        dueAt: o.dueAt ? o.dueAt.toISOString() : null,
        delayed,
        overdueHours,
        urgent: !!o.urgentAt,
        designer: o.designer ?? null,
        revisionCount: rev,
        waitingOnBuyer: !finished && waitingOnBuyer,
        print: pj ? { provider: pj.provider, status: pj.providerStatus ?? pj.status, tracking: pj.tracking } : null,
        lastBuyerMessage: last && lastText ? { snippet: snippet(last.body), at: last.at.toISOString() } : null,
        sentiment,
        exceptions: kinds,
        href: `/orders/${o.id}`,
      };
    });

    const open = out.filter((o) => o.stage.n < 5);
    const totals = {
      open: open.length,
      delayed: open.filter((o) => o.delayed).length,
      urgent: open.filter((o) => o.urgent).length,
      waitingOnBuyer: open.filter((o) => o.waitingOnBuyer).length,
      unhappy: open.filter((o) => o.sentiment === "unhappy").length,
      printing: open.filter((o) => o.stage.n === 4).length,
      completedToday: out.filter((o) => o.stage.n === 5 && new Date(enteredBy.get(o.id) ?? 0) >= startToday).length,
    };
    // Any shop that has orders but is missing from the businesses read still gets a sector.
    const known = new Set(biz.map((b) => b.id));
    for (const o of out) {
      if (!known.has(o.businessId)) {
        known.add(o.businessId);
        biz.push({ id: o.businessId, name: o.business || "Shop" });
      }
    }
    const businesses_ = biz.map((b) => ({ id: b.id, name: b.name, openCount: open.filter((o) => o.businessId === b.id).length }));

    const events: EyeEvent[] = feed.map((f) => ({
      at: f.at.toISOString(),
      orderNumber: f.number ?? f.fallbackNumber ?? "Order",
      business: nameOf.get(f.businessId) ?? "",
      label: eventLabel(f.action, f.from, f.to),
    }));

    return { generatedAt: now.toISOString(), businesses: businesses_, totals, orders: out, events };
  });
}
