import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import {
  orders,
  orderItems,
  assignments,
  assets,
  customers,
  customerPublic,
  earnings,
  qcChecks,
  proofs,
} from "@/lib/db/schema";
import type { ChecklistSnapshot, ItemResults } from "@/lib/qc/checklist";
import { issueLabels } from "@/lib/proofs/issues";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import type { OrderStatus } from "./transitions";

/** A revision the designer must act on — from QC, or from the customer. */
export type QcFailInfo = { reason: string | null; failedItems: string[] };

export type BoardCard = {
  orderId: string;
  /** Human order number shown in the UI (Shopify name / Etsy receipt id). */
  orderNumber: string;
  status: OrderStatus;
  dueAt: string | null; // ISO
  figureCount: number;
  figuresResolved: boolean;
  style: string | null;
  /** Product title + variant options for the designer ("what am I making"). */
  title: string | null;
  options: { name: string; value: string }[];
  /** Free-text notes / special requests (manual orders). */
  notes: string | null;
  /** Order origin — 'manual' orders are badged so staff can tell at a glance. */
  source: "etsy" | "shopify" | "manual";
  customerName: string;
  thumbnailUrl: string | null;
  /**
   * The most recent revision reason on a revision card — whichever came last:
   * a failed QC (`qcFail`) or a customer change request (`customerRevision`).
   * At most one is set, so the designer always sees the current instruction.
   */
  qcFail: QcFailInfo | null;
  customerRevision: QcFailInfo | null;
};

type OrderRow = {
  id: string;
  platformOrderId: string;
  platformOrderName: string | null;
  status: OrderStatus;
  dueAt: Date | null;
  businessId: string;
  customerId: string | null;
  revisionCount: number;
  source: "etsy" | "shopify" | "manual";
  notes: string | null;
};

type Tx = Parameters<Parameters<typeof withUserContext>[1]>[0];

const OVERDUE_STATES: OrderStatus[] = [
  "awaiting_photos", "ready_to_assign", "in_design", "awaiting_qc",
  "awaiting_approval", "approved", "printing", "shipped", "awaiting_details",
];

