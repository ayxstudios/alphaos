// Owner QC overdue (clean slating audit, 2026-10-16). Ami Multani #CPS10282 and
// Audrea Sanchez 4196536586 waited 61 h and 64 h for an owner's QC and nobody
// heard: /approve hid them (placed before CPS's to-do start, fixed in
// lib/orders/todo-scope.ts) and nothing watched the wait. #CPS10292, an AI
// portrait held for the owner on /day, waited 62 h the same way.
//
// Every portrait waiting on an owner (awaiting_qc on /approve, or an AI
// portrait in owner_review on /day) is watched now:
//   1. ownerQcSlaHours (12) after it arrived: ONE URGENT to the owner
//      (agent_config.ownerUserId, else every admin) on the owner-notify road the
//      no-limbo digest uses (sendAlphaEvent owner.question).
//   2. ownerQcBackupAfterHours (2) after that URGENT, still unchecked: it goes
//      to the backup approver (agent_config.qcBackupApproverUserId, default the
//      other owner; never an invented person).
// Each step is stamped on the order (activity_log qc.overdue_urgent /
// qc.backup_approver, no actor) so it happens once per wait. An order someone
// has open on /approve right now (a fresh qc_claims row) is left to them. One
// message per person per hour at most, every due order in it.
import { and, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { sendAlphaEvent } from "@/lib/alpha/client";
import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, alphaEvents, businesses, orders, shops, users } from "@/lib/db/schema";
import { CLAIM_TTL_MS, holderName } from "@/lib/qc/claims";
import { appUrl } from "@/lib/urls";
import { getAgentConfig } from "./config";
import { shortShopLabel } from "./owner-digest";

const HOUR = 3_600_000;
export const QC_OVERDUE_SOURCE = "qc_overdue";
export const QC_URGENT_ACTION = "qc.overdue_urgent";
export const QC_BACKUP_ACTION = "qc.backup_approver";
/** One message per person per hour at most (the owner digest's pace). */
export const QC_OVERDUE_EVERY_MINUTES = 60;
/** How far back QC decisions count when finding who really checks a business. */
export const BACKUP_HISTORY_DAYS = 30;
export const QC_OVERDUE_MAX_LINES = 12;

/** "qc" = awaiting_qc on /approve; "owner_review" = an AI portrait held for the owner on /day. */
export type QcWaitKind = "qc" | "owner_review";
export type QcOverdueStage = "none" | "urgent" | "backup";
export type Person = { userId: string; name: string };

/** What is due for one waiting portrait. Pure. */
export function qcOverdueStage(
  w: { enteredAt: Date; urgentAt: Date | null; backupAt: Date | null },
  rule: { slaHours: number; backupAfterHours: number; hasBackup: boolean },
  now: Date,
): QcOverdueStage {
  if (w.backupAt) return "none";
  if (!w.urgentAt) return now.getTime() - w.enteredAt.getTime() >= rule.slaHours * HOUR ? "urgent" : "none";
  if (!rule.hasBackup) return "none";
  return now.getTime() - w.urgentAt.getTime() >= rule.backupAfterHours * HOUR ? "backup" : "none";
}

export type BackupCandidate = Person & {
  /** QC decisions on this business in the last BACKUP_HISTORY_DAYS. */
  here: number;
  /** QC decisions on any business in the same window. */
  all: number;
};

/**
 * The default backup is "the other owner": the active admin, never the
 * primary, who really QCs, most decisions on this business first, then on any
 * business. Nobody without QC history is picked unless they are the one other
 * admin. null = nobody fits; never an invented person. Pure.
 */
export function pickBackupApprover(candidates: BackupCandidate[], primaryId: string | null): BackupCandidate | null {
  const others = candidates.filter((c) => c.userId !== primaryId);
  const ranked = [...others].sort(
    (a, b) => b.here - a.here || b.all - a.all || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId),
  );
  const top = ranked[0];
  if (top && (top.here > 0 || top.all > 0)) return top;
  return others.length === 1 ? others[0] : null;
}

