// Agent autopilot tick (docs/AGENT_FIRST.md, phase 1). One pass over every
// business with an agent switch on:
//   intake  (agentIntakeEnabled): complete Etsy awaiting_details orders whose
//           details resolve from rules, and check photo count vs figures;
//   assign  (agentAssignEnabled): auto-assign ready_to_assign orders that have
//           no active assignment;
//   inbox   (agentInboxEnabled, phase 2): act on buyer replies and chase
//           silent proofs (./inbox.ts).
// Anything the agent cannot decide becomes an exception for a human. Every
// order runs in its own transaction, so one bad order never stops the tick;
// a dry run does the same work and rolls each transaction back. Idempotent: a
// tick right after a tick writes nothing.

import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

import { SYSTEM_ACTOR_ID, withSystemContext, type Tx } from "@/lib/db";
import {
  activityLog,
  assets,
  assignments,
  businesses,
  customers,
  designerBusinesses,
  designerProfiles,
  exceptions,
  messages,
  orderItems,
  orders,
  shops,
  users,
} from "@/lib/db/schema";
import { queuePhotoRequest, queuePhotoShortfall } from "@/lib/email/dispatch";
import { shopStyleChoices } from "@/lib/designers/styles";
import type { EtsyIntegrationConfig, EtsyTransaction } from "@/lib/integrations/etsy/types";
import { runAutoAssign } from "@/lib/orders/assign";
import { liveOrderWhere } from "@/lib/orders/archive";
import { completeOrderDetailsCore } from "@/lib/orders/complete-details";

import { computeCompleteness } from "./completeness";
import { openExceptionTx, type ExceptionKind } from "./exceptions";
import { emptyInboxReport, runInboxPass, type InboxReport } from "./inbox";
import { runOutboxPass, type OutboxReport } from "./outbox";
import { rebalanceBusiness } from "./rebalance";
import { parseIntake } from "./intake";
import { findCatalogStyle, registerUnindexedProduct } from "./legacy-intake";

/** How long a customer has to answer the shortfall email before a human is asked. */
export const PHOTO_SHORTFALL_GRACE_HOURS = 72;
/** How long an order may sit in ready_to_assign with nobody eligible before a human is asked. */
export const NO_DESIGNER_GRACE_HOURS = 4;
/** Stop starting new orders after this long, so the cron stays inside maxDuration. */
const DEFAULT_BUDGET_MS = 45_000;
/** Orders looked at per business per step and tick. */
const BATCH = 200;

/**
 * A resolved exception is a human's answer. The agent does not raise the same
 * question again for the same order, except "nobody can take this", which can
 * become true again once capacity changes (after a day).
 */
const REOPEN_AFTER_HOURS: Record<ExceptionKind, number | null> = {
  intake_unparsed: null,
  photo_count_mismatch: null,
  no_eligible_designer: 24,
  // Raised by the inbox pass (./inbox.ts), which asks again for every new reply.
  reply_unclear: 0,
  buyer_question: 0,
  unmatched_reply: 0,
  // Raised by the outbox pass (./outbox.ts); one card per stuck email.
  email_send_failed: 0,
  // Raised by the intake area (./legacy-intake.ts); one card per legacy order / product.
  legacy_order: 0,
  new_product: 0,
};

export type AgentOrderError = { orderId: string; message: string };

export type AgentBusinessReport = {
  businessId: string;
  businessName: string;
  intakeEnabled: boolean;
  assignEnabled: boolean;
  inboxEnabled: boolean;
  /** Etsy awaiting_details orders parsed. */
  intakeChecked: number;
  etsyDetailsCompleted: number;
  photoRequestsQueued: number;
  /** awaiting_photos / ready_to_assign orders with photos, checked for count. */
  completenessChecked: number;
  photoShortfallDrafted: number;
  exceptionsOpened: number;
  exceptionKinds: string[];
  /** ready_to_assign orders with no active assignment. */
  assignChecked: number;
  assigned: number;
  noEligibleDesigner: number;
  /** Left to a human: the importer flagged them (missing email, conflicts). */
  skippedNeedsReview: number;
  /** Not-yet-started orders moved off an over-capacity or away designer. */
  rebalanced: number;
  /** Inbox pass counts (all zero when the inbox switch is off). */
  inbox: Omit<InboxReport, "exceptionsOpened" | "exceptionKinds" | "errors">;
  /** Outbox pass counts: agent mail sent by itself, retries, failed-send exceptions. */
  outbox?: Omit<OutboxReport, "errors">;
  errors: AgentOrderError[];
};

