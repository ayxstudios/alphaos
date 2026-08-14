import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { withSystemContext, withUserContext, type RequestUser, type Tx } from "@/lib/db";
import {
  activityLog,
  assignments,
  businesses,
  designerBusinesses,
  designerProfiles,
  earnings,
  messages,
  orderItems,
  orders,
  proofs,
  qcChecks,
  shops,
  users,
} from "@/lib/db/schema";
import { detectGmailMailboxStalls, type GmailMailboxStall } from "@/lib/integrations/gmail";
import { liveOrderSql, liveOrderWhere } from "@/lib/orders/archive";
import { DEFAULT_CHECKLIST, type ChecklistSnapshot, type ItemResults } from "@/lib/qc/checklist";

export const HEALTH_TIME_ZONE = "Australia/Melbourne";

const CLOSED_STATUSES = ["delivered", "complete", "cancelled"] as const;
const INTAKE_STATUSES = ["awaiting_details", "awaiting_photos"] as const;
const WIP_STATUSES = ["in_design", "awaiting_qc"] as const;

export type HealthScope =
  | { kind: "business"; businessId: string; businessName: string }
  | { kind: "all" };

export type CountLink = {
  label: string;
  count: number;
  href: string;
  tone: "neutral" | "success" | "warning" | "danger";
  detail?: string;
};

export type ShopSyncHealth = {
  id: string;
  businessName: string;
  name: string;
  platform: "etsy" | "shopify";
  lastSyncAt: string | null;
  stale: boolean;
};

export type GmailMailboxHealth = {
  businessId: string;
  businessName: string;
  gmailAddress: string | null;
  lastPolledAt: string | null;
  stalled: boolean;
  dbHistoryId: string | null;
  gmailHistoryId: string | null;
  ageHours: number | null;
};

export type RateWindow = {
  count: number;
  rate: number | null;
};

export type ThroughputWindow = {
  ordersIn: number;
  delivered: number;
  onTimeDelivered: number;
  onTimeRate: number | null;
  qcChecks: number;
  qcFailures: number;
  qcFailRate: number | null;
  revisionEvents: number;
  revisionRate: number | null;
};

export type DesignerCapacity = {
  designerId: string;
  name: string;
  businessName: string;
  dailyCapacity: number;
  activeWork: number;
};

export type HealthMetrics = {
  generatedAt: string;
  reportDate: string;
  scopeLabel: string;
  scope: HealthScope;
  healthy: boolean;
  pipeline: {
    shops: ShopSyncHealth[];
    gmailMailboxes: GmailMailboxHealth[];
    gmailStalls: GmailMailboxStall[];
    staleShopCount: number;
    gmailStallCount: number;
    queuedEmails: number;
    failedEmails: number;
    staleUnmatchedReplies: number;
    blockedEarnings: number;
    staleIntake: number;
    proofNoResponse: number;
  };
  operations: {
    yesterday: ThroughputWindow;
    trailing7: ThroughputWindow;
    previous7: ThroughputWindow;
    overdueNow: number;
    worstOverdueHours: number | null;
    topFailedChecklistItem: { label: string; count: number } | null;
    designersOverCapacity: DesignerCapacity[];
    designersIdle: DesignerCapacity[];
    unassigned: number;
    noEligibleDesignerSample: number;
    noEligibleDesignerSampleLimited: boolean;
  };
  links: {
    pipeline: CountLink[];
    operations: CountLink[];
  };
};

type QcSnapshotRow = {
  checklistSnapshot: unknown;
  itemResults: unknown;
};

