import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import {
  assignments,
  customers,
  messages,
  orderItems,
  orders,
  printJobs,
  proofs,
  shops,
  users,
} from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { parseEtsyReceiptReview } from "@/lib/integrations/etsy/receipt-review";
import type { OrderStatus } from "./transitions";

/**
 * The Today queue: one ranked list across every shop in the selected business,
 * sorted by what hurts most. Each row is ONE plain-English thing to do and ONE
 * button that goes straight to the place to do it. Nothing here changes order
 * state; it only reads the same tables the boards and dashboard already use.
 */

export type TodayKind =
  | "reply" // a customer wrote and nobody answered
  | "details" // Etsy order still needs the details from the receipt
  | "proof_silent" // proof sent, customer quiet 3+ days
  | "qc" // portrait waiting for a quality check
  | "tracking" // print job / printing order with no tracking
  | "designer_late" // designer past their deadline
  | "unassigned" // ready but nobody has it
  | "print" // approved physical order, print not started
  | "triage" // draft order needs its type chosen
  | "photos_silent"; // waiting on photos too long

export type TodayBand = "now" | "today" | "soon";

export type TodayItem = {
  id: string; // `${orderId}:${kind}`
  orderId: string;
  kind: TodayKind;
  band: TodayBand;
  /** Sort weight; higher = nearer the top. */
  score: number;
  shop: string;
  platform: "etsy" | "shopify" | "manual";
  orderNumber: string;
  customerFirst: string;
  status: OrderStatus;
  /** Exactly what to do, in plain English. */
  todo: string;
  /** How long this has been waiting, e.g. "2 days". */
  age: string;
  ageMs: number;
  action: { label: string; href: string };
};