export type AgentTickReport = {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  /** True when the time budget ran out before every order was looked at. */
  truncated: boolean;
  businesses: AgentBusinessReport[];
};

export type AgentTickOptions = {
  dryRun?: boolean;
  businessId?: string;
  budgetMs?: number;
  now?: Date;
};

/** Thrown at the end of a dry-run transaction so nothing it wrote is kept. */
class DryRunRollback extends Error {
  constructor() {
    super("agent dry run rollback");
  }
}

type OrderRef = {
  id: string;
  businessId: string;
  customerId: string | null;
  platformOrderId: string;
  platformOrderName: string | null;
  uploadToken: string | null;
};

const HOUR = 60 * 60 * 1000;

function orderLabel(o: { platformOrderName: string | null; platformOrderId: string }): string {
  return o.platformOrderName ?? o.platformOrderId;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runAgentTick(opts: AgentTickOptions = {}): Promise<AgentTickReport> {
  const dryRun = !!opts.dryRun;
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const now = opts.now ?? new Date();
  let truncated = false;
  const outOfTime = () => {
    if (Date.now() > deadline) truncated = true;
    return truncated;
  };

  const bizRows = await withSystemContext((tx) =>
    tx
      .select({
        id: businesses.id,
        name: businesses.name,
        intake: businesses.agentIntakeEnabled,
        assign: businesses.agentAssignEnabled,
        inbox: businesses.agentInboxEnabled,
        agentConfig: businesses.agentConfig,
      })
      .from(businesses)
      .where(
        and(
          or(
            eq(businesses.agentIntakeEnabled, true),
            eq(businesses.agentAssignEnabled, true),
            eq(businesses.agentInboxEnabled, true),
          ),
          opts.businessId ? eq(businesses.id, opts.businessId) : undefined,
        ),
      )
      .orderBy(businesses.name),
  );

  const reports: AgentBusinessReport[] = [];
  for (const biz of bizRows) {
    const report: AgentBusinessReport = {
      businessId: biz.id,
      businessName: biz.name,
      intakeEnabled: biz.intake,
      assignEnabled: biz.assign,
      inboxEnabled: biz.inbox,
      intakeChecked: 0,
      etsyDetailsCompleted: 0,
      photoRequestsQueued: 0,
      completenessChecked: 0,
      photoShortfallDrafted: 0,
      exceptionsOpened: 0,
      exceptionKinds: [],
      assignChecked: 0,
      assigned: 0,
      noEligibleDesigner: 0,
      skippedNeedsReview: 0,
      rebalanced: 0,
      inbox: inboxCounts(emptyInboxReport()),
      errors: [],
    };
    reports.push(report);
    const ctx: TickCtx = { dryRun, now, report };

    if (biz.intake && !outOfTime()) await intakeStep(ctx, biz.id, outOfTime);
    if (biz.intake && !outOfTime()) await completenessStep(ctx, biz.id, outOfTime);
    if (biz.assign && !outOfTime()) await assignStep(ctx, biz.id, outOfTime);
    if (biz.assign && !outOfTime()) {
      try {
        const rb = await rebalanceBusiness(biz.id, { dryRun, now });
        report.rebalanced += rb.moves.length;
        for (const e of rb.errors) report.errors.push(e);
      } catch (e) {
        report.errors.push({ orderId: "", message: `rebalance: ${errorMessage(e)}` });
      }
    }
    if (biz.inbox && !outOfTime()) {
      const inbox = await runInboxPass(biz, { dryRun, now, outOfTime });
      report.inbox = inboxCounts(inbox);
      report.exceptionsOpened += inbox.exceptionsOpened;
      for (const k of inbox.exceptionKinds) if (!report.exceptionKinds.includes(k)) report.exceptionKinds.push(k);
      for (const e of inbox.errors) {
        report.errors.push({ orderId: e.orderId ?? "", message: e.messageId ? `message ${e.messageId}: ${e.message}` : e.message });
      }
    }
    // Every enabled business: the agent's mail goes out on its own, failed sends are retried.
    if (!outOfTime()) {
      const outbox = await runOutboxPass(biz, { dryRun, now, outOfTime });
      const { errors, ...counts } = outbox;
      report.outbox = counts;
      report.exceptionsOpened += outbox.exceptionsOpened;
      if (outbox.exceptionsOpened && !report.exceptionKinds.includes("email_send_failed")) report.exceptionKinds.push("email_send_failed");
      for (const e of errors) report.errors.push({ orderId: "", message: e.messageId ? `email ${e.messageId}: ${e.message}` : e.message });
    }
  }

  return {
    dryRun,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    truncated,
    businesses: reports,
  };
}

function inboxCounts(r: InboxReport): AgentBusinessReport["inbox"] {
  const counts: Partial<InboxReport> = { ...r };
  delete counts.exceptionsOpened;
  delete counts.exceptionKinds;
  delete counts.errors;
  return counts as AgentBusinessReport["inbox"];
}

type TickCtx = { dryRun: boolean; now: Date; report: AgentBusinessReport };

/**
 * Run one order's work in its own system transaction. Counters are applied
 * only once the transaction's outcome is final (committed, or rolled back on
 * purpose in a dry run), so a failed order never shows up as done.
 */
async function perOrder(
  ctx: TickCtx,
  orderId: string,
  fn: (tx: Tx, bump: (apply: (r: AgentBusinessReport) => void) => void) => Promise<void>,
): Promise<void> {
  const pending: ((r: AgentBusinessReport) => void)[] = [];
  try {
    await withSystemContext(async (tx) => {
      await fn(tx, (apply) => pending.push(apply));
      if (ctx.dryRun) throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) {
      ctx.report.errors.push({ orderId, message: errorMessage(e) });
      return;
    }
  }
  for (const apply of pending) apply(ctx.report);
}

async function logAgent(
  tx: Tx,
  order: { id: string; businessId: string },
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: order.id,
    actorId: null,
    action,
    metadata,
  });
}