function compact<T>(values: (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

function scopedWhere(scope: HealthScope, column: AnyPgColumn): SQL | undefined {
  return scope.kind === "business" ? eq(column, scope.businessId) : undefined;
}

function all(...conditions: (SQL | undefined)[]) {
  return and(...compact(conditions));
}

function isoOrNull(value: Date | string | null): string | null {
  if (!value) return null;
  const date = dateOrNull(value);
  return date ? date.toISOString() : null;
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function dateOrNull(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function hoursBetween(later: Date, earlier: Date | string): number | null {
  const earlierDate = dateOrNull(earlier);
  if (!earlierDate) return null;
  return Math.max(0, Math.round(((later.getTime() - earlierDate.getTime()) / 3_600_000) * 10) / 10);
}

function zonedDateKey(date: Date, timeZone = HEALTH_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return asUtc - date.getTime();
}

function startOfZonedDay(date: Date, timeZone = HEALTH_TIME_ZONE): Date {
  const [year, month, day] = zonedDateKey(date, timeZone).split("-").map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day));
  return new Date(utcGuess.getTime() - timeZoneOffsetMs(utcGuess, timeZone));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function countInWindow<T>(
  rows: T[],
  start: Date,
  end: Date,
  getDate: (row: T) => Date,
  getId?: (row: T) => string,
): number {
  const seen = new Set<string>();
  let count = 0;
  for (const row of rows) {
    const date = getDate(row);
    if (date < start || date >= end) continue;
    if (getId) {
      const id = getId(row);
      if (seen.has(id)) continue;
      seen.add(id);
    }
    count += 1;
  }
  return count;
}

function buildWindow(input: {
  ordersIn: number;
  deliveredRows: { orderId: string; completedAt: Date; dueAt: Date | null }[];
  qcRows: { result: "pass" | "fail"; createdAt: Date }[];
  revisionRows: { orderId: string; createdAt: Date }[];
  start: Date;
  end: Date;
}): ThroughputWindow {
  const delivered = countInWindow(
    input.deliveredRows,
    input.start,
    input.end,
    (row) => row.completedAt,
    (row) => row.orderId,
  );
  const onTimeDelivered = countInWindow(
    input.deliveredRows.filter((row) => row.dueAt != null && row.completedAt <= row.dueAt),
    input.start,
    input.end,
    (row) => row.completedAt,
    (row) => row.orderId,
  );
  const qcChecksCount = countInWindow(input.qcRows, input.start, input.end, (row) => row.createdAt);
  const qcFailures = countInWindow(
    input.qcRows.filter((row) => row.result === "fail"),
    input.start,
    input.end,
    (row) => row.createdAt,
  );
  const revisionEvents = countInWindow(input.revisionRows, input.start, input.end, (row) => row.createdAt);

  return {
    ordersIn: input.ordersIn,
    delivered,
    onTimeDelivered,
    onTimeRate: percent(onTimeDelivered, delivered),
    qcChecks: qcChecksCount,
    qcFailures,
    qcFailRate: percent(qcFailures, qcChecksCount),
    revisionEvents,
    revisionRate: percent(revisionEvents, Math.max(input.ordersIn, 1)),
  };
}

function checklistLabel(row: QcSnapshotRow, key: number): string {
  const snapshot = row.checklistSnapshot as ChecklistSnapshot | null;
  const custom = snapshot?.items?.find((item) => item.key === key)?.label;
  return custom ?? DEFAULT_CHECKLIST.find((item) => item.key === key)?.label ?? `Checklist item ${key}`;
}

function topFailedChecklistItem(rows: QcSnapshotRow[]) {
  const counts = new Map<number, { label: string; count: number }>();
  for (const row of rows) {
    const results = row.itemResults as ItemResults | null;
    if (!results || typeof results !== "object") continue;
    for (const [keyText, passed] of Object.entries(results)) {
      if (passed !== false) continue;
      const key = Number(keyText);
      if (!Number.isFinite(key)) continue;
      const existing = counts.get(key);
      counts.set(key, {
        label: existing?.label ?? checklistLabel(row, key),
        count: (existing?.count ?? 0) + 1,
      });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0] ?? null;
}

async function countOrdersIn(tx: Tx, scope: HealthScope, start: Date, end: Date) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      all(
        scopedWhere(scope, orders.businessId),
        liveOrderWhere(),
        gte(sql`coalesce(${orders.placedAt}, ${orders.createdAt})`, start),
        lt(sql`coalesce(${orders.placedAt}, ${orders.createdAt})`, end),
      ),
    );
  return row?.n ?? 0;
}

async function loadDeliveredRows(tx: Tx, scope: HealthScope, start: Date, end: Date) {
  const rows = await tx
    .select({
      orderId: activityLog.orderId,
      completedAt: activityLog.createdAt,
      dueAt: orders.dueAt,
    })
    .from(activityLog)
    .innerJoin(orders, eq(orders.id, activityLog.orderId))
    .where(
      all(
        scopedWhere(scope, activityLog.businessId),
        liveOrderSql(),
        inArray(activityLog.toState, ["delivered", "complete"]),
        gte(activityLog.createdAt, start),
        lt(activityLog.createdAt, end),
      ),
    )
    .orderBy(asc(activityLog.createdAt));
  return rows.filter(
    (row): row is { orderId: string; completedAt: Date; dueAt: Date | null } => row.orderId != null,
  );
}

async function loadQcRows(tx: Tx, scope: HealthScope, start: Date, end: Date) {
  return tx
    .select({ result: qcChecks.result, createdAt: qcChecks.createdAt })
    .from(qcChecks)
    .innerJoin(orders, eq(orders.id, qcChecks.orderId))
    .where(
      all(
        scopedWhere(scope, qcChecks.businessId),
        liveOrderSql(),
        gte(qcChecks.createdAt, start),
        lt(qcChecks.createdAt, end),
      ),
    );
}

async function loadRevisionRows(tx: Tx, scope: HealthScope, start: Date, end: Date) {
  const rows = await tx
    .select({ orderId: activityLog.orderId, createdAt: activityLog.createdAt })
    .from(activityLog)
    .innerJoin(orders, eq(orders.id, activityLog.orderId))
    .where(
      all(
        scopedWhere(scope, activityLog.businessId),
        liveOrderSql(),
        eq(activityLog.toState, "in_design"),
        gte(activityLog.createdAt, start),
        lt(activityLog.createdAt, end),
        sql`${activityLog.fromState} is not null and ${activityLog.fromState} <> 'ready_to_assign'`,
      ),
    );
  return rows.filter((row): row is { orderId: string; createdAt: Date } => row.orderId != null);
}

async function loadStaleIntake(tx: Tx, scope: HealthScope, now: Date) {
  const cutoff = new Date(now.getTime() - 48 * 3_600_000);
  const rows = await tx
    .select({
      id: orders.id,
      status: orders.status,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(
      all(
        scopedWhere(scope, orders.businessId),
        liveOrderWhere(),
        inArray(orders.status, [...INTAKE_STATUSES]),
      ),
    );
  if (rows.length === 0) return 0;
  const logs = await tx
    .select({
      orderId: activityLog.orderId,
      toState: activityLog.toState,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(
      all(
        scopedWhere(scope, activityLog.businessId),
        inArray(activityLog.toState, [...INTAKE_STATUSES]),
        inArray(activityLog.orderId, rows.map((row) => row.id)),
      ),
    )
    .orderBy(desc(activityLog.createdAt));
  const latest = new Map<string, Date>();
  for (const log of logs) {
    if (!log.orderId || latest.has(log.orderId)) continue;
    latest.set(log.orderId, log.createdAt);
  }
  return rows.filter((row) => (latest.get(row.id) ?? row.createdAt) < cutoff).length;
}

async function loadProofNoResponse(tx: Tx, scope: HealthScope, now: Date) {
  const cutoff = new Date(now.getTime() - 72 * 3_600_000);
  const rows = await tx
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(proofs, eq(proofs.orderId, orders.id))
    .where(
      all(
        scopedWhere(scope, orders.businessId),
        liveOrderWhere(),
        eq(orders.status, "awaiting_approval"),
        lt(proofs.sentAt, cutoff),
        isNull(proofs.decision),
      ),
    );
  return new Set(rows.map((row) => row.id)).size;
}

async function loadDesignerCapacity(tx: Tx, scope: HealthScope) {
  const designers = await tx
    .select({
      designerId: users.id,
      name: users.name,
      email: users.email,
      businessId: designerBusinesses.businessId,
      businessName: businesses.name,
      dailyCapacity: designerProfiles.dailyCapacity,
    })
    .from(designerBusinesses)
    .innerJoin(users, eq(users.id, designerBusinesses.userId))
    .innerJoin(businesses, eq(businesses.id, designerBusinesses.businessId))
    .leftJoin(designerProfiles, eq(designerProfiles.userId, users.id))
    .where(
      all(
        scope.kind === "business" ? eq(designerBusinesses.businessId, scope.businessId) : undefined,
        eq(users.role, "designer"),
        eq(users.active, true),
      ),
    )
    .orderBy(asc(users.name), asc(businesses.name));

  const wipRows = await tx
    .select({
      designerId: assignments.designerId,
      businessId: assignments.businessId,
      n: sql<number>`count(*)::int`,
    })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(
      all(
        scopedWhere(scope, assignments.businessId),
        liveOrderSql(),
        eq(assignments.active, true),
        inArray(orders.status, [...WIP_STATUSES]),
      ),
    )
    .groupBy(assignments.designerId, assignments.businessId);
  const wip = new Map(wipRows.map((row) => [`${row.businessId}:${row.designerId}`, row.n]));

  const entries: DesignerCapacity[] = designers.map((designer) => ({
    designerId: designer.designerId,
    name: designer.name ?? designer.email,
    businessName: designer.businessName,
    dailyCapacity: designer.dailyCapacity ?? 0,
    activeWork: wip.get(`${designer.businessId}:${designer.designerId}`) ?? 0,
  }));

  return {
    over: entries
      .filter((entry) => entry.dailyCapacity > 0 && entry.activeWork > entry.dailyCapacity)
      .sort((a, b) => b.activeWork - b.dailyCapacity - (a.activeWork - a.dailyCapacity))
      .slice(0, 6),
    idle: entries
      .filter((entry) => entry.dailyCapacity > 0 && entry.activeWork === 0)
      .slice(0, 8),
  };
}

async function loadUnassigned(tx: Tx, scope: HealthScope) {
  const unassigned = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      style: orderItems.style,
    })
    .from(orders)
    .leftJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true)))
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      all(
        scopedWhere(scope, orders.businessId),
        liveOrderWhere(),
        eq(orders.status, "ready_to_assign"),
        isNull(assignments.id),
      ),
    )
    .orderBy(asc(orders.createdAt))
    .limit(101);

  const orderMap = new Map<string, { businessId: string; styles: Set<string> }>();
  for (const row of unassigned.slice(0, 100)) {
    const current = orderMap.get(row.id) ?? { businessId: row.businessId, styles: new Set<string>() };
    if (row.style) current.styles.add(row.style);
    orderMap.set(row.id, current);
  }

  const designerRows = await tx
    .select({
      businessId: designerBusinesses.businessId,
      styles: designerProfiles.styles,
    })
    .from(designerBusinesses)
    .innerJoin(users, eq(users.id, designerBusinesses.userId))
    .leftJoin(designerProfiles, eq(designerProfiles.userId, users.id))
    .where(
      all(
        scope.kind === "business" ? eq(designerBusinesses.businessId, scope.businessId) : undefined,
        eq(users.role, "designer"),
        eq(users.active, true),
      ),
    );
  const eligibleStyles = new Map<string, Set<string>>();
  for (const row of designerRows) {
    const set = eligibleStyles.get(row.businessId) ?? new Set<string>();
    for (const style of row.styles ?? []) set.add(style);
    eligibleStyles.set(row.businessId, set);
  }

  let noEligible = 0;
  for (const order of orderMap.values()) {
    const stylesForBusiness = eligibleStyles.get(order.businessId) ?? new Set<string>();
    if (order.styles.size === 0 || [...order.styles].every((style) => !stylesForBusiness.has(style))) {
      noEligible += 1;
    }
  }

  const [countRow] = await tx
    .select({ n: sql<number>`count(distinct ${orders.id})::int` })
    .from(orders)
    .leftJoin(assignments, and(eq(assignments.orderId, orders.id), eq(assignments.active, true)))
    .where(
      all(
        scopedWhere(scope, orders.businessId),
        liveOrderWhere(),
        eq(orders.status, "ready_to_assign"),
        isNull(assignments.id),
      ),
    );

  return {
    unassigned: countRow?.n ?? 0,
    noEligibleSample: noEligible,
    sampleLimited: unassigned.length > 100,
  };
}

