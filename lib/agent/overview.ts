import { and, desc, eq, gte, inArray, notInArray, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, assignments, businesses, exceptions, orders, users } from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { stageTimer } from "@/lib/orders/stage-timers";

/** Statuses that are finished: they never appear as an open order. */
const CLOSED = ["complete", "cancelled", "delivered"] as const;
/** Statuses that count as "out the door" for the daily digest. */
const OUT = ["shipped", "delivered", "complete"] as const;

export type NextActor = "Agent" | "Designer" | "VA" | "Buyer" | "Print";

export const STAGE_LABELS: Record<string, string> = {
  awaiting_details: "Awaiting details",
  awaiting_photos: "Awaiting photos",
  ready_to_assign: "Ready to assign",
  in_design: "In design",
  awaiting_qc: "Awaiting QC",
  awaiting_approval: "Awaiting buyer approval",
  approved: "Approved",
  printing: "Printing",
  shipped: "Shipped",
  on_hold: "On hold",
  triage: "Triage",
  fulfillment_only: "Fulfilment only",
};

export function stageLabel(status: string): string {
  if (STAGE_LABELS[status]) return STAGE_LABELS[status];
  const spaced = status.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Who has to move the order next, from its real stage. */
export function nextActor(status: string, hasDesigner: boolean): NextActor {
  switch (status) {
    case "awaiting_photos":
    case "awaiting_approval":
      return "Buyer";
    case "in_design":
      return hasDesigner ? "Designer" : "VA";
    case "awaiting_qc":
    case "approved":
    case "on_hold":
    case "triage":
    case "fulfillment_only":
      return "VA";
    case "printing":
    case "shipped":
      return "Print";
    default:
      // awaiting_details, ready_to_assign and anything new: the agent's intake and assignment.
      return "Agent";
  }
}

export type OverviewRow = {
  id: string;
  orderNumber: string;
  businessId: string;
  businessName: string;
  status: string;
  stage: string;
  stageStartedAt: string;
  timeInStageMs: number;
  /** Target for this stage in ms, or null when the stage has no timer. */
  targetMs: number | null;
  overrunMs: number;
  delayed: boolean;
  designer: string | null;
  nextActor: NextActor;
};

export type DigestLine = {
  businessId: string;
  businessName: string;
  inToday: number;
  outToday: number;
  overdue: number;
  exceptionsWaiting: number;
};

export type Overview = {
  rows: OverviewRow[];
  digest: DigestLine[];
  businesses: { id: string; name: string }[];
  stages: { value: string; label: string }[];
  now: string;
};

/** Midnight today in the business's own zone (Melbourne, matches lib/time), as an instant. */
function startOfToday(now: Date): Date {
  const tz = "Australia/Melbourne";
  const wallMs = (at: Date) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric",
      }).formatToParts(at).map((x) => [x.type, Number(x.value)]),
    );
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  const offset = wallMs(now) - Math.floor(now.getTime() / 1000) * 1000;
  const w = new Date(wallMs(now));
  const midnightWall = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate());
  return new Date(midnightWall - offset);
}

/**
 * Every open order, one line each, most delayed first, plus a per-business
 * daily digest. Archived orders never count. `scope` is the signed-in user, so
 * row-level security decides which businesses they see.
 */
