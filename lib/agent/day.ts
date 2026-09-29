import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { withUserContext, type RequestUser, type Tx } from "@/lib/db";
import {
  activityLog,
  assets,
  assignments,
  businesses,
  customers,
  exceptions,
  orderItems,
  orders,
  proofs,
  shops,
  users,
} from "@/lib/db/schema";
import { liveOrderWhere } from "@/lib/orders/archive";
import { resolveChecklist, type ChecklistItem } from "@/lib/qc/checklist";
import { preparePrintOrder, PROVIDER_LABEL, type PrintBlocker } from "@/lib/print/prepare";
import { activePrintJob } from "@/lib/print/submit";
import { isR2Configured, presignGet } from "@/lib/storage/r2";

/**
 * Data for the Day screen (docs/AGENT_FIRST.md 3.4): one queue, three card
 * kinds. Portrait QC and revision QC are both orders in awaiting_qc; the
 * difference is whether the buyer already saw a proof and asked for changes.
 */

export type DayImage = { id: string; url: string | null };

type DayCardBase = {
  orderId: string;
  orderNumber: string;
  businessId: string;
  businessName: string;
  /** ISO time the order started waiting on this step. */
  waitingSince: string;
};

export type DayQcCard = DayCardBase & {
  productLine: string;
  designerName: string | null;
  buyerNotes: string | null;
  buyerPhotos: DayImage[];
  /** The checks a bounce can point at (this shop's checklist). */
  checklist: ChecklistItem[];
  /** The finished portrait to check (newest delivered version). */
  portrait: DayImage | null;
};

export type DayRevisionCard = DayQcCard & {
  /** The buyer's revision request, verbatim. */
  revisionRequest: string;
  /** The proof the buyer saw before asking for changes. */
  previousProof: DayImage | null;
};

export type DayPrintCard = DayCardBase & {
  productLine: string;
  provider: string | null;
  providerLabel: string | null;
  costText: string | null;
  fileUrl: string | null;
  fileName: string | null;
  addressLines: string[];
  buyerName: string | null;
  blockers: PrintBlocker[];
  ready: boolean;
};

export type DayQueue = {
  portrait: DayQcCard[];
  revision: DayRevisionCard[];
  print: DayPrintCard[];
  doneToday: number;
  openExceptions: number;
};

const CUSTOMER_SEND_BACK_FROM = ["awaiting_approval", "approved", "printing", "shipped", "delivered", "complete"] as const;
const PRINT_QUEUE_LIMIT = 50;

async function resolveUrl(a: { url: string | null; storage: string; r2Key: string | null }): Promise<string | null> {
  if (a.url) return a.url;
  if (a.storage === "r2" && a.r2Key && isR2Configured()) {
    try {
      return await presignGet(a.r2Key);
    } catch {
      return null;
    }
  }
  return null;
}

function sizeFrom(options: unknown): string | null {
  if (!Array.isArray(options)) return null;
  const hit = (options as Array<{ name?: string; value?: string }>).find((o) => /size|dimension/i.test(o?.name ?? ""));
  return hit?.value?.trim() || null;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function money(cost: number | null, currency: string | null): string | null {
  if (cost == null) return null;
  return `${currency ?? "USD"} ${cost.toFixed(2)}`;
}

export async function getDayQueue(user: RequestUser, businessScope: string | null): Promise<DayQueue> {
  return withUserContext(user, async (tx) => {
    const scoped = businessScope && businessScope !== "all" ? eq(orders.businessId, businessScope) : undefined;
    const [qcRows, approvedRows, doneRows, openRows] = await Promise.all([
      tx
        .select({
          id: orders.id,
          number: orders.platformOrderName,
          fallback: orders.platformOrderId,
          businessId: orders.businessId,
          businessName: businesses.name,
          notes: orders.notes,
          shopId: orders.shopId,
          updatedAt: orders.updatedAt,
        })
        .from(orders)
        .innerJoin(businesses, eq(businesses.id, orders.businessId))
        .where(and(eq(orders.status, "awaiting_qc"), liveOrderWhere(), scoped))
        .orderBy(asc(orders.updatedAt))
        .limit(200),
      tx
        .select({
          id: orders.id,
          number: orders.platformOrderName,
          fallback: orders.platformOrderId,
          businessId: orders.businessId,
          businessName: businesses.name,
          customerId: orders.customerId,
          updatedAt: orders.updatedAt,
        })
        .from(orders)
        .innerJoin(businesses, eq(businesses.id, orders.businessId))
        .where(and(eq(orders.status, "approved"), liveOrderWhere(), scoped))
        .orderBy(asc(orders.updatedAt))
        .limit(PRINT_QUEUE_LIMIT),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.actorId, user.id),
            gte(activityLog.createdAt, startOfToday()),
            sql`(${activityLog.action} = 'print.submitted' or (${activityLog.fromState} in ('awaiting_qc', 'approved') and ${activityLog.toState} in ('awaiting_approval', 'in_design')))`,
            businessScope && businessScope !== "all" ? eq(activityLog.businessId, businessScope) : undefined,
          ),
        ),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(exceptions)
        .where(and(eq(exceptions.status, "open"), businessScope && businessScope !== "all" ? eq(exceptions.businessId, businessScope) : undefined)),
    ]);

    const [portraitAndRevision, print] = await Promise.all([
      buildQcCards(tx, qcRows),
      buildPrintCards(tx, approvedRows),
    ]);
    return {
      portrait: portraitAndRevision.portrait,
      revision: portraitAndRevision.revision,
      print,
      doneToday: Number(doneRows[0]?.n ?? 0),
      openExceptions: Number(openRows[0]?.n ?? 0),
    };
  });
}