async function computeHealthMetricsInTx(tx: Tx, scope: HealthScope): Promise<HealthMetrics> {
  const now = new Date();
  const todayStart = startOfZonedDay(now);
  const yesterdayStart = addDays(todayStart, -1);
  const trailing7Start = addDays(todayStart, -7);
  const previous7Start = addDays(todayStart, -14);
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const staleReplyCutoff = new Date(now.getTime() - 24 * 3_600_000);

  const shopsRows = await tx
    .select({
      id: shops.id,
      businessName: businesses.name,
      name: shops.name,
      platform: shops.platform,
      lastSyncAt: sql<string | null>`${shops.integrationConfig}->>${"lastSyncAt"}`,
    })
    .from(shops)
    .innerJoin(businesses, eq(businesses.id, shops.businessId))
    .where(all(scope.kind === "business" ? eq(shops.businessId, scope.businessId) : undefined, eq(shops.active, true)))
    .orderBy(asc(businesses.name), asc(shops.name));
  const gmailMailboxRows = await tx
    .select({
      businessId: businesses.id,
      businessName: businesses.name,
      gmailAddress: businesses.gmailAddress,
      historyId: businesses.gmailHistoryId,
      lastPolledAt: businesses.gmailLastPolledAt,
    })
    .from(businesses)
    .where(
      all(
        scopedWhere(scope, businesses.id),
        isNotNull(businesses.gmailCredentials),
        isNotNull(businesses.gmailHistoryId),
      ),
    )
    .orderBy(asc(businesses.name));
  const emailRows = await tx
    .select({
      queued: sql<number>`count(*) filter (where ${messages.status} = 'queued')::int`,
      failed: sql<number>`count(*) filter (where ${messages.status} = 'failed')::int`,
    })
    .from(messages)
    .where(
      all(
        scopedWhere(scope, messages.businessId),
        eq(messages.direction, "outbound"),
        isNull(messages.archivedAt),
        inArray(messages.status, ["queued", "failed"]),
      ),
    );
  const unmatchedRow = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      all(
        scopedWhere(scope, messages.businessId),
        eq(messages.direction, "inbound"),
        isNull(messages.orderId),
        isNull(messages.archivedAt),
        isNull(messages.suppressedAt),
        lt(messages.createdAt, staleReplyCutoff),
      ),
    );
  const blockedRow = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(earnings)
    .where(all(scopedWhere(scope, earnings.businessId), eq(earnings.status, "blocked")));
  const overdueRow = await tx
    .select({
      count: sql<number>`count(*)::int`,
      worstDueAt: sql<Date | string | null>`min(${orders.dueAt})`,
    })
    .from(orders)
    .where(
      all(
        scopedWhere(scope, orders.businessId),
        liveOrderWhere(),
        notInArray(orders.status, [...CLOSED_STATUSES]),
        lt(orders.dueAt, now),
      ),
    );
  const yesterdayOrdersIn = await countOrdersIn(tx, scope, yesterdayStart, todayStart);
  const trailingOrdersIn = await countOrdersIn(tx, scope, trailing7Start, todayStart);
  const previousOrdersIn = await countOrdersIn(tx, scope, previous7Start, trailing7Start);
  const deliveredRows = await loadDeliveredRows(tx, scope, previous7Start, todayStart);
  const qcRows = await loadQcRows(tx, scope, previous7Start, todayStart);
  const revisionRows = await loadRevisionRows(tx, scope, previous7Start, todayStart);
  const failedQcRows = await tx
    .select({
      checklistSnapshot: qcChecks.checklistSnapshot,
      itemResults: qcChecks.itemResults,
    })
    .from(qcChecks)
    .innerJoin(orders, eq(orders.id, qcChecks.orderId))
    .where(
      all(
        scopedWhere(scope, qcChecks.businessId),
        liveOrderSql(),
        eq(qcChecks.result, "fail"),
        gte(qcChecks.createdAt, trailing7Start),
        lt(qcChecks.createdAt, todayStart),
      ),
    )
    .limit(500);
  const staleIntake = await loadStaleIntake(tx, scope, now);
  const proofNoResponse = await loadProofNoResponse(tx, scope, now);
  const capacity = await loadDesignerCapacity(tx, scope);
  const unassigned = await loadUnassigned(tx, scope);

  const shopHealth: ShopSyncHealth[] = shopsRows.map((shop) => {
    const parsed = shop.lastSyncAt ? new Date(shop.lastSyncAt) : null;
    return {
      id: shop.id,
      businessName: shop.businessName,
      name: shop.name,
      platform: shop.platform,
      lastSyncAt: isoOrNull(parsed),
      stale: !parsed || parsed < oneHourAgo,
    };
  });

  const yesterday = buildWindow({
    ordersIn: yesterdayOrdersIn,
    deliveredRows,
    qcRows,
    revisionRows,
    start: yesterdayStart,
    end: todayStart,
  });
  const trailing7 = buildWindow({
    ordersIn: trailingOrdersIn,
    deliveredRows,
    qcRows,
    revisionRows,
    start: trailing7Start,
    end: todayStart,
  });
  const previous7 = buildWindow({
    ordersIn: previousOrdersIn,
    deliveredRows,
    qcRows,
    revisionRows,
    start: previous7Start,
    end: trailing7Start,
  });

  const queuedEmails = emailRows[0]?.queued ?? 0;
  const failedEmails = emailRows[0]?.failed ?? 0;
  const blockedEarnings = blockedRow[0]?.n ?? 0;
  const staleUnmatchedReplies = unmatchedRow[0]?.n ?? 0;
  const overdueNow = overdueRow[0]?.count ?? 0;
  const worstDueAt = overdueRow[0]?.worstDueAt ?? null;
  const worstOverdueHours = worstDueAt ? hoursBetween(now, worstDueAt) : null;
  const pipelineUnhealthy =
    shopHealth.some((shop) => shop.stale) ||
    queuedEmails > 0 ||
    failedEmails > 0 ||
    staleUnmatchedReplies > 0 ||
    blockedEarnings > 0 ||
    staleIntake > 0 ||
    proofNoResponse > 0;
  const operationsUnhealthy =
    overdueNow > 0 ||
    capacity.over.length > 0 ||
    unassigned.unassigned > 0 ||
    (trailing7.qcFailRate ?? 0) > 10 ||
    (trailing7.revisionRate ?? 0) > 15;

  const scopeLabel = scope.kind === "all" ? "All Businesses" : scope.businessName;

  return {
    generatedAt: now.toISOString(),
    reportDate: zonedDateKey(now),
    scopeLabel,
    scope,
    healthy: !pipelineUnhealthy && !operationsUnhealthy,
    pipeline: {
      shops: shopHealth,
      gmailMailboxes: gmailMailboxRows.map((mailbox) => ({
        businessId: mailbox.businessId,
        businessName: mailbox.businessName,
        gmailAddress: mailbox.gmailAddress,
        lastPolledAt: mailbox.lastPolledAt?.toISOString() ?? null,
        stalled: false,
        dbHistoryId: mailbox.historyId,
        gmailHistoryId: null,
        ageHours: mailbox.lastPolledAt
          ? Math.round(((now.getTime() - mailbox.lastPolledAt.getTime()) / 3_600_000) * 10) / 10
          : null,
      })),
      gmailStalls: [],
      staleShopCount: shopHealth.filter((shop) => shop.stale).length,
      gmailStallCount: 0,
      queuedEmails,
      failedEmails,
      staleUnmatchedReplies,
      blockedEarnings,
      staleIntake,
      proofNoResponse,
    },
    operations: {
      yesterday,
      trailing7,
      previous7,
      overdueNow,
      worstOverdueHours,
      topFailedChecklistItem: topFailedChecklistItem(failedQcRows),
      designersOverCapacity: capacity.over,
      designersIdle: capacity.idle,
      unassigned: unassigned.unassigned,
      noEligibleDesignerSample: unassigned.noEligibleSample,
      noEligibleDesignerSampleLimited: unassigned.sampleLimited,
    },
    links: buildLinks({
      queuedEmails,
      failedEmails,
      staleUnmatchedReplies,
      blockedEarnings,
      staleIntake,
      proofNoResponse,
      staleShopCount: shopHealth.filter((shop) => shop.stale).length,
      gmailStallCount: 0,
      overdueNow,
      worstOverdueHours,
      yesterday,
      trailing7,
      overCapacity: capacity.over.length,
      idle: capacity.idle.length,
      unassigned: unassigned.unassigned,
      noEligibleSample: unassigned.noEligibleSample,
    }),
  };
}