/**
 * Open an exception (plus its `agent.exception_opened` audit row) unless an
 * open one exists, or a human already resolved this question for the order.
 */
async function raise(
  tx: Tx,
  bump: (apply: (r: AgentBusinessReport) => void) => void,
  now: Date,
  order: { id: string; businessId: string },
  kind: ExceptionKind,
  summary: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const reopenAfter = REOPEN_AFTER_HOURS[kind];
  const [resolved] = await tx
    .select({ id: exceptions.id })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.orderId, order.id),
        eq(exceptions.kind, kind),
        eq(exceptions.status, "resolved"),
        reopenAfter == null
          ? undefined
          : gte(exceptions.resolvedAt, new Date(now.getTime() - reopenAfter * HOUR)),
      ),
    )
    .limit(1);
  if (resolved) return;

  const opened = await openExceptionTx(tx, {
    businessId: order.businessId,
    orderId: order.id,
    kind,
    summary,
    detail,
  });
  if (!opened.created) return;
  await logAgent(tx, order, "agent.exception_opened", { exceptionId: opened.id, kind });
  bump((r) => {
    r.exceptionsOpened += 1;
    if (!r.exceptionKinds.includes(kind)) r.exceptionKinds.push(kind);
  });
}

// ---------------------------------------------------------------------------
// Intake (i): Etsy awaiting_details
// ---------------------------------------------------------------------------

