import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { currentPeriod } from "@/lib/orders/earnings";
import { isDesignerLike } from "@/lib/auth/roles";

import { withUserContext, type RequestUser } from "@/lib/db";
import {
  orders,
  orderItems,
  assignments,
  activityLog,
  assets,
  customers,
  customerPublic,
  earnings,
  qcChecks,
  proofs,
  designerProfiles,
} from "@/lib/db/schema";
import { DEFAULT_TIMEZONE, isValidTimezone, startOfDayInTimezone } from "@/lib/designers/quiet-hours";
import type { ChecklistSnapshot, ItemResults } from "@/lib/qc/checklist";
import { issueLabels } from "@/lib/proofs/issues";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import { liveOrderWhere } from "@/lib/orders/archive";
import { sizedImageUrl } from "@/lib/images";
import {
  COMPLETE_COLUMN_MAX,
  COMPLETE_COLUMN_WINDOW_DAYS,
  SENT_BACK_FROM,
  WITH_CUSTOMER_STATUSES,
} from "@/lib/orders/board-constants";
import type { OrderStatus } from "./transitions";
import type { ProofAnnotation } from "@/lib/db/schema";

/** A revision the designer must act on — from QC, or from the customer. */
export type QcFailInfo = {
  reason: string | null;
  failedItems: string[];
  /** Pins the customer dropped on the proof preview (normalised 0..1 coords) — customer revisions only. */
  annotations?: ProofAnnotation[];
};

export type BoardCard = {
  orderId: string;
  /** Human order number shown in the UI (Shopify name / Etsy receipt id). */
  orderNumber: string;
  status: OrderStatus;
  /**
   * The deadline this viewer is shown and sorted by (ISO). A designer sees
   * their OWN deadline (the active assignment's due_at, see CLAUDE.md
   * Deadlines); staff see the customer SLA (orders.due_at).
   */
  dueAt: string | null;
  /** Customer-facing SLA (orders.due_at). */
  orderDueAt: string | null;
  /** The assigned designer's own deadline (active assignments.due_at). */
  assignmentDueAt: string | null;
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
  /**
   * In design with a portrait version newer than the last send-back (QC fail
   * or customer revision): Submit for QC will be accepted. The same rule the
   * server enforces (transitions.ts assertHasSubmission), so the board only
   * offers Submit when it will work.
   */
  readyForQc: boolean;
};

type OrderRow = {
  id: string;
  platformOrderId: string;
  platformOrderName: string | null;
  status: OrderStatus;
  dueAt: Date | null;
  assignmentDueAt: Date | null;
  businessId: string;
  customerId: string | null;
  revisionCount: number;
  source: "etsy" | "shopify" | "manual";
  notes: string | null;
};

type Tx = Parameters<Parameters<typeof withUserContext>[1]>[0];

/**
 * Small board-card variant of a reference photo. The mock seed's picsum URLs
 * get downsized (900x900 -> 400x400 in the path, still a real picsum size so
 * the image exists); Shopify CDN photos ask the CDN for a 640 px wide copy
 * (a customer's 2.2 MB phone photo becomes ~90 KB, docs/PERF.md). R2
 * presigned URLs are returned untouched. The full-size original is what the
 * card modal/detail view loads; only the board thumbnail wants the small one.
 */
function boardThumbnailUrl(url: string): string {
  return url.includes("picsum.photos") ? url.replace(/\/900\/900$/, "/400/400") : sizedImageUrl(url, 640);
}