export async function getOverview(scope: RequestUser, nowInput: Date = new Date()): Promise<Overview> {
  const now = nowInput;
  const today = startOfToday(now);

  return withUserContext(scope, async (tx) => {
    const biz = await tx.select({ id: businesses.id, name: businesses.name }).from(businesses).orderBy(businesses.name);

    const open = await tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
        businessId: orders.businessId,
        status: orders.status,
        updatedAt: orders.updatedAt,
        createdAt: orders.createdAt,
        designer: users.name,
      })
      .from(orders)
      .leftJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true)))
      .leftJoin(users, eq(users.id, assignments.designerId))
      .where(and(liveOrderWhere(), notInArray(orders.status, [...CLOSED])));

    const ids = open.map((o) => o.id);
    // When each order entered its current stage: the latest activity row that moved it there.
    const entered = new Map<string, Date>();
    if (ids.length) {
      const rows = await tx
        .select({ orderId: activityLog.orderId, toState: activityLog.toState, at: activityLog.createdAt })
        .from(activityLog)
        .where(and(inArray(activityLog.orderId, ids), sql`${activityLog.toState} is not null`))
        .orderBy(desc(activityLog.createdAt));
      const status = new Map(open.map((o) => [o.id, o.status]));
      for (const r of rows) {
        if (!r.orderId || entered.has(r.orderId)) continue;
        if (r.toState === status.get(r.orderId)) entered.set(r.orderId, r.at);
      }
    }

    const nameOf = new Map(biz.map((b) => [b.id, b.name]));
    const rows: OverviewRow[] = open.map((o) => {
      const started = entered.get(o.id) ?? o.updatedAt ?? o.createdAt;
      const timer = stageTimer({
        status: o.status,
        derivedStatus: "",
        isPhysical: false,
        stageStartedAt: started.toISOString(),
        now,
      });
      const timeInStageMs = Math.max(now.getTime() - started.getTime(), 0);
      const targetMs =
        timer.deadlineAt && timer.startedAt
          ? new Date(timer.deadlineAt).getTime() - new Date(timer.startedAt).getTime()
          : null;
      const overrunMs = targetMs == null ? 0 : timeInStageMs - targetMs;
      return {
        id: o.id,
        orderNumber: o.number ?? o.fallbackNumber ?? "Order",
        businessId: o.businessId,
        businessName: nameOf.get(o.businessId) ?? "",
        status: o.status,
        stage: stageLabel(o.status),
        stageStartedAt: started.toISOString(),
        timeInStageMs,
        targetMs,
        overrunMs,
        delayed: targetMs != null && overrunMs > 0,
        designer: o.designer ?? null,
        nextActor: nextActor(o.status, !!o.designer),
      };
    });
    // Most delayed first (largest overrun), then oldest in stage.
    rows.sort((a, b) => (b.delayed ? b.overrunMs : -1) - (a.delayed ? a.overrunMs : -1) || b.timeInStageMs - a.timeInStageMs);

    const inRows = await tx
      .select({ businessId: orders.businessId, n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(liveOrderWhere(), gte(orders.createdAt, today)))
      .groupBy(orders.businessId);
    const outRows = await tx
      .select({ businessId: activityLog.businessId, n: sql<number>`count(distinct ${activityLog.orderId})::int` })
      .from(activityLog)
      .innerJoin(orders, eq(orders.id, activityLog.orderId))
      .where(and(liveOrderWhere(), gte(activityLog.createdAt, today), inArray(activityLog.toState, [...OUT])))
      .groupBy(activityLog.businessId);
    const excRows = await tx
      .select({ businessId: exceptions.businessId, n: sql<number>`count(*)::int` })
      .from(exceptions)
      .where(eq(exceptions.status, "open"))
      .groupBy(exceptions.businessId);

    const count = (list: { businessId: string; n: number }[], id: string) => list.find((r) => r.businessId === id)?.n ?? 0;
    const digest: DigestLine[] = biz.map((b) => ({
      businessId: b.id,
      businessName: b.name,
      inToday: count(inRows, b.id),
      outToday: count(outRows, b.id),
      overdue: rows.filter((r) => r.businessId === b.id && r.delayed).length,
      exceptionsWaiting: count(excRows, b.id),
    }));

    const stageSet = [...new Set(rows.map((r) => r.status))];
    return {
      rows,
      digest,
      businesses: biz,
      stages: stageSet.map((value) => ({ value, label: stageLabel(value) })).sort((a, b) => a.label.localeCompare(b.label)),
      now: now.toISOString(),
    };
  });
}