export type TodayQueue = {
  items: TodayItem[];
  groups: { now: TodayItem[]; today: TodayItem[]; soon: TodayItem[] };
  counts: { now: number; today: number; soon: number; total: number };
  shops: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ACTIVE: OrderStatus[] = [
  "awaiting_details",
  "triage",
  "awaiting_photos",
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
  "awaiting_approval",
  "approved",
  "printing",
  "shipped",
  "fulfillment_only",
];

export function formatAge(ms: number): string {
  const abs = Math.max(0, ms);
  if (abs < HOUR) return `${Math.max(1, Math.round(abs / 60_000))} min`;
  if (abs < DAY) {
    const h = Math.round(abs / HOUR);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.floor(abs / DAY);
  return `${d} day${d === 1 ? "" : "s"}`;
}

function firstName(input: { first: string | null; email: string | null; rawImport: unknown }): string {
  if (input.first?.trim()) return input.first.trim().split(/\s+/)[0]!;
  const buyer = parseEtsyReceiptReview(input.rawImport).buyerName;
  if (buyer) return buyer.trim().split(/\s+/)[0]!;
  if (input.email) return input.email.split("@")[0]!;
  return "the customer";
}

export async function getTodayQueue(user: RequestUser, businessId: string, now = new Date()): Promise<TodayQueue> {
  return withUserContext(user, async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
        status: orders.status,
        source: orders.source,
        dueAt: orders.dueAt,
        placedAt: orders.placedAt,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
        rawImport: orders.rawImport,
        shopName: shops.name,
        customerFirst: customers.firstName,
        customerEmail: customers.email,
        designerName: users.name,
        designerEmail: users.email,
        assignmentDueAt: assignments.dueAt,
        assignedAt: assignments.assignedAt,
      })
      .from(orders)
      .leftJoin(shops, eq(shops.id, orders.shopId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true)))
      .leftJoin(users, eq(users.id, assignments.designerId))
      .where(and(eq(orders.businessId, businessId), liveOrderWhere(), inArray(orders.status, ACTIVE)))
      .orderBy(desc(orders.createdAt))
      .limit(500);

    const ids = rows.map((r) => r.id);
    if (!ids.length) return empty();

    const [items, prints, proofRows, msgRows] = await Promise.all([
      tx
        .select({ orderId: orderItems.orderId, productType: orderItems.productType })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids)),
      tx
        .select({
          orderId: printJobs.orderId,
          provider: printJobs.provider,
          trackingNumber: printJobs.trackingNumber,
          createdAt: printJobs.createdAt,
        })
        .from(printJobs)
        .where(inArray(printJobs.orderId, ids))
        .orderBy(desc(printJobs.createdAt)),
      tx
        .select({ orderId: proofs.orderId, sentAt: proofs.sentAt, decision: proofs.decision, createdAt: proofs.createdAt })
        .from(proofs)
        .where(inArray(proofs.orderId, ids))
        .orderBy(desc(proofs.createdAt)),
      // Latest message per order, either direction: the newest inbound with no
      // outbound after it means a customer is waiting on us.
      tx
        .select({
          orderId: messages.orderId,
          direction: messages.direction,
          at: sql<Date>`coalesce(${messages.sentAt}, ${messages.createdAt})`,
        })
        .from(messages)
        .where(and(inArray(messages.orderId, ids), isNull(messages.archivedAt), isNull(messages.suppressedAt)))
        .orderBy(desc(sql`coalesce(${messages.sentAt}, ${messages.createdAt})`)),
    ]);

    const physical = new Set<string>();
    for (const it of items) if (it.productType === "physical") physical.add(it.orderId);
    const latestPrint = new Map<string, (typeof prints)[number]>();
    for (const p of prints) if (!latestPrint.has(p.orderId)) latestPrint.set(p.orderId, p);
    const latestProof = new Map<string, (typeof proofRows)[number]>();
    for (const p of proofRows) if (!latestProof.has(p.orderId)) latestProof.set(p.orderId, p);
    const latestMsg = new Map<string, (typeof msgRows)[number]>();
    for (const m of msgRows) if (m.orderId && !latestMsg.has(m.orderId)) latestMsg.set(m.orderId, m);

    const out: TodayItem[] = [];
    const t = now.getTime();

    for (const o of rows) {
      const base = {
        orderId: o.id,
        shop: o.shopName ?? (o.source === "manual" ? "Manual" : o.source),
        platform: o.source,
        orderNumber: o.number ?? o.fallbackNumber,
        customerFirst: firstName({ first: o.customerFirst, email: o.customerEmail, rawImport: o.rawImport }),
        status: o.status,
      };
      const name = base.customerFirst;
      const stageStart = (o.updatedAt ?? o.createdAt).getTime();
      const push = (kind: TodayKind, sinceMs: number, todo: string, action: TodayItem["action"], weight: number) => {
        const ageMs = Math.max(0, t - sinceMs);
        const score = weight + Math.min(ageMs / DAY, 14); // older climbs, capped
        out.push({ ...base, id: `${o.id}:${kind}`, kind, band: "soon", score, todo, age: formatAge(ageMs), ageMs, action });
      };

      // 1. Customer waiting on a reply.
      const m = latestMsg.get(o.id);
      if (m && m.direction === "inbound") {
        const since = new Date(m.at).getTime();
        push("reply", since, `Reply to ${name}, waiting ${formatAge(t - since)}`, { label: "Reply", href: `/orders/${o.id}#reply` }, 100);
      }

      switch (o.status) {
        case "awaiting_details":
          push("details", stageStart, "Enter the details from the receipt", { label: "Enter details", href: `/orders/${o.id}/complete` }, 90);
          break;
        case "triage":
          push("triage", stageStart, "Choose what kind of order this is", { label: "Choose type", href: `/orders/${o.id}/complete` }, 85);
          break;
        case "awaiting_approval": {
          const proof = latestProof.get(o.id);
          const sent = (proof?.sentAt ?? proof?.createdAt)?.getTime() ?? stageStart;
          if (!proof?.decision && t - sent >= 3 * DAY) {
            push("proof_silent", sent, `Nudge ${name}, no answer on the proof for ${formatAge(t - sent)}`, { label: "Send a nudge", href: `/orders/${o.id}#reply` }, 80);
          }
          break;
        }
        case "awaiting_qc":
          push("qc", stageStart, "Check the portrait and pass or fail it", { label: "Check it", href: `/qc/${o.id}` }, 70);
          break;
        case "printing": {
          const p = latestPrint.get(o.id);
          if (!p?.trackingNumber) {
            const provider = p?.provider === "gelato" ? "Gelato" : p?.provider === "lumaprints" ? "Luma Prints" : "the printer";
            push("tracking", p?.createdAt.getTime() ?? stageStart, `Add the tracking number from ${provider}`, { label: "Add tracking", href: `/orders/${o.id}#tracking` }, 60);
          }
          break;
        }
        case "shipped": {
          const p = latestPrint.get(o.id);
          if (physical.has(o.id) && !p?.trackingNumber) {
            push("tracking", stageStart, "Add the tracking number so the customer can follow it", { label: "Add tracking", href: `/orders/${o.id}#tracking` }, 55);
          }
          break;
        }
        case "in_design": {
          const deadline = o.assignmentDueAt ?? o.dueAt;
          if (deadline && deadline.getTime() < t) {
            const who = o.designerName ?? o.designerEmail ?? "The designer";
            push("designer_late", deadline.getTime(), `${who} is ${formatAge(t - deadline.getTime())} late. Nudge or reassign`, { label: "Reassign", href: `/orders/${o.id}#designer` }, 65);
          }
          break;
        }
        case "ready_to_assign":
          if (!o.designerName && !o.designerEmail) {
            push("unassigned", stageStart, "Pick a designer for this order", { label: "Assign", href: `/orders/${o.id}#designer` }, 50);
          } else if (o.assignedAt && t - o.assignedAt.getTime() > 12 * HOUR) {
            const who = o.designerName ?? o.designerEmail ?? "The designer";
            push("designer_late", o.assignedAt.getTime(), `${who} has not started after ${formatAge(t - o.assignedAt.getTime())}. Nudge or reassign`, { label: "Reassign", href: `/orders/${o.id}#designer` }, 45);
          }
          break;
        case "approved":
          if (physical.has(o.id) && !latestPrint.has(o.id)) {
            push("print", stageStart, "Approved. Send it to print", { label: "Send to print", href: `/orders/${o.id}#print` }, 58);
          }
          break;
        case "fulfillment_only":
          if (!latestPrint.has(o.id)) {
            push("print", stageStart, "No design needed. Send it to print", { label: "Send to print", href: `/orders/${o.id}#print` }, 40);
          }
          break;
        case "awaiting_photos":
          if (t - stageStart > 2 * DAY) {
            push("photos_silent", stageStart, `Ask ${name} for the photos again, ${formatAge(t - stageStart)} with none`, { label: "Ask again", href: `/orders/${o.id}#reply` }, 35);
          }
          break;
        default:
          break;
      }
    }

    // Bands: Now = a person is waiting on us or something is late; Today = work
    // that is ours and ready; Soon = nudges and housekeeping.
    for (const it of out) {
      if (it.kind === "reply" || it.kind === "proof_silent" || it.kind === "designer_late" || (it.kind === "details" && it.ageMs > 12 * HOUR) || (it.kind === "tracking" && it.ageMs > 3 * DAY)) it.band = "now";
      else if (it.kind === "details" || it.kind === "qc" || it.kind === "tracking" || it.kind === "unassigned" || it.kind === "print" || it.kind === "triage") it.band = "today";
      else it.band = "soon";
    }
    const bandRank: Record<TodayBand, number> = { now: 0, today: 1, soon: 2 };
    out.sort((a, b) => bandRank[a.band] - bandRank[b.band] || b.score - a.score || b.ageMs - a.ageMs);

    const groups = {
      now: out.filter((i) => i.band === "now"),
      today: out.filter((i) => i.band === "today"),
      soon: out.filter((i) => i.band === "soon"),
    };
    const shopCount = new Set(rows.map((r) => r.shopName)).size;
    return {
      items: out,
      groups,
      counts: { now: groups.now.length, today: groups.today.length, soon: groups.soon.length, total: out.length },
      shops: shopCount,
    };
  });
}

function empty(): TodayQueue {
  return { items: [], groups: { now: [], today: [], soon: [] }, counts: { now: 0, today: 0, soon: 0, total: 0 }, shops: 0 };
}