function buildLinks(input: {
  queuedEmails: number;
  failedEmails: number;
  staleUnmatchedReplies: number;
  blockedEarnings: number;
  staleIntake: number;
  proofNoResponse: number;
  staleShopCount: number;
  gmailStallCount: number;
  overdueNow: number;
  worstOverdueHours: number | null;
  yesterday: ThroughputWindow;
  trailing7: ThroughputWindow;
  overCapacity: number;
  idle: number;
  unassigned: number;
  noEligibleSample: number;
}) {
  const pipeline: CountLink[] = [
    {
      label: "Stale shop syncs",
      count: input.staleShopCount,
      href: "/settings",
      tone: input.staleShopCount > 0 ? "danger" : "success",
      detail: "Last successful sync older than 1 hour",
    },
    {
      label: "Mailbox poll stalls",
      count: input.gmailStallCount,
      href: "/health",
      tone: input.gmailStallCount > 0 ? "danger" : "success",
      detail: "Gmail has newer history but AlphaOS has not advanced the cursor",
    },
    {
      label: "Queued emails",
      count: input.queuedEmails,
      href: "/emails",
      tone: input.queuedEmails > 0 ? "warning" : "success",
      detail: "System mail waiting for Gmail",
    },
    {
      label: "Failed emails",
      count: input.failedEmails,
      href: "/emails",
      tone: input.failedEmails > 0 ? "danger" : "success",
      detail: "Customer email needs intervention",
    },
    {
      label: "Unmatched replies >24h",
      count: input.staleUnmatchedReplies,
      href: "/emails",
      tone: input.staleUnmatchedReplies > 0 ? "danger" : "success",
      detail: "Replies captured without an order thread",
    },
    {
      label: "Blocked earnings",
      count: input.blockedEarnings,
      href: "/payouts",
      tone: input.blockedEarnings > 0 ? "warning" : "success",
      detail: "Needs a style rate before payout",
    },
    {
      label: "Stale intake >48h",
      count: input.staleIntake,
      href: "/orders?view=needs_details",
      tone: input.staleIntake > 0 ? "danger" : "success",
      detail: "Awaiting details or photos too long",
    },
    {
      label: "Proof no response >72h",
      count: input.proofNoResponse,
      href: "/orders?view=awaiting_customer",
      tone: input.proofNoResponse > 0 ? "warning" : "success",
      detail: "Customer proof response is stale",
    },
  ];

  const operations: CountLink[] = [
    {
      label: "Orders in yesterday",
      count: input.yesterday.ordersIn,
      href: "/orders?view=active&sort=ordered&dir=desc",
      tone: "neutral",
    },
    {
      label: "Delivered yesterday",
      count: input.yesterday.delivered,
      href: "/orders?view=completed",
      tone: "neutral",
      detail: rateDetail("On time", input.yesterday.onTimeRate),
    },
    {
      label: "Orders in 7 days",
      count: input.trailing7.ordersIn,
      href: "/orders?view=active&sort=ordered&dir=desc",
      tone: "neutral",
    },
    {
      label: "Delivered 7 days",
      count: input.trailing7.delivered,
      href: "/orders?view=completed",
      tone: "neutral",
      detail: rateDetail("On time", input.trailing7.onTimeRate),
    },
    {
      label: "Overdue now",
      count: input.overdueNow,
      href: "/orders?view=overdue",
      tone: input.overdueNow > 0 ? "danger" : "success",
      detail: overdueDetail(input.worstOverdueHours),
    },
    {
      label: "QC fail rate",
      count: input.trailing7.qcFailures,
      href: "/orders?view=awaiting_qc",
      tone: (input.trailing7.qcFailRate ?? 0) > 10 ? "warning" : "success",
      detail: rateDetail("Trailing 7 days", input.trailing7.qcFailRate),
    },
    {
      label: "Revision rate",
      count: input.trailing7.revisionEvents,
      href: "/orders?view=revisions",
      tone: (input.trailing7.revisionRate ?? 0) > 15 ? "warning" : "success",
      detail: rateDetail("Trailing 7 days", input.trailing7.revisionRate),
    },
    {
      label: "Designers over capacity",
      count: input.overCapacity,
      href: "/designers",
      tone: input.overCapacity > 0 ? "warning" : "success",
    },
    {
      label: "Designers idle",
      count: input.idle,
      href: "/designers",
      tone: "neutral",
    },
    {
      label: "Unassigned orders",
      count: input.unassigned,
      href: "/orders?view=unassigned",
      tone: input.unassigned > 0 ? "warning" : "success",
      detail: undefined,
    },
  ];

  return { pipeline, operations };
}