async function intakeStep(ctx: TickCtx, businessId: string, outOfTime: () => boolean): Promise<void> {
  const rows = await withSystemContext((tx) =>
    tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, "awaiting_details"),
          eq(orders.source, "etsy"),
          liveOrderWhere(),
        ),
      )
      .orderBy(orders.createdAt)
      .limit(BATCH),
  );

  for (const { id } of rows) {
    if (outOfTime()) return;
    await perOrder(ctx, id, async (tx, bump) => {
      const [order] = await tx
        .select({
          id: orders.id,
          businessId: orders.businessId,
          shopId: orders.shopId,
          status: orders.status,
          customerId: orders.customerId,
          platformOrderId: orders.platformOrderId,
          platformOrderName: orders.platformOrderName,
          uploadToken: orders.uploadToken,
          rawImport: orders.rawImport,
          notes: orders.notes,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .for("update");
      // Moved on (a VA or the other tick got there first): nothing to do.
      if (!order || order.status !== "awaiting_details") return;
      bump((r) => (r.intakeChecked += 1));

      const [shop] = await tx
        .select({ styles: shops.styles, config: shops.integrationConfig })
        .from(shops)
        .where(eq(shops.id, order.shopId));
      const styleOptions = await shopStyleChoices(tx, order.businessId, shop?.styles);
      const [cust] = order.customerId
        ? await tx
            .select({ email: customers.email, firstName: customers.firstName, lastName: customers.lastName })
            .from(customers)
            .where(eq(customers.id, order.customerId))
        : [];

      // The product this order is for, checked against the business catalog.
      const firstTx = (order.rawImport as { transactions?: { title?: string | null; sku?: string | null }[] } | null)
        ?.transactions?.[0];
      const listingTitle = firstTx?.title?.trim() || null;
      const catalog = listingTitle
        ? await findCatalogStyle(tx, order.businessId, { title: listingTitle, sku: firstTx?.sku })
        : null;

      const parse = parseIntake({
        catalogStyle: catalog && !catalog.autoCreated ? catalog.name : null,
        rawImport: order.rawImport,
        shopConfig: (shop?.config ?? null) as EtsyIntegrationConfig | null,
        styleOptions,
        customerName: [cust?.firstName, cust?.lastName].filter(Boolean).join(" ") || null,
        customerEmail: cust?.email ?? null,
        orderNotes: order.notes,
      });

      const unparsed = async (missing: string[]) => {
        const first = missing[0]?.split(" (")[0] ?? "details";
        await raise(tx, bump, ctx.now, order, "intake_unparsed", `Etsy order #${orderLabel(order)}: could not resolve ${first}`, {
          variations: etsyVariations(order.rawImport),
          suggested: {
            figureCount: parse.bestGuess.figureCount,
            style: parse.bestGuess.style,
            productType: parse.bestGuess.productType,
          },
          missing,
          notes: {
            figureCount: parse.bestGuess.figureCountNote,
            style: parse.bestGuess.styleNote,
          },
        });
      };

      // A product AlphaOS has never mapped: index it, ask who draws it, and
      // hold the order (never drop it) until that is answered.
      if (!parse.confident && listingTitle && !parse.bestGuess.style && (!catalog || catalog.autoCreated)) {
        const reg = await registerUnindexedProduct(tx, {
          businessId: order.businessId,
          shopId: order.shopId,
          orderId: order.id,
          title: listingTitle,
          sku: firstTx?.sku,
        });
        if (reg.createdCard) {
          bump((r) => {
            r.exceptionsOpened += 1;
            if (!r.exceptionKinds.includes("new_product")) r.exceptionKinds.push("new_product");
          });
        }
        return;
      }

      if (!parse.confident) {
        await unparsed(parse.missing);
        return;
      }

      const v = parse.values;
      const res = await completeOrderDetailsCore(
        { id: SYSTEM_ACTOR_ID, role: "system" },
        {
          orderId: order.id,
          figureCount: v.figureCount,
          figureCountSource: "shop_rule",
          style: v.style,
          // A rule chose it, not a person: a later re-resolve may change it.
          styleLocked: false,
          productTitle: v.productTitle,
          productType: v.productType,
          notes: v.notes,
          customerName: v.customerName,
          customerEmail: v.customerEmail,
        },
        (fn) => fn(tx),
        {
          expectedStatus: "awaiting_details",
          via: "agent_intake",
          afterApply: async (inner, applied) => {
            await logAgent(inner, order, "agent.intake_completed", {
              figureCount: v.figureCount,
              style: v.style,
              productType: v.productType,
              toStatus: applied.toStatus,
            });
            if (applied.toStatus === "awaiting_photos" && order.uploadToken) {
              const queued = await queuePhotoRequestOnce(inner, { ...order, uploadToken: order.uploadToken });
              if (queued) bump((r) => (r.photoRequestsQueued += 1));
            }
          },
        },
      );
      if (res.ok) {
        bump((r) => (r.etsyDetailsCompleted += 1));
      } else {
        await unparsed([res.message]);
      }
    });
  }
}

/** The Etsy variations on the stored receipt, for the exception detail. */
function etsyVariations(rawImport: unknown): { title: string | null; variations: unknown[] }[] {
  const raw = rawImport as { transactions?: EtsyTransaction[] } | null;
  const txs = Array.isArray(raw?.transactions) ? raw.transactions : [];
  return txs.map((t) => ({ title: t.title ?? null, variations: t.variations ?? [] }));
}

/** Queue the photo request unless this order already has one (any status). */
async function queuePhotoRequestOnce(tx: Tx, order: OrderRef & { uploadToken: string }): Promise<string | null> {
  const [existing] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.orderId, order.id), eq(messages.templateKey, "photo_request")))
    .limit(1);
  if (existing) return null;
  return queuePhotoRequest(tx, order);
}