type ActiveAdmin = { id: string; name: string | null; email: string | null };

async function activeAdmins(tx: Tx): Promise<ActiveAdmin[]> {
  return tx
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.active, true)));
}

/**
 * The backup approver for one business: agent_config.qcBackupApproverUserId
 * when that is an active admin other than the owner, else the other owner
 * (pickBackupApprover over the last BACKUP_HISTORY_DAYS of QC decisions).
 * With no single owner set, every admin already had the URGENT, so only an
 * explicit setting names a backup.
 */
export async function resolveBackupApprover(
  tx: Tx,
  businessId: string,
  cfg: { ownerUserId: string | null; qcBackupApproverUserId: string | null },
  now: Date,
  admins?: ActiveAdmin[],
): Promise<Person | null> {
  const pool = admins ?? (await activeAdmins(tx));
  const explicit = cfg.qcBackupApproverUserId
    ? pool.find((a) => a.id === cfg.qcBackupApproverUserId && a.id !== cfg.ownerUserId)
    : undefined;
  if (explicit) return { userId: explicit.id, name: holderName(explicit) };
  if (!cfg.ownerUserId || pool.length === 0) return null;
  const counts = await tx
    .select({
      userId: activityLog.actorId,
      here: sql<number>`(count(*) filter (where ${activityLog.businessId} = ${businessId}))::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(activityLog)
    .where(
      and(
        inArray(
          activityLog.actorId,
          pool.map((a) => a.id),
        ),
        gte(activityLog.createdAt, new Date(now.getTime() - BACKUP_HISTORY_DAYS * 24 * HOUR)),
        // A QC decision: artwork leaving awaiting_qc by a person's hand, or an
        // owner releasing a held AI portrait.
        or(
          and(eq(activityLog.fromState, "awaiting_qc"), sql`${activityLog.toState} is distinct from 'awaiting_qc'`),
          eq(activityLog.action, "ai.owner_approved"),
        ),
      ),
    )
    .groupBy(activityLog.actorId);
  const byId = new Map(counts.map((c) => [c.userId, c]));
  const pick = pickBackupApprover(
    pool.map((a) => ({ userId: a.id, name: holderName(a), here: byId.get(a.id)?.here ?? 0, all: byId.get(a.id)?.all ?? 0 })),
    cfg.ownerUserId,
  );
  return pick ? { userId: pick.userId, name: pick.name } : null;
}

export type QcRule = {
  businessId: string;
  slaHours: number;
  backupAfterHours: number;
  /** null = every admin (no ownerUserId set). */
  primary: Person | null;
  backup: Person | null;
};

async function loadRules(tx: Tx, businessIds: string[] | undefined, now: Date): Promise<Map<string, QcRule>> {
  const bizRows = await tx
    .select({ id: businesses.id, agentConfig: businesses.agentConfig })
    .from(businesses)
    .where(businessIds ? inArray(businesses.id, businessIds) : undefined)
    .orderBy(businesses.id);
  const admins = await activeAdmins(tx);
  const rules = new Map<string, QcRule>();
  for (const b of bizRows) {
    const cfg = getAgentConfig(b);
    let primary: Person | null = null;
    if (cfg.ownerUserId) {
      const known = admins.find((a) => a.id === cfg.ownerUserId);
      if (known) primary = { userId: known.id, name: holderName(known) };
      else {
        const [u] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, cfg.ownerUserId));
        primary = { userId: cfg.ownerUserId, name: u ? holderName(u) : "the owner" };
      }
    }
    rules.set(b.id, {
      businessId: b.id,
      slaHours: cfg.ownerQcSlaHours,
      backupAfterHours: cfg.ownerQcBackupAfterHours,
      primary,
      backup: await resolveBackupApprover(tx, b.id, cfg, now, admins),
    });
  }
  return rules;
}

export type QcWaiting = {
  orderId: string;
  businessId: string;
  number: string;
  shop: string;
  kind: QcWaitKind;
  /** The buyer is chasing (orders.urgent_at). */
  urgentOrder: boolean;
  /** When this wait began: the latest real entry to awaiting_qc, or the hold for the owner. */
  enteredAt: Date;
  /** This wait's URGENT, if sent. */
  urgentAt: Date | null;
  /** This wait's hand-over to the backup approver, if sent. */
  backupAt: Date | null;
  /** Someone has it open on /approve right now. */
  open: boolean;
};

const asDate = (v: unknown) => new Date(v as string);

async function loadWaiting(tx: Tx, filter: { businessIds: string[]; orderIds?: string[] }): Promise<QcWaiting[]> {
  if (!filter.businessIds.length || (filter.orderIds && !filter.orderIds.length)) return [];
  // Subqueries come from a helper so they reach the select list as nested
  // chunks and keep "orders"."id" qualified (see loadFailedAiHolds in ./limbo.ts).
  const lastAt = (cond: SQL) => sql`(select max(a.created_at) from activity_log a where a.order_id = ${orders.id} and ${cond})`;
  const openNow = () =>
    sql`exists (select 1 from qc_claims c where c.order_id = ${orders.id}
      and c.seen_at > now() - ${sql.raw(`interval '${CLAIM_TTL_MS / 1000} seconds'`)})`;
  const rows = await tx
    .select({
      orderId: orders.id,
      businessId: orders.businessId,
      number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
      shopName: shops.name,
      status: orders.status,
      urgentOrder: sql<boolean>`${orders.urgentAt} is not null`,
      updatedAt: orders.updatedAt,
      // order.details_updated logs awaiting_qc -> awaiting_qc: an edit, not a new wait.
      qcEnteredAt: sql<Date | null>`${lastAt(sql`a.to_state = 'awaiting_qc' and a.from_state is distinct from 'awaiting_qc'`)}`.mapWith(asDate),
      heldAt: sql<Date | null>`${lastAt(sql`a.action = 'ai.owner_review_queued'`)}`.mapWith(asDate),
      urgentStampAt: sql<Date | null>`${lastAt(sql`a.action = ${QC_URGENT_ACTION}`)}`.mapWith(asDate),
      backupStampAt: sql<Date | null>`${lastAt(sql`a.action = ${QC_BACKUP_ACTION}`)}`.mapWith(asDate),
      open: sql<boolean>`${openNow()}`,
    })
    .from(orders)
    .leftJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        inArray(orders.businessId, filter.businessIds),
        filter.orderIds ? inArray(orders.id, filter.orderIds) : undefined,
        isNull(orders.archivedAt),
        or(
          eq(orders.status, "awaiting_qc"),
          and(eq(orders.status, "awaiting_approval"), eq(orders.aiState, "owner_review")),
        ),
      ),
    );
  return rows.map((r) => {
    const kind: QcWaitKind = r.status === "awaiting_qc" ? "qc" : "owner_review";
    const enteredAt = (kind === "qc" ? r.qcEnteredAt : r.heldAt) ?? r.updatedAt;
    const thisWait = (d: Date | null) => (d && d.getTime() >= enteredAt.getTime() ? d : null);
    return {
      orderId: r.orderId,
      businessId: r.businessId,
      number: r.number,
      shop: r.shopName ? shortShopLabel(r.shopName) : "",
      kind,
      urgentOrder: !!r.urgentOrder,
      enteredAt,
      urgentAt: thisWait(r.urgentStampAt),
      backupAt: thisWait(r.backupStampAt),
      open: !!r.open,
    };
  });
}

export type QcOverdueLine = QcWaiting & {
  stage: Exclude<QcOverdueStage, "none">;
  hours: number;
  /** URGENT lines: who it goes to next. */
  backup: Person | null;
  backupAfterHours: number;
  slaHours: number;
  /** Backup lines: whose check it was. */
  primary: Person | null;
};

export type QcOverdueBucket = {
  /** The person's id, or "role:admin" for every admin. */
  key: string;
  userId: string | null;
  name: string | null;
  businessIds: string[];
  lines: QcOverdueLine[];
};

type Plan = { rules: Map<string, QcRule>; waiting: QcWaiting[]; buckets: QcOverdueBucket[]; skippedOpen: number };

async function plan(tx: Tx, opts: { now: Date; businessIds?: string[]; orderIds?: string[] }): Promise<Plan> {
  const rules = await loadRules(tx, opts.businessIds, opts.now);
  const waiting = await loadWaiting(tx, { businessIds: [...rules.keys()], orderIds: opts.orderIds });
  const buckets = new Map<string, QcOverdueBucket>();
  let skippedOpen = 0;
  for (const w of waiting) {
    const rule = rules.get(w.businessId);
    if (!rule) continue;
    const stage = qcOverdueStage(w, { slaHours: rule.slaHours, backupAfterHours: rule.backupAfterHours, hasBackup: !!rule.backup }, opts.now);
    if (stage === "none") continue;
    if (w.open) {
      skippedOpen += 1;
      continue;
    }
    const to = stage === "urgent" ? rule.primary : rule.backup;
    const key = to?.userId ?? "role:admin";
    const bucket = buckets.get(key) ?? { key, userId: to?.userId ?? null, name: to?.name ?? null, businessIds: [], lines: [] };
    if (!bucket.businessIds.includes(w.businessId)) bucket.businessIds.push(w.businessId);
    bucket.lines.push({
      ...w,
      stage,
      hours: Math.floor((opts.now.getTime() - w.enteredAt.getTime()) / HOUR),
      backup: rule.backup,
      backupAfterHours: rule.backupAfterHours,
      slaHours: rule.slaHours,
      primary: rule.primary,
    });
    buckets.set(key, bucket);
  }
  for (const b of buckets.values()) {
    b.businessIds.sort();
    b.lines.sort((x, y) => x.enteredAt.getTime() - y.enteredAt.getTime());
  }
  return { rules, waiting, buckets: [...buckets.values()], skippedOpen };
}

function fmtHours(h: number): string {
  return h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h * 10) / 10} h`;
}

function portraits(n: number): string {
  return n === 1 ? "1 portrait" : `${n} portraits`;
}

export function qcLineLink(l: Pick<QcWaiting, "kind" | "orderId">): string {
  return l.kind === "owner_review" ? appUrl("/day") : appUrl(`/approve?o=${l.orderId}`);
}

export function qcLineFor(l: QcOverdueLine): string {
  const label = [l.shop, l.number].filter(Boolean).join(" ");
  const what = [l.kind === "owner_review" ? "AI portrait held for an owner's OK" : null, `${l.hours} h`, l.urgentOrder ? "the buyer is chasing" : null]
    .filter(Boolean)
    .join(", ");
  return `• ${label}: ${what}. ${qcLineLink(l)}`;
}

/** The one message for one person: URGENT first line, a dot line per order, oldest first. */
export function qcOverdueText(lines: QcOverdueLine[]): string {
  const urgent = lines.filter((l) => l.stage === "urgent");
  const backup = lines.filter((l) => l.stage === "backup");
  const out: string[] = [];
  let room = QC_OVERDUE_MAX_LINES;
  const block = (ls: QcOverdueLine[]) => {
    const shown = ls.slice(0, Math.max(room, 0));
    room -= shown.length;
    out.push(...shown.map(qcLineFor));
    if (ls.length > shown.length) out.push(`+${ls.length - shown.length} more: ${appUrl("/approve")}`);
  };
  const slas = [...new Set(urgent.map((l) => l.slaHours))];
  const over = slas.length === 1 ? `over ${fmtHours(slas[0])}` : "too long";
  const owners = [...new Set(backup.map((l) => l.primary?.name).filter(Boolean))];
  const forWhom = owners.length === 1 ? ` for ${owners[0]}` : "";
  if (urgent.length && !backup.length) {
    out.push(`*URGENT* ${portraits(urgent.length)} waiting for your QC ${over}`);
    block(urgent);
  } else if (backup.length && !urgent.length) {
    out.push(`*URGENT* ${portraits(backup.length)} still waiting for QC, over to you as backup${forWhom}`);
    block(backup);
  } else {
    out.push(`*URGENT* ${portraits(lines.length)} waiting for QC too long`);
    out.push(`Waiting for your QC ${over}:`);
    block(urgent);
    out.push(`Still unchecked, over to you as backup${forWhom}:`);
    block(backup);
  }
  if (urgent.length) {
    const next = [...new Set(urgent.map((l) => l.backup?.name).filter((n): n is string => !!n))];
    const after = fmtHours(Math.min(...urgent.map((l) => l.backupAfterHours)));
    if (next.length === 1) out.push(`Not checked in ${after}, ${urgent.length === 1 ? "it goes" : "they go"} to ${next[0]}.`);
    else if (next.length > 1) out.push(`Not checked in ${after}, each goes to its backup (${next.join(", ")}).`);
  }
  return out.join("\n");
}

export type QcOverdueResult = {
  /** Portraits waiting on an owner right now. */
  waiting: number;
  /** URGENT lines sent (dry run: would be). */
  urgent: number;
  /** Lines handed to the backup approver (dry run: would be). */
  backup: number;
  /** Alpha messages queued (dry run: would be). */
  sent: number;
  /** Due lines held because that person had a message in the last hour. */
  heldRecent: number;
  /** Due orders left alone because someone has them open on /approve. */
  skippedOpen: number;
  texts: string[];
};

/**
 * One pass over every business (or the ones given): per person, one message
 * with every due line, each line stamped on its order in the same transaction.
 * The dry run says what it would send and changes nothing.
 */
export async function runQcOverduePass(
  opts: { now?: Date; dryRun?: boolean; businessIds?: string[] } = {},
): Promise<QcOverdueResult> {
  const now = opts.now ?? new Date();
  const result: QcOverdueResult = { waiting: 0, urgent: 0, backup: 0, sent: 0, heldRecent: 0, skippedOpen: 0, texts: [] };
  if (opts.businessIds && opts.businessIds.length === 0) return result;
  const first = await withSystemContext((tx) => plan(tx, { now, businessIds: opts.businessIds }));
  result.waiting = first.waiting.length;
  result.skippedOpen = first.skippedOpen;

  for (const bucket of first.buckets) {
    await withSystemContext(async (tx) => {
      // Two ticks racing: the second waits here, then sees the first one's stamps.
      await tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(inArray(businesses.id, bucket.businessIds))
        .orderBy(businesses.id)
        .for("update");
      if (await sentRecently(tx, bucket.userId, now)) {
        result.heldRecent += bucket.lines.length;
        return;
      }
      const again = await plan(tx, { now, businessIds: bucket.businessIds, orderIds: bucket.lines.map((l) => l.orderId) });
      const lines = again.buckets.find((b) => b.key === bucket.key)?.lines ?? [];
      if (!lines.length) return;
      const text = qcOverdueText(lines);
      result.texts.push(text);
      result.urgent += lines.filter((l) => l.stage === "urgent").length;
      result.backup += lines.filter((l) => l.stage === "backup").length;
      result.sent += 1;
      if (opts.dryRun) return;
      const lineBusinesses = [...new Set(lines.map((l) => l.businessId))];
      const eventId = await sendAlphaEvent(tx, {
        type: "owner.question",
        businessId: lineBusinesses.length === 1 ? lineBusinesses[0] : null,
        orderId: lines.length === 1 ? lines[0].orderId : null,
        toUserId: bucket.userId,
        toRole: bucket.userId ? null : "admin",
        text,
        payload: {
          source: QC_OVERDUE_SOURCE,
          orderIds: lines.map((l) => l.orderId),
          urgent: lines.filter((l) => l.stage === "urgent").length,
          backup: lines.filter((l) => l.stage === "backup").length,
        },
      });
      await tx.insert(activityLog).values(
        lines.map((l) => ({
          businessId: l.businessId,
          orderId: l.orderId,
          actorId: null,
          action: l.stage === "urgent" ? QC_URGENT_ACTION : QC_BACKUP_ACTION,
          // On the pass's clock, the one every stage above is measured on.
          createdAt: now,
          metadata: {
            kind: l.kind,
            enteredAt: l.enteredAt.toISOString(),
            hours: l.hours,
            toUserId: bucket.userId,
            toName: bucket.name ?? "every owner",
            eventId,
          },
        })),
      );
    });
  }
  return result;
}

async function sentRecently(tx: Tx, userId: string | null, now: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: alphaEvents.id })
    .from(alphaEvents)
    .where(
      and(
        eq(alphaEvents.type, "owner.question"),
        sql`${alphaEvents.payload}->>'source' = ${QC_OVERDUE_SOURCE}`,
        userId ? eq(alphaEvents.toUserId, userId) : and(isNull(alphaEvents.toUserId), eq(alphaEvents.toRole, "admin")),
        gte(alphaEvents.createdAt, new Date(now.getTime() - QC_OVERDUE_EVERY_MINUTES * 60_000)),
      ),
    )
    .limit(1);
  return !!row;
}