async function enrich(tx: Tx, rows: OrderRow[], viewerRole: string): Promise<BoardCard[]> {
  if (!rows.length) return [];
  const ids = rows.map((o) => o.id);

  const items = await tx
    .select({
      orderId: orderItems.orderId,
      figureCount: orderItems.figureCount,
      style: orderItems.style,
      title: orderItems.title,
      options: orderItems.options,
    })
    .from(orderItems)
    .where(inArray(orderItems.orderId, ids));
  const fig = new Map<string, number>();
  const hasNull = new Map<string, boolean>();
  const style = new Map<string, string>();
  const title = new Map<string, string>();
  const options = new Map<string, { name: string; value: string }[]>();
  for (const it of items) {
    fig.set(it.orderId, (fig.get(it.orderId) ?? 0) + (it.figureCount ?? 0));
    if (it.figureCount == null) hasNull.set(it.orderId, true);
    if (it.style && !style.has(it.orderId)) style.set(it.orderId, it.style);
    if (it.title && !title.has(it.orderId)) title.set(it.orderId, it.title);
    if (Array.isArray(it.options) && it.options.length && !options.has(it.orderId)) {
      options.set(it.orderId, it.options as { name: string; value: string }[]);
    }
  }

  const refs = await tx
    .select({ orderId: assets.orderId, url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
    .from(assets)
    .where(and(inArray(assets.orderId, ids), eq(assets.type, "reference"), isNull(assets.deletedAt)));
  // First reference photo per order; CDN urls resolve directly, R2 via a
  // short-lived presigned GET (private bucket).
  const firstRef = new Map<string, { url: string | null; storage: string; r2Key: string | null }>();
  for (const a of refs) if (!firstRef.has(a.orderId)) firstRef.set(a.orderId, a);
  const r2Ok = isR2Configured();
  const thumb = new Map<string, string>();
  await Promise.all(
    [...firstRef.entries()].map(async ([orderId, a]) => {
      if (a.url) thumb.set(orderId, a.url);
      else if (a.storage === "r2" && a.r2Key && r2Ok) {
        try {
          thumb.set(orderId, await presignGet(a.r2Key));
        } catch {
          /* leave without a thumbnail rather than fail the board */
        }
      }
    }),
  );

  // Revision detail per in-design order — the reason a card is back in design.
  // A card can be here from a failed QC (qc_checks) OR a customer change request
  // (proofs); we surface whichever happened most recently.
  const revisionIds = rows.filter((o) => o.status === "in_design").map((o) => o.id);
  const qcFail = new Map<string, QcFailInfo>();
  const customerRevision = new Map<string, QcFailInfo>();
  if (revisionIds.length) {
    const failRows = await tx
      .select({
        orderId: qcChecks.orderId,
        reason: qcChecks.reason,
        checklistSnapshot: qcChecks.checklistSnapshot,
        itemResults: qcChecks.itemResults,
        createdAt: qcChecks.createdAt,
      })
      .from(qcChecks)
      .where(and(inArray(qcChecks.orderId, revisionIds), eq(qcChecks.result, "fail")))
      .orderBy(desc(qcChecks.createdAt));
    const qcAt = new Map<string, Date>();
    for (const f of failRows) {
      if (qcFail.has(f.orderId)) continue; // keep only the most recent fail
      qcFail.set(f.orderId, {
        reason: f.reason,
        failedItems: failedLabels(f.checklistSnapshot, f.itemResults),
      });
      qcAt.set(f.orderId, f.createdAt);
    }

    const revRows = await tx
      .select({
        orderId: proofs.orderId,
        revisionNotes: proofs.revisionNotes,
        failedItems: proofs.failedItems,
        decidedAt: proofs.decidedAt,
      })
      .from(proofs)
      .where(and(inArray(proofs.orderId, revisionIds), eq(proofs.decision, "revision")))
      .orderBy(desc(proofs.decidedAt));
    for (const r of revRows) {
      if (customerRevision.has(r.orderId)) continue; // most recent request only
      customerRevision.set(r.orderId, {
        reason: r.revisionNotes,
        failedItems: issueLabels(r.failedItems ?? []),
      });
      // Keep only the newer of the two: if a QC fail is more recent, drop the
      // customer request from this card (and vice versa).
      const qAt = qcAt.get(r.orderId);
      if (qAt && r.decidedAt && qAt > r.decidedAt) customerRevision.delete(r.orderId);
      else qcFail.delete(r.orderId);
    }
  }

  const custIds = rows.map((o) => o.customerId).filter((x): x is string => !!x);
  const name = new Map<string, string>();
  if (custIds.length) {
    if (viewerRole === "designer") {
      for (const c of await tx
        .select({ id: customerPublic.id, firstName: customerPublic.firstName })
        .from(customerPublic)
        .where(inArray(customerPublic.id, custIds))) {
        name.set(c.id!, c.firstName ?? "—");
      }
    } else {
      for (const c of await tx
        .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName })
        .from(customers)
        .where(inArray(customers.id, custIds))) {
        name.set(c.id, [c.firstName, c.lastName].filter(Boolean).join(" ") || "—");
      }
    }
  }

  return rows.map((o) => ({
    orderId: o.id,
    orderNumber: o.platformOrderName ?? o.platformOrderId,
    status: o.status,
    dueAt: o.dueAt ? o.dueAt.toISOString() : null,
    figureCount: fig.get(o.id) ?? 0,
    figuresResolved: !hasNull.get(o.id),
    style: style.get(o.id) ?? null,
    title: title.get(o.id) ?? null,
    options: options.get(o.id) ?? [],
    notes: o.notes,
    source: o.source,
    customerName: o.customerId ? (name.get(o.customerId) ?? "—") : "—",
    thumbnailUrl: thumb.get(o.id) ?? null,
    qcFail: qcFail.get(o.id) ?? null,
    customerRevision: customerRevision.get(o.id) ?? null,
  }));
}

/** Labels of items the VA marked failed, from the qc_checks snapshot + results. */
function failedLabels(snapshot: unknown, results: unknown): string[] {
  const items = (snapshot as ChecklistSnapshot | null)?.items;
  if (!Array.isArray(items)) return [];
  const res = (results ?? {}) as ItemResults;
  return items.filter((it) => res[it.key] === false).map((it) => it.label);
}

export type DesignerBoard = {
  columns: {
    myQueue: BoardCard[];
    inDesign: BoardCard[];
    awaitingQc: BoardCard[];
    revisions: BoardCard[];
    complete: BoardCard[];
  };
  dailyEarnings: number;
};