// ---------------------------------------------------------------------------
// Intake (ii): photo count vs figures ordered
// ---------------------------------------------------------------------------

async function completenessStep(ctx: TickCtx, businessId: string, outOfTime: () => boolean): Promise<void> {
  const photoCount = sql<number>`(
    select count(*)::int from ${assets}
    where ${assets.orderId} = ${orders.id} and ${assets.type} = 'reference' and ${assets.deletedAt} is null
  )`;
  const rows = await withSystemContext((tx) =>
    tx
      .select({ id: orders.id, photoCount })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          inArray(orders.status, ["awaiting_photos", "ready_to_assign"]),
          liveOrderWhere(),
          sql`${photoCount} > 0`,
        ),
      )
      .orderBy(orders.createdAt)
      .limit(BATCH),
  );

  for (const row of rows) {
    if (outOfTime()) return;
    await perOrder(ctx, row.id, async (tx, bump) => {
      const [order] = await tx
        .select({
          id: orders.id,
          businessId: orders.businessId,
          status: orders.status,
          customerId: orders.customerId,
          platformOrderId: orders.platformOrderId,
          platformOrderName: orders.platformOrderName,
          uploadToken: orders.uploadToken,
        })
        .from(orders)
        .where(eq(orders.id, row.id))
        .for("update");
      if (!order || (order.status !== "awaiting_photos" && order.status !== "ready_to_assign")) return;

      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(assets)
        .where(and(eq(assets.orderId, order.id), eq(assets.type, "reference"), isNull(assets.deletedAt)));
      const items = await tx
        .select({ figureCount: orderItems.figureCount, figureCountSource: orderItems.figureCountSource })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      const have = Number(count?.n ?? 0);
      if (have === 0) return;
      bump((r) => (r.completenessChecked += 1));

      const verdict = computeCompleteness({ photoCount: have, items });
      // "unknown" means a guess somewhere: never block or bother anyone on it.
      if (verdict.verdict !== "mismatch" || verdict.expectedFigures == null) return;
      const need = verdict.expectedFigures;

      const [drafted] = await tx
        .select({ createdAt: activityLog.createdAt, metadata: activityLog.metadata })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, order.id), eq(activityLog.action, "agent.photo_shortfall_drafted")))
        .orderBy(desc(activityLog.createdAt))
        .limit(1);

      if (!drafted) {
        const messageId = order.uploadToken
          ? await queuePhotoShortfall(tx, { ...order, uploadToken: order.uploadToken }, { have, need })
          : null;
        if (!messageId) {
          // Nobody to ask (no customer email or no upload link): straight to a human.
          await raise(tx, bump, ctx.now, order, "photo_count_mismatch",
            `Order #${orderLabel(order)}: ${have} photos for ${need} figures, no way to ask the customer`,
            { have, need, messageId: null, reason: order.uploadToken ? "no customer email" : "no upload link" });
          return;
        }
        await logAgent(tx, order, "agent.photo_shortfall_drafted", { have, need, messageId });
        bump((r) => (r.photoShortfallDrafted += 1));
        return;
      }

      const askedAt = new Date(drafted.createdAt);
      if (ctx.now.getTime() - askedAt.getTime() < PHOTO_SHORTFALL_GRACE_HOURS * HOUR) return;
      const meta = (drafted.metadata ?? {}) as { messageId?: string | null };
      await raise(tx, bump, ctx.now, order, "photo_count_mismatch",
        `Order #${orderLabel(order)}: ${have} photos for ${need} figures, customer asked ${askedAt.toISOString().slice(0, 10)}`,
        { have, need, messageId: meta.messageId ?? null, askedAt: askedAt.toISOString() });
    });
  }
}

// ---------------------------------------------------------------------------
// Assign: ready_to_assign with no active assignment
// ---------------------------------------------------------------------------