export type QcOverdueItem = {
  orderId: string;
  orderNumber: string;
  shop: string;
  businessId: string;
  kind: QcWaitKind;
  enteredAt: string;
  hours: number;
  /** Past the business's ownerQcSlaHours. */
  overdue: boolean;
  urgentSentAt: string | null;
  backupSentAt: string | null;
  /** What the next pass does with it (none: not due yet, done, or no backup). */
  next: QcOverdueStage;
  /** Someone has it open on /approve right now. */
  open: boolean;
  owner: Person | null;
  backup: Person | null;
  link: string;
};

/**
 * Read-only view for the agent (GET /api/agent-qc/overdue): every portrait
 * waiting on an owner past its SLA (all = every one waiting), oldest first.
 */
export async function listQcOverdue(opts: { now?: Date; all?: boolean; businessIds?: string[] } = {}): Promise<QcOverdueItem[]> {
  const now = opts.now ?? new Date();
  return withSystemContext(async (tx) => {
    const rules = await loadRules(tx, opts.businessIds, now);
    const waiting = await loadWaiting(tx, { businessIds: [...rules.keys()] });
    const items: QcOverdueItem[] = [];
    for (const w of waiting.sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime())) {
      const rule = rules.get(w.businessId);
      if (!rule) continue;
      const hours = (now.getTime() - w.enteredAt.getTime()) / HOUR;
      const overdue = hours >= rule.slaHours;
      if (!overdue && !opts.all) continue;
      items.push({
        orderId: w.orderId,
        orderNumber: w.number,
        shop: w.shop,
        businessId: w.businessId,
        kind: w.kind,
        enteredAt: w.enteredAt.toISOString(),
        hours: Math.floor(hours),
        overdue,
        urgentSentAt: w.urgentAt?.toISOString() ?? null,
        backupSentAt: w.backupAt?.toISOString() ?? null,
        next: qcOverdueStage(w, { slaHours: rule.slaHours, backupAfterHours: rule.backupAfterHours, hasBackup: !!rule.backup }, now),
        open: w.open,
        owner: rule.primary,
        backup: rule.backup,
        link: qcLineLink(w),
      });
    }
    return items;
  });
}