type QcRow = {
  id: string;
  number: string | null;
  fallback: string;
  businessId: string;
  businessName: string;
  notes: string | null;
  shopId: string;
  updatedAt: Date;
};

async function buildQcCards(tx: Tx, rows: QcRow[]): Promise<{ portrait: DayQcCard[]; revision: DayRevisionCard[] }> {
  if (!rows.length) return { portrait: [], revision: [] };
  const ids = rows.map((r) => r.id);
  const [shopRows, items, refs, versions, designers, qcEntries, revisionProofs, sendBacks] = await Promise.all([
    tx
      .select({ id: shops.id, checklistVersion: shops.checklistVersion, integrationConfig: shops.integrationConfig })
      .from(shops)
      .where(inArray(shops.id, [...new Set(rows.map((r) => r.shopId))])),
    tx
      .select({ orderId: orderItems.orderId, title: orderItems.title, options: orderItems.options, style: orderItems.style })
      .from(orderItems)
      .where(inArray(orderItems.orderId, ids))
      .orderBy(asc(orderItems.id)),
    tx
      .select({ id: assets.id, orderId: assets.orderId, url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
      .from(assets)
      .where(and(inArray(assets.orderId, ids), eq(assets.type, "reference"), isNull(assets.deletedAt)))
      .orderBy(asc(assets.createdAt)),
    tx
      .select({ id: assets.id, orderId: assets.orderId, url: assets.url, storage: assets.storage, r2Key: assets.r2Key, createdAt: assets.createdAt })
      .from(assets)
      .where(and(inArray(assets.orderId, ids), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
      .orderBy(desc(assets.createdAt)),
    tx
      .select({ orderId: assignments.orderId, name: users.name, email: users.email })
      .from(assignments)
      .innerJoin(users, eq(users.id, assignments.designerId))
      .where(and(inArray(assignments.orderId, ids), eq(assignments.active, true))),
    tx
      .select({ orderId: activityLog.orderId, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(and(inArray(activityLog.orderId, ids), eq(activityLog.toState, "awaiting_qc")))
      .orderBy(desc(activityLog.createdAt)),
    tx
      .select({ orderId: proofs.orderId, notes: proofs.revisionNotes, decidedAt: proofs.decidedAt })
      .from(proofs)
      .where(and(inArray(proofs.orderId, ids), eq(proofs.decision, "revision")))
      .orderBy(desc(proofs.decidedAt)),
    tx
      .select({ orderId: activityLog.orderId, metadata: activityLog.metadata, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          inArray(activityLog.orderId, ids),
          eq(activityLog.action, "order.in_design"),
          inArray(activityLog.fromState, [...CUSTOMER_SEND_BACK_FROM]),
        ),
      )
      .orderBy(desc(activityLog.createdAt)),
  ]);

  const firstBy = <T extends { orderId: string | null }>(list: T[]) => {
    const m = new Map<string, T>();
    for (const r of list) if (r.orderId && !m.has(r.orderId)) m.set(r.orderId, r);
    return m;
  };
  const groupBy = <T extends { orderId: string | null }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of list) if (r.orderId) m.set(r.orderId, [...(m.get(r.orderId) ?? []), r]);
    return m;
  };
  const checklistBy = new Map(shopRows.map((sh) => [sh.id, resolveChecklist(sh).items]));
  const itemsBy = groupBy(items);
  const refsBy = groupBy(refs);
  const versionsBy = groupBy(versions);
  const designerBy = firstBy(designers);
  const qcAtBy = firstBy(qcEntries);
  const proofBy = firstBy(revisionProofs);
  const sendBackBy = firstBy(sendBacks);

  const portrait: DayQcCard[] = [];
  const revision: DayRevisionCard[] = [];
  for (const r of rows) {
    const its = itemsBy.get(r.id) ?? [];
    const title = its[0]?.title ?? "Portrait";
    const size = sizeFrom(its[0]?.options);
    const style = its[0]?.style;
    const productLine = [title, size, style].filter(Boolean).join(" / ");
    const d = designerBy.get(r.id);
    const vs = versionsBy.get(r.id) ?? [];
    const latest = vs[0] ?? null;
    const [buyerPhotos, portraitImg, previous] = await Promise.all([
      Promise.all((refsBy.get(r.id) ?? []).map(async (a) => ({ id: a.id, url: await resolveUrl(a) }))),
      latest ? resolveUrl(latest) : Promise.resolve(null),
      vs[1] ? resolveUrl(vs[1]) : Promise.resolve(null),
    ]);
    const base: DayQcCard = {
      orderId: r.id,
      orderNumber: r.number ?? r.fallback,
      businessId: r.businessId,
      businessName: r.businessName,
      waitingSince: (qcAtBy.get(r.id)?.createdAt ?? r.updatedAt).toISOString(),
      productLine,
      designerName: d ? (d.name ?? d.email) : null,
      buyerNotes: r.notes?.trim() || null,
      buyerPhotos,
      checklist: checklistBy.get(r.shopId) ?? [],
      portrait: latest ? { id: latest.id, url: portraitImg } : null,
    };

    // A revision is QC of a redo the buyer asked for: the newest send-back
    // from a customer-facing stage is older than the newest delivered version.
    const proof = proofBy.get(r.id);
    const back = sendBackBy.get(r.id);
    const backAtMs = Math.max(proof?.decidedAt?.getTime() ?? 0, back?.createdAt.getTime() ?? 0);
    const metaReason = back?.metadata && typeof back.metadata === "object" ? (back.metadata as Record<string, unknown>).revisionReason : null;
    const request = (proof?.notes?.trim() || (typeof metaReason === "string" ? metaReason.trim() : "")) || "";
    if (backAtMs > 0 && latest && latest.createdAt.getTime() > backAtMs) {
      revision.push({
        ...base,
        revisionRequest: request || "The buyer asked for changes (no note left).",
        previousProof: vs[1] ? { id: vs[1].id, url: previous } : null,
      });
    } else {
      portrait.push(base);
    }
  }
  return { portrait, revision };
}

type ApprovedRow = {
  id: string;
  number: string | null;
  fallback: string;
  businessId: string;
  businessName: string;
  customerId: string | null;
  updatedAt: Date;
};

async function buildPrintCards(tx: Tx, rows: ApprovedRow[]): Promise<DayPrintCard[]> {
  const cards: DayPrintCard[] = [];
  const custIds = rows.map((r) => r.customerId).filter((x): x is string => !!x);
  const custRows = custIds.length
    ? await tx.select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName }).from(customers).where(inArray(customers.id, custIds))
    : [];
  const custName = new Map(custRows.map((c) => [c.id, [c.firstName, c.lastName].filter(Boolean).join(" ") || null]));
  const enteredRows = rows.length
    ? await tx
        .select({ orderId: activityLog.orderId, createdAt: activityLog.createdAt })
        .from(activityLog)
        .where(and(inArray(activityLog.orderId, rows.map((r) => r.id)), eq(activityLog.toState, "approved")))
        .orderBy(desc(activityLog.createdAt))
    : [];
  const enteredBy = new Map<string, Date>();
  for (const e of enteredRows) if (e.orderId && !enteredBy.has(e.orderId)) enteredBy.set(e.orderId, e.createdAt);

  for (const r of rows) {
    if (await activePrintJob(tx, r.id)) continue; // already submitted
    const plan = await preparePrintOrder(r.id, { tx });
    if (!plan) continue;
    if (plan.blockers.some((b) => b.code === "digital_only")) continue; // nothing to print
    const productLine = plan.items.length
      ? plan.items.map((i) => [i.product, i.size, i.quantity > 1 ? `x${i.quantity}` : null].filter(Boolean).join(" / ")).join("; ")
      : "Product not matched";
    const a = plan.address;
    const addressLines = a
      ? [
          a.name ?? [a.firstName, a.lastName].filter(Boolean).join(" "),
          a.company,
          a.addressLine1,
          a.addressLine2,
          [a.city, a.state, a.postalCode].filter(Boolean).join(" "),
          a.countryCode,
        ].filter((x): x is string => !!x && x.trim().length > 0)
      : [];
    const fileUrl = plan.file ? await resolveUrl(plan.file) : null;
    cards.push({
      orderId: r.id,
      orderNumber: r.number ?? r.fallback,
      businessId: r.businessId,
      businessName: r.businessName,
      waitingSince: (enteredBy.get(r.id) ?? r.updatedAt).toISOString(),
      productLine,
      provider: plan.provider,
      providerLabel: PROVIDER_LABEL[plan.provider],
      costText: money(plan.totalCost, plan.currency),
      fileUrl,
      fileName: plan.file?.name ?? null,
      addressLines,
      buyerName: r.customerId ? (custName.get(r.customerId) ?? null) : null,
      blockers: plan.blockers,
      ready: plan.ready,
    });
  }
  return cards;
}