/** Designer board for `designerId` (self, or a VA viewing ?designer=X). */
export async function getDesignerBoard(user: RequestUser, designerId?: string): Promise<DesignerBoard> {
  const target = designerId ?? user.id;
  return withUserContext(user, async (tx) => {
    const rows = (await tx
      .select({
        id: orders.id,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        status: orders.status,
        dueAt: orders.dueAt,
        businessId: orders.businessId,
        customerId: orders.customerId,
        revisionCount: orders.revisionCount,
        source: orders.source,
        notes: orders.notes,
      })
      .from(orders)
      .innerJoin(
        assignments,
        and(eq(assignments.orderId, orders.id), eq(assignments.active, true), eq(assignments.designerId, target)),
      )
      .where(inArray(orders.status, ["ready_to_assign", "in_design", "awaiting_qc", "complete"]))) as OrderRow[];

    const cards = await enrich(tx, rows, user.role);
    const meta = new Map(rows.map((r) => [r.id, r]));
    const pick = (pred: (r: OrderRow) => boolean) => cards.filter((c) => pred(meta.get(c.orderId)!));

    const [e] = await tx
      .select({ total: sql<string>`coalesce(sum(${earnings.amount}), 0)` })
      .from(earnings)
      .where(and(eq(earnings.designerId, target), gte(earnings.createdAt, sql`date_trunc('day', now())`)));

    return {
      columns: {
        myQueue: pick((r) => r.status === "ready_to_assign"),
        inDesign: pick((r) => r.status === "in_design" && r.revisionCount === 0),
        awaitingQc: pick((r) => r.status === "awaiting_qc"),
        revisions: pick((r) => r.status === "in_design" && r.revisionCount > 0),
        complete: pick((r) => r.status === "complete"),
      },
      dailyEarnings: Number(e?.total ?? 0),
    };
  });
}

export const VA_TABS = [
  "triage", "needs_details", "needs_photos", "shopify_missing_photos", "unassigned",
  "awaiting_qc", "revisions_in", "awaiting_customer", "fulfilment", "ready_to_print", "overdue",
] as const;
export type VaTab = (typeof VA_TABS)[number];

export const VA_TAB_LABELS: Record<VaTab, string> = {
  triage: "Triage",
  needs_details: "Needs Details",
  needs_photos: "Needs Photos",
  shopify_missing_photos: "Shopify · Missing Photos",
  unassigned: "Unassigned",
  awaiting_qc: "Awaiting QC",
  revisions_in: "Revisions In",
  awaiting_customer: "Awaiting Customer",
  fulfilment: "Fulfilment",
  ready_to_print: "Ready to Print",
  overdue: "Overdue",
};

function tabWhere(tab: VaTab) {
  switch (tab) {
    case "triage": return eq(orders.status, "triage");
    case "needs_details": return eq(orders.status, "awaiting_details");
    // Etsy/manual orders legitimately await photos; a Shopify one is an anomaly.
    case "needs_photos": return and(eq(orders.status, "awaiting_photos"), ne(orders.source, "shopify"));
    case "shopify_missing_photos": return and(eq(orders.status, "awaiting_photos"), eq(orders.source, "shopify"));
    case "unassigned":
      return and(
        eq(orders.status, "ready_to_assign"),
        sql`not exists (select 1 from assignments a where a.order_id = ${orders.id} and a.active)`,
      );
    case "awaiting_qc": return eq(orders.status, "awaiting_qc");
    case "revisions_in": return and(eq(orders.status, "in_design"), gt(orders.revisionCount, 0));
    case "awaiting_customer": return eq(orders.status, "awaiting_approval");
    case "fulfilment": return eq(orders.status, "fulfillment_only");
    case "ready_to_print": return eq(orders.status, "approved");
    case "overdue":
      return and(inArray(orders.status, OVERDUE_STATES), isNotNull(orders.dueAt), lt(orders.dueAt, sql`now()`));
  }
}

export type VaQueue = { cards: BoardCard[]; counts: Record<VaTab, number> };

export async function getVaQueue(
  user: RequestUser,
  opts: { businessId: string | null; tab: VaTab },
): Promise<VaQueue> {
  return withUserContext(user, async (tx) => {
    const bizFilter = opts.businessId && opts.businessId !== "all" ? eq(orders.businessId, opts.businessId) : undefined;

    const counts = {} as Record<VaTab, number>;
    for (const t of VA_TABS) {
      const [c] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .where(bizFilter ? and(tabWhere(t), bizFilter) : tabWhere(t));
      counts[t] = Number(c?.n ?? 0);
    }

    const rows = (await tx
      .select({
        id: orders.id,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        status: orders.status,
        dueAt: orders.dueAt,
        businessId: orders.businessId,
        customerId: orders.customerId,
        revisionCount: orders.revisionCount,
        source: orders.source,
        notes: orders.notes,
      })
      .from(orders)
      .where(bizFilter ? and(tabWhere(opts.tab), bizFilter) : tabWhere(opts.tab))
      .orderBy(orders.dueAt)
      .limit(200)) as OrderRow[];

    return { cards: await enrich(tx, rows, user.role), counts };
  });
}