async function assignStep(ctx: TickCtx, businessId: string, outOfTime: () => boolean): Promise<void> {
  const rows = await withSystemContext((tx) =>
    tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, "ready_to_assign"),
          liveOrderWhere(),
          sql`not exists (select 1 from ${assignments} where ${assignments.orderId} = ${orders.id} and ${assignments.active})`,
        ),
      )
      .orderBy(orders.createdAt)
      .limit(BATCH),
  );

  for (const { id } of rows) {
    if (outOfTime()) return;
    await perOrder(ctx, id, async (tx, bump) => {
      const [order] = await tx
        .select({
          id: orders.id,
          businessId: orders.businessId,
          status: orders.status,
          needsReview: orders.needsReview,
          updatedAt: orders.updatedAt,
          platformOrderId: orders.platformOrderId,
          platformOrderName: orders.platformOrderName,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .for("update");
      if (!order || order.status !== "ready_to_assign") return;
      const [active] = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.orderId, order.id), eq(assignments.active, true)))
        .limit(1);
      if (active) return;
      bump((r) => (r.assignChecked += 1));
      // The importer held these back on purpose (no email, conflicts, unresolved figures).
      if (order.needsReview) {
        bump((r) => (r.skippedNeedsReview += 1));
        return;
      }

      const { assigned } = await runAutoAssign(tx, { orderId: order.id, businessId: order.businessId, assignedBy: null });
      if (assigned) {
        await logAgent(tx, order, "agent.assigned", { designerId: assigned, via: "agent_autopilot" });
        bump((r) => (r.assigned += 1));
        return;
      }

      bump((r) => (r.noEligibleDesigner += 1));
      const [entered] = await tx
        .select({ at: activityLog.createdAt })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, order.id), eq(activityLog.toState, "ready_to_assign")))
        .orderBy(desc(activityLog.createdAt))
        .limit(1);
      const enteredAt = new Date(entered?.at ?? order.updatedAt);
      if (ctx.now.getTime() - enteredAt.getTime() < NO_DESIGNER_GRACE_HOURS * HOUR) return;

      const why = await whyNoDesigner(tx, order.businessId, order.id);
      await raise(tx, bump, ctx.now, order, "no_eligible_designer",
        `Order #${orderLabel(order)}: no designer can take it (${why.headline})`,
        { enteredReadyAt: enteredAt.toISOString(), ...why });
    });
  }
}

/**
 * Why nobody is eligible, per designer on the roster: the same hard filters
 * as rankCandidates in lib/orders/assign.ts (style, daily capacity, max active).
 */
async function whyNoDesigner(
  tx: Tx,
  businessId: string,
  orderId: string,
): Promise<{ headline: string; style: string | null; roster: { designerId: string; name: string | null; blockers: string[] }[] }> {
  const [item] = await tx
    .select({ style: orderItems.style })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .limit(1);
  const style = item?.style?.trim() || null;

  const roster = await tx
    .select({
      designerId: designerProfiles.userId,
      name: users.name,
      styles: designerProfiles.styles,
      dailyCapacity: designerProfiles.dailyCapacity,
      maxActiveOrders: designerProfiles.maxActiveOrders,
    })
    .from(designerBusinesses)
    .innerJoin(users, and(eq(users.id, designerBusinesses.userId), eq(users.active, true), eq(users.role, "designer")))
    .innerJoin(designerProfiles, eq(designerProfiles.userId, designerBusinesses.userId))
    .where(eq(designerBusinesses.businessId, businessId));
  if (!roster.length) return { headline: "no active designers on this business", style, roster: [] };

  const ids = roster.map((r) => r.designerId);
  const today = new Map<string, number>();
  for (const r of await tx
    .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(inArray(assignments.designerId, ids), gte(assignments.assignedAt, sql`date_trunc('day', now())`)))
    .groupBy(assignments.designerId)) {
    today.set(r.designerId, Number(r.n));
  }
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
        liveOrderWhere(),
      ),
    )
    .groupBy(assignments.designerId)) {
    wip.set(r.designerId, Number(r.n));
  }

  const wanted = style?.toLowerCase() ?? null;
  const detail = roster.map((r) => {
    const blockers: string[] = [];
    if (wanted && !(r.styles ?? []).some((s) => s.trim().toLowerCase() === wanted)) blockers.push(`does not do ${style}`);
    const t = today.get(r.designerId) ?? 0;
    if (t >= r.dailyCapacity) blockers.push(`at daily capacity (${t}/${r.dailyCapacity})`);
    const w = wip.get(r.designerId) ?? 0;
    if (r.maxActiveOrders !== 0 && w >= r.maxActiveOrders) blockers.push(`at max active orders (${w}/${r.maxActiveOrders})`);
    return { designerId: r.designerId, name: r.name, blockers };
  });
  const noStyle = detail.filter((d) => d.blockers.some((b) => b.startsWith("does not do"))).length;
  const headline =
    wanted && noStyle === detail.length
      ? `nobody does ${style}`
      : `${detail.length} designer(s), all blocked by style or capacity`;
  return { headline, style, roster: detail };
}