async function enrich(user: RequestUser, rows: OrderRow[]): Promise<BoardCard[]> {
  if (!rows.length) return [];
  const viewerRole = user.role;
  const ids = rows.map((o) => o.id);
  const revisionIds = rows.filter((o) => o.status === "in_design").map((o) => o.id);
  const custIds = rows.map((o) => o.customerId).filter((x): x is string => !!x);

  // Every query below only reads from `ids`/`revisionIds`/`custIds` (already
  // known from `rows`), so none depends on another's result. A transaction is
  // ONE connection, so queries "in parallel" on it still go over the wire one
  // after another (docs/PERF.md: the ~5 s board). The queries are therefore
  // split over two read-only transactions that run side by side; each sets its
  // own RLS GUCs (withUserContext), so scoping is unchanged.
  const [[items, refs, customerRows], [failRows, revRows, vaRevisionRows, submissionRows]] = await Promise.all([
    withUserContext(user, (tx) => Promise.all([
    tx
      .select({
        orderId: orderItems.orderId,
        figureCount: orderItems.figureCount,
        style: orderItems.style,
        title: orderItems.title,
        options: orderItems.options,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, ids)),
    tx
      .select({ orderId: assets.orderId, url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
      .from(assets)
      .where(and(inArray(assets.orderId, ids), eq(assets.type, "reference"), isNull(assets.deletedAt))),
    custIds.length
      ? isDesignerLike(viewerRole)
        ? tx
            .select({ id: customerPublic.id, firstName: customerPublic.firstName })
            .from(customerPublic)
            .where(inArray(customerPublic.id, custIds))
        : tx
            .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName })
            .from(customers)
            .where(inArray(customers.id, custIds))
      : Promise.resolve([]),
    ])),
    withUserContext(user, (tx) => Promise.all([
    revisionIds.length
      ? tx
          .select({
            orderId: qcChecks.orderId,
            reason: qcChecks.reason,
            checklistSnapshot: qcChecks.checklistSnapshot,
            itemResults: qcChecks.itemResults,
            createdAt: qcChecks.createdAt,
          })
          .from(qcChecks)
          .where(and(inArray(qcChecks.orderId, revisionIds), eq(qcChecks.result, "fail")))
          .orderBy(desc(qcChecks.createdAt))
      : Promise.resolve([]),
    revisionIds.length
      ? tx
          .select({
            orderId: proofs.orderId,
            revisionNotes: proofs.revisionNotes,
            failedItems: proofs.failedItems,
            annotations: proofs.annotations,
            decidedAt: proofs.decidedAt,
          })
          .from(proofs)
          .where(and(inArray(proofs.orderId, revisionIds), eq(proofs.decision, "revision")))
          .orderBy(desc(proofs.decidedAt))
      : Promise.resolve([]),
    revisionIds.length
      ? tx
          .select({
            orderId: activityLog.orderId,
            fromState: activityLog.fromState,
            metadata: activityLog.metadata,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(and(inArray(activityLog.orderId, revisionIds), eq(activityLog.action, "order.in_design")))
          .orderBy(desc(activityLog.createdAt))
      : Promise.resolve([]),
    revisionIds.length
      ? tx
          .select({ orderId: assets.orderId, createdAt: assets.createdAt })
          .from(assets)
          .where(and(inArray(assets.orderId, revisionIds), eq(assets.type, "submission"), isNull(assets.deletedAt)))
      : Promise.resolve([]),
    ])),
  ]);
  // Ready for QC: the newest portrait version is newer than the last send-back.
  const lastSendBack = new Map<string, number>();
  for (const r of vaRevisionRows) {
    if (!r.orderId || !r.fromState || !(SENT_BACK_FROM as readonly string[]).includes(r.fromState)) continue;
    const at = r.createdAt.getTime();
    if (at > (lastSendBack.get(r.orderId) ?? 0)) lastSendBack.set(r.orderId, at);
  }
  const readyForQc = new Set<string>();
  for (const s of submissionRows) {
    if (s.createdAt.getTime() > (lastSendBack.get(s.orderId) ?? 0)) readyForQc.add(s.orderId);
  }

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

  // First reference photo per order; CDN urls resolve directly (downsized for
  // the board thumbnail), R2 via a short-lived presigned GET (private bucket).
  const firstRef = new Map<string, { url: string | null; storage: string; r2Key: string | null }>();
  for (const a of refs) if (!firstRef.has(a.orderId)) firstRef.set(a.orderId, a);
  const r2Ok = isR2Configured();
  const thumb = new Map<string, string>();
  await Promise.all(
    [...firstRef.entries()].map(async ([orderId, a]) => {
      if (a.url) thumb.set(orderId, boardThumbnailUrl(a.url));
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
  const qcFail = new Map<string, QcFailInfo>();
  const customerRevision = new Map<string, QcFailInfo>();
  const customerRevisionAt = new Map<string, Date>();
  if (revisionIds.length) {
    const qcAt = new Map<string, Date>();
    for (const f of failRows) {
      if (qcFail.has(f.orderId)) continue; // keep only the most recent fail
      qcFail.set(f.orderId, {
        reason: f.reason,
        failedItems: failedLabels(f.checklistSnapshot, f.itemResults),
      });
      qcAt.set(f.orderId, f.createdAt);
    }

    for (const r of revRows) {
      if (customerRevision.has(r.orderId)) continue; // most recent request only
      customerRevision.set(r.orderId, {
        reason: r.revisionNotes,
        failedItems: issueLabels(r.failedItems ?? []),
        annotations: r.annotations ?? [],
      });
      if (r.decidedAt) customerRevisionAt.set(r.orderId, r.decidedAt);
      // Keep only the newer of the two: if a QC fail is more recent, drop the
      // customer request from this card (and vice versa).
      const qAt = qcAt.get(r.orderId);
      if (qAt && r.decidedAt && qAt > r.decidedAt) customerRevision.delete(r.orderId);
      else qcFail.delete(r.orderId);
    }

    for (const r of vaRevisionRows) {
      if (!r.orderId) continue;
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const reason = typeof meta.revisionReason === "string" ? meta.revisionReason.trim() : "";
      if (!reason) continue;
      const existingAt = customerRevisionAt.get(r.orderId);
      if (existingAt && existingAt > r.createdAt) continue;
      const qAt = qcAt.get(r.orderId);
      if (qAt && qAt > r.createdAt) continue;
      customerRevision.set(r.orderId, { reason, failedItems: [] });
      customerRevisionAt.set(r.orderId, r.createdAt);
      qcFail.delete(r.orderId);
    }
  }

  const name = new Map<string, string>();
  if (isDesignerLike(viewerRole)) {
    for (const c of customerRows as { id: string | null; firstName: string | null }[]) {
      if (c.id) name.set(c.id, c.firstName ?? "-");
    }
  } else {
    for (const c of customerRows as { id: string; firstName: string | null; lastName: string | null }[]) {
      name.set(c.id, [c.firstName, c.lastName].filter(Boolean).join(" ") || "-");
    }
  }

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return rows.map((o) => ({
    orderId: o.id,
    orderNumber: o.platformOrderName ?? o.platformOrderId,
    status: o.status,
    // A designer works to their own deadline; the customer SLA is staff-facing.
    // An assignment without a due_at (legacy rows) falls back to the SLA.
    dueAt: iso(isDesignerLike(viewerRole) ? (o.assignmentDueAt ?? o.dueAt) : o.dueAt),
    orderDueAt: iso(o.dueAt),
    assignmentDueAt: iso(o.assignmentDueAt),
    figureCount: fig.get(o.id) ?? 0,
    figuresResolved: !hasNull.get(o.id),
    style: style.get(o.id) ?? null,
    title: title.get(o.id) ?? null,
    options: options.get(o.id) ?? [],
    notes: o.notes,
    source: o.source,
    customerName: o.customerId ? (name.get(o.customerId) ?? "-") : "-",
    thumbnailUrl: thumb.get(o.id) ?? null,
    qcFail: qcFail.get(o.id) ?? null,
    customerRevision: customerRevision.get(o.id) ?? null,
    readyForQc: o.status === "in_design" && readyForQc.has(o.id),
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
    failedQc: BoardCard[];
    awaitingQc: BoardCard[];
    revisions: BoardCard[];
    /** Passed QC, now with the customer (approval, print, delivery): read only. */
    withCustomer: BoardCard[];
    complete: BoardCard[];
  };
  dailyEarnings: number;
  periodEarnings: number;
  earningHistory: DesignerEarningHistory[];
  /** The board owner's own timezone (their deadlines are shown in it). */
  timeZone: string;
};

export type DesignerEarningHistory = {
  id: string;
  orderId: string;
  orderNumber: string;
  style: string;
  figureCount: number;
  rate: string | null;
  amount: string | null;
  status: "blocked" | "pending" | "paid" | "voided";
  createdAt: string;
};

/** The styles an earning paid for; empty (the row just leaves it out) when unknown. */
function styleSummary(breakdown: unknown): string {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return "";
  const styles = [
    ...new Set(
      breakdown
        .map((row) => (typeof row === "object" && row ? (row as { style?: unknown }).style : null))
        .filter((style): style is string => typeof style === "string" && style.trim().length > 0),
    ),
  ];
  return styles.join(", ");
}

const BOARD_ROW_SELECT = {
  id: orders.id,
  platformOrderId: orders.platformOrderId,
  platformOrderName: orders.platformOrderName,
  status: orders.status,
  dueAt: orders.dueAt,
  assignmentDueAt: assignments.dueAt,
  businessId: orders.businessId,
  customerId: orders.customerId,
  revisionCount: orders.revisionCount,
  source: orders.source,
  notes: orders.notes,
} as const;

type EarningRow = {
  id: string;
  orderId: string;
  orderNumber: string | null;
  fallbackOrderNumber: string;
  figureCount: number;
  rate: string;
  amount: string;
  status: DesignerEarningHistory["status"];
  breakdown: unknown;
  createdAt: Date;
};

/** Designer board for `designerId` (self, or a VA viewing ?designer=X). */
export async function getDesignerBoard(
  user: RequestUser,
  designerId?: string,
  /** Staff view: only this business's orders on the board (the switcher's selection). */
  businessId?: string,
  options: {
    /** False: no pay anywhere (0 / 0 / []). Always false for a helper, whatever is passed. */
    includeEarnings?: boolean;
    /** A helper's principal designer (session.user.helperFor). */
    helperFor?: string | null;
  } = {},
): Promise<DesignerBoard> {
  const isHelper = user.role === "helper";
  // A helper loads exactly their principal's board, nobody else's.
  if (isHelper && (!options.helperFor || (designerId && designerId !== options.helperFor))) {
    throw new Error("Not permitted");
  }
  const target = isHelper ? (options.helperFor as string) : (designerId ?? user.id);
  const includeEarnings = isHelper ? false : options.includeEarnings !== false;
  const assignedToTarget = (status: OrderRow["status"] | OrderRow["status"][]) =>
    and(
      Array.isArray(status) ? inArray(orders.status, status) : eq(orders.status, status),
      liveOrderWhere(),
      businessId ? eq(orders.businessId, businessId) : undefined,
    );

  // Speed (docs/PERF.md): one transaction is ONE connection, so "Promise.all"
  // inside it still runs query after query (the ~5 s board). The independent
  // read groups below each get their own read-only withUserContext
  // transaction (each sets its own RLS GUCs) and run side by side:
  //   1. the owner's timezone, then (if allowed) the three earnings reads;
  //   2. the live columns; 3. the capped Complete column.
  // Then enrich() fans out over two more transactions.
  const ownerPay = withUserContext(user, async (tx) => {
    // The board owner's zone first: "Today" (earnings) is their day, like every deadline they see.
    const [profile] = await tx
      .select({ timezone: designerProfiles.timezone })
      .from(designerProfiles)
      .where(eq(designerProfiles.userId, target))
      .limit(1);
    const timeZone = isValidTimezone(profile?.timezone ?? null) ? (profile?.timezone as string) : DEFAULT_TIMEZONE;
    if (!includeEarnings) {
      return { timeZone, daily: undefined, period: undefined, earningRows: [] as EarningRow[] };
    }
    const dayStart = startOfDayInTimezone(new Date(), timeZone);
    const [[daily], [period], earningRows] = await Promise.all([
      tx
        .select({ total: sql<string>`coalesce(sum(${earnings.amount}), 0)` })
        .from(earnings)
        .where(and(eq(earnings.designerId, target), inArray(earnings.status, ["pending", "paid"]), gte(earnings.createdAt, dayStart))),
      tx
        .select({ total: sql<string>`coalesce(sum(${earnings.amount}), 0)` })
        .from(earnings)
        .where(and(eq(earnings.designerId, target), inArray(earnings.status, ["pending", "paid"]), eq(earnings.period, currentPeriod()))),
      tx
        .select({
          id: earnings.id,
          orderId: earnings.orderId,
          orderNumber: orders.platformOrderName,
          fallbackOrderNumber: orders.platformOrderId,
          figureCount: earnings.figureCount,
          rate: earnings.rate,
          amount: earnings.amount,
          status: earnings.status,
          breakdown: earnings.breakdown,
          createdAt: earnings.createdAt,
        })
        .from(earnings)
        .innerJoin(orders, eq(orders.id, earnings.orderId))
        .where(eq(earnings.designerId, target))
        .orderBy(desc(earnings.createdAt))
        .limit(20) as Promise<EarningRow[]>,
    ]);
    return { timeZone, daily, period, earningRows };
  });

  const activeP = withUserContext(user, (tx) =>
    tx
      .select(BOARD_ROW_SELECT)
      .from(orders)
      .innerJoin(
        assignments,
        and(eq(assignments.orderId, orders.id), eq(assignments.active, true), eq(assignments.designerId, target)),
      )
      .where(assignedToTarget(["ready_to_assign", "in_design", "awaiting_qc", ...WITH_CUSTOMER_STATUSES])) as Promise<OrderRow[]>,
  );
  const completeP = withUserContext(user, (tx) =>
    tx
      .select(BOARD_ROW_SELECT)
      .from(orders)
      .innerJoin(
        assignments,
        and(eq(assignments.orderId, orders.id), eq(assignments.active, true), eq(assignments.designerId, target)),
      )
      .where(
        and(
          assignedToTarget("complete"),
          gte(orders.updatedAt, sql`now() - interval '1 day' * ${COMPLETE_COLUMN_WINDOW_DAYS}`),
        ),
      )
      .orderBy(desc(orders.updatedAt))
      .limit(COMPLETE_COLUMN_MAX) as Promise<OrderRow[]>,
  );

  {
    const [activeRows, completeRows] = await Promise.all([activeP, completeP]);
    const { timeZone, daily, period, earningRows } = await ownerPay;
    const rows = [...activeRows, ...completeRows];
    const cards = await enrich(user, rows);
    const meta = new Map(rows.map((r) => [r.id, r]));
    // "Soonest deadline first": every live column is sorted by the date the
    // viewer is shown (undated cards last). Complete keeps most-recent-first.
    const byDue = (a: BoardCard, b: BoardCard) =>
      (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);
    const pick = (pred: (r: OrderRow) => boolean) => cards.filter((c) => pred(meta.get(c.orderId)!)).sort(byDue);

    return {
      columns: {
        myQueue: pick((r) => r.status === "ready_to_assign"),
        inDesign: pick((r) => r.status === "in_design" && r.revisionCount === 0),
        failedQc: pick((r) => r.status === "in_design" && !!cards.find((c) => c.orderId === r.id)?.qcFail),
        awaitingQc: pick((r) => r.status === "awaiting_qc"),
        revisions: pick((r) => {
          const card = cards.find((c) => c.orderId === r.id);
          return r.status === "in_design" && r.revisionCount > 0 && !card?.qcFail;
        }),
        // After a QC pass the order is out of the designer's hands until it
        // completes; it stays visible here (quiet, no countdown) so a pass
        // never looks like the card vanished.
        withCustomer: pick((r) => (WITH_CUSTOMER_STATUSES as readonly string[]).includes(r.status)),
        complete: cards.filter((c) => meta.get(c.orderId)!.status === "complete"),
      },
      timeZone,
      dailyEarnings: Number(daily?.total ?? 0),
      periodEarnings: Number(period?.total ?? 0),
      earningHistory: earningRows.map((earning) => ({
        id: earning.id,
        orderId: earning.orderId,
        orderNumber: earning.orderNumber ?? earning.fallbackOrderNumber,
        style: styleSummary(earning.breakdown),
        figureCount: earning.figureCount,
        rate: earning.rate,
        amount: earning.amount,
        status: earning.status,
        createdAt: earning.createdAt.toISOString(),
      })),
    };
  }
}