function rateDetail(label: string, rate: number | null) {
  return rate == null ? `${label}: no data` : `${label}: ${rate}%`;
}

function overdueDetail(hours: number | null) {
  if (hours == null) return "No overdue work";
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `Worst is ${days} day${days === 1 ? "" : "s"} overdue`;
  }
  return `Worst is ${hours}h overdue`;
}

export async function loadHealthMetrics(user: RequestUser, scope: HealthScope): Promise<HealthMetrics> {
  const metrics = await withUserContext(user, (tx) => computeHealthMetricsInTx(tx, scope));
  return withGmailStalls(metrics);
}

export async function loadHealthMetricsForSystem(scope: HealthScope): Promise<HealthMetrics> {
  const metrics = await withSystemContext((tx) => computeHealthMetricsInTx(tx, scope));
  return withGmailStalls(metrics);
}

async function withGmailStalls(metrics: HealthMetrics): Promise<HealthMetrics> {
  const gmailStalls = await detectGmailMailboxStalls({
    businessId: metrics.scope.kind === "business" ? metrics.scope.businessId : undefined,
  });
  const links = buildLinks({
    queuedEmails: metrics.pipeline.queuedEmails,
    failedEmails: metrics.pipeline.failedEmails,
    staleUnmatchedReplies: metrics.pipeline.staleUnmatchedReplies,
    blockedEarnings: metrics.pipeline.blockedEarnings,
    staleIntake: metrics.pipeline.staleIntake,
    proofNoResponse: metrics.pipeline.proofNoResponse,
    staleShopCount: metrics.pipeline.staleShopCount,
    gmailStallCount: gmailStalls.length,
    overdueNow: metrics.operations.overdueNow,
    worstOverdueHours: metrics.operations.worstOverdueHours,
    yesterday: metrics.operations.yesterday,
    trailing7: metrics.operations.trailing7,
    overCapacity: metrics.operations.designersOverCapacity.length,
    idle: metrics.operations.designersIdle.length,
    unassigned: metrics.operations.unassigned,
    noEligibleSample: metrics.operations.noEligibleDesignerSample,
  });
  return {
    ...metrics,
    healthy: metrics.healthy && gmailStalls.length === 0,
    pipeline: {
      ...metrics.pipeline,
      gmailMailboxes: metrics.pipeline.gmailMailboxes.map((mailbox) => {
        const stall = gmailStalls.find((s) => s.businessId === mailbox.businessId);
        return stall
          ? {
              ...mailbox,
              stalled: true,
              dbHistoryId: stall.dbHistoryId,
              gmailHistoryId: stall.gmailHistoryId,
              ageHours: stall.ageHours,
            }
          : mailbox;
      }),
      gmailStalls,
      gmailStallCount: gmailStalls.length,
    },
    links,
  };
}
