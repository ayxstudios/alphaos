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

import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { holdAlphaPushesIf } from "@/lib/alpha/client";
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
  printJobs,
  shops,
  users,
} from "@/lib/db/schema";
import { preparePrintOrder } from "@/lib/print/prepare";
import { submitPrintOrder } from "@/lib/print/submit";
import { getAgentConfig } from "./config";
import { ensureAgentDesigner } from "./ai-core";
import { queuePhotoRequest, queuePhotoShortfall } from "@/lib/email/dispatch";
import { shopStyleChoices } from "@/lib/designers/styles";
import type { EtsyIntegrationConfig, EtsyTransaction } from "@/lib/integrations/etsy/types";
import { businessSlaHours, createAssignment, runAutoAssign } from "@/lib/orders/assign";
import { classifyOrder, isNonPortraitLine, type ClassifyConfig } from "@/lib/integrations/classify";
import { liveOrderWhere } from "@/lib/orders/archive";
import { agentOrderScope } from "./scope";
import { completeOrderDetailsCore } from "@/lib/orders/complete-details";

import { computeCompleteness } from "./completeness";
import { openExceptionTx, type ExceptionKind } from "./exceptions";
import { emptyInboxReport, runInboxPass, type InboxReport } from "./inbox";
import { runOutboxPass, type OutboxReport } from "./outbox";
import { runProofRepliesPass, type ProofRepliesReport } from "./proof-replies";
import { rebalanceBusiness } from "./rebalance";
import { reopenArchivedWithBuyerWords } from "@/lib/orders/reopen";
import { runNotStartedPass } from "./not-started";
import { parseIntake } from "./intake";
import { findCatalogStyle, registerUnindexedProduct } from "./legacy-intake";
import {
  autoCloseStaleExceptions,
  autoResolveTx,
  checkDesignerBacklog,
  closeClearedBacklogs,
  findAddonParents,
  getLimboCensus,
  handFailedAiToDesigners,
  linkAddonTx,
  noDesignerRecommendation,
  pickOverflowDesigner,
  watchWaitingStates,
  type LimboCensus,
} from "./limbo";
import { clearUnmatchedReplies, type ClearMailResult } from "./junk-mail";
import { sendOwnerDigest, type OwnerDigestResult } from "./owner-digest";
import { runQcOverduePass, type QcOverdueResult } from "./qc-overdue";

/** How long a customer has to answer the shortfall email before a human is asked. */
export const PHOTO_SHORTFALL_GRACE_HOURS = 72;
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
  // An add-on-only order (Print & Ship, a rush upgrade) that reached the design queue.
  addon_only: null,
  // Raised by the AI designer (./ai-designer.ts) and the no-limbo passes (./limbo.ts).
  ai_designer_failed: 0,
  stuck_order: 0,
  designer_backlog: 0,
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
  /** Add-on-only orders (no portrait to draw) left for a person instead of a designer. */
  addonOnly: number;
  /** Add-on-only orders linked to the buyer's one portrait order (now fulfillment_only). */
  addonLinked?: number;
  /** Of `assigned`: orders that went to the style's main designer past their limit (docs/NO_LIMBO.md L3). */
  overflowAssigned?: number;
  /** Left to a human: the importer flagged them (missing email, conflicts). */
  skippedNeedsReview: number;
  /** Not-yet-started orders moved off an over-capacity or away designer. */
  rebalanced: number;
  /** Orders nobody started notStartedMoveHours after assignment, moved to a designer with room (./not-started.ts). */
  notStartedMoved?: number;
  /** Orders past that clock left where they are (admin pin, no style, moved enough, nobody with room). */
  notStartedKept?: number;
  /** Approved orders looked at for a print draft (agentConfig.printDrafts). */
  printChecked?: number;
  /** Gelato draft orders set up (dry run: would be set up), waiting for a person in Gelato. */
  printDrafts?: number;
  /** Approved orders left for a person to submit (not Gelato, or not ready). */
  printLeftForPerson?: number;
  /** Inbox pass counts (all zero when the inbox switch is off). */
  inbox: Omit<InboxReport, "exceptionsOpened" | "exceptionKinds" | "errors">;
  /** Email approvals and change requests applied with the inbox switch off (./proof-replies.ts). */
  proofReplies?: Omit<ProofRepliesReport, "errors">;
  /** Outbox pass counts: agent mail sent by itself, retries, failed-send exceptions. */
  outbox?: Omit<OutboxReport, "errors">;
  /** No limbo pass (docs/NO_LIMBO.md): junk mail cleared, stale rows closed, stuck orders raised, census. */
  noLimbo?: NoLimboReport;
  errors: AgentOrderError[];
};

export type NoLimboReport = {
  mail: ClearMailResult | null;
  autoClosed: number;
  autoClosedBy: Record<string, number>;
  stuckOpened: number;
  stuckRefreshed: number;
  stuckClosed: number;
  backlogsClosed: number;
  /** Orders the AI designer failed on, given to a person. */
  aiHandedOver: number;
  /** Archived, still-owed orders a buyer wrote about since, now back on the boards. */
  reopenedByBuyer: number;
  census: LimboCensus | null;
};

export type AgentTickReport = {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  /** True when the time budget ran out before every order was looked at. */
  truncated: boolean;
  businesses: AgentBusinessReport[];
  /** Portraits waiting too long for the owner's QC: one URGENT, then the backup approver (./qc-overdue.ts). */
  qcOverdue?: QcOverdueResult;
  qcOverdueError?: string;
  /** The one owner message this tick (docs/NO_LIMBO.md L5). */
  digest?: OwnerDigestResult;
  digestError?: string;
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

/**
 * One agent tick. A dry run holds every alpha hook push for its whole length
 * (lib/alpha/client.ts withAlphaPushesHeld), so no pass can message a person
 * about work the dry run then undoes (clean slating P6, 2026-10-16).
 */
export function runAgentTick(opts: AgentTickOptions = {}): Promise<AgentTickReport> {
  return holdAlphaPushesIf(!!opts.dryRun, () => tick(opts));
}

async function tick(opts: AgentTickOptions): Promise<AgentTickReport> {
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
      // Every business: the switches gate the steps below, but no limbo is
      // across all of AlphaOS (docs/NO_LIMBO.md), switched on or not.
      .where(opts.businessId ? eq(businesses.id, opts.businessId) : undefined)
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
      addonOnly: 0,
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
    // Not started 24 h after assignment: to a designer with room (clean slating
    // audit 2026-10-16: Abdul 103, Jerome 89, Mar 57 open while orders sat untouched).
    if (biz.assign && !outOfTime()) {
      try {
        const ns = await runNotStartedPass(biz.id, { dryRun, now, outOfTime });
        report.notStartedMoved = ns.moves.length;
        report.notStartedKept = ns.keptPinned + ns.keptNoStyle + ns.keptMovedEnough + ns.noTarget;
        for (const e of ns.errors) report.errors.push(e);
      } catch (e) {
        report.errors.push({ orderId: "", message: `not started: ${errorMessage(e)}` });
      }
    }
    if (biz.assign && getAgentConfig(biz).printDrafts && !outOfTime()) await printDraftStep(ctx, biz.id, outOfTime);
    if (biz.inbox && !outOfTime()) {
      const inbox = await runInboxPass(biz, { dryRun, now, outOfTime });
      report.inbox = inboxCounts(inbox);
      report.exceptionsOpened += inbox.exceptionsOpened;
      for (const k of inbox.exceptionKinds) if (!report.exceptionKinds.includes(k)) report.exceptionKinds.push(k);
      for (const e of inbox.errors) {
        report.errors.push({ orderId: e.orderId ?? "", message: e.messageId ? `message ${e.messageId}: ${e.message}` : e.message });
      }
    }
    // Inbox switch off: still hear a clear email approval or change request on a
    // proof (clean slating audit 2026-10-16: CPS approvals by Emily Page and
    // Megan Coakley never reached AlphaOS). The inbox pass above covers it when on.
    if (!biz.inbox && !outOfTime()) {
      try {
        const pr = await runProofRepliesPass(biz, { dryRun, outOfTime });
        const { errors, ...counts } = pr;
        report.proofReplies = counts;
        for (const e of errors) report.errors.push({ orderId: e.orderId ?? "", message: e.messageId ? `message ${e.messageId}: ${e.message}` : e.message });
      } catch (e) {
        report.errors.push({ orderId: "", message: `proof replies: ${errorMessage(e)}` });
      }
    }
    // Every enabled business: the agent's mail goes out on its own, failed sends are retried.
    if ((biz.intake || biz.assign || biz.inbox) && !outOfTime()) {
      const outbox = await runOutboxPass(biz, { dryRun, now, outOfTime });
      const { errors, ...counts } = outbox;
      report.outbox = counts;
      report.exceptionsOpened += outbox.exceptionsOpened;
      if (outbox.exceptionsOpened && !report.exceptionKinds.includes("email_send_failed")) report.exceptionKinds.push("email_send_failed");
      for (const e of errors) report.errors.push({ orderId: "", message: e.messageId ? `email ${e.messageId}: ${e.message}` : e.message });
    }
    if (!outOfTime()) await noLimboStep(ctx, biz.id, biz.assign);
  }

  // Portraits waiting on an owner's QC past ownerQcSlaHours: one URGENT, then
  // the backup approver (clean slating audit 2026-10-16: Ami Multani #CPS10282
  // and Audrea Sanchez 4196536586 waited 61 h and 64 h unseen). Cheap, so it
  // runs even when the order budget ran out, like the digest below.
  let qcOverdue: QcOverdueResult | undefined;
  let qcOverdueError: string | undefined;
  try {
    qcOverdue = await runQcOverduePass({ now: opts.now ?? new Date(), dryRun, businessIds: bizRows.map((b) => b.id) });
  } catch (e) {
    qcOverdueError = errorMessage(e);
  }

  // One owner message for everything still stuck, every business together.
  // Cheap, so it runs even when the order budget ran out (the cron's
  // maxDuration has room past the budget).
  let digest: OwnerDigestResult | undefined;
  let digestError: string | undefined;
  try {
    // Read the clock again: a row the steps above opened a moment ago (no
    // designer, a stuck order) is due now, not at the next hourly message.
    digest = await sendOwnerDigest({ now: opts.now ?? new Date(), dryRun, businessIds: bizRows.map((b) => b.id) });
  } catch (e) {
    digestError = errorMessage(e);
  }

  return {
    dryRun,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    truncated,
    businesses: reports,
    qcOverdue,
    ...(qcOverdueError ? { qcOverdueError } : {}),
    digest,
    ...(digestError ? { digestError } : {}),
  };
}

// ---------------------------------------------------------------------------
// No limbo (docs/NO_LIMBO.md): every business, every tick
// ---------------------------------------------------------------------------

async function noLimboStep(ctx: TickCtx, businessId: string, assignOn: boolean): Promise<void> {
  const { dryRun, now, report } = ctx;
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      report.errors.push({ orderId: "", message: `${what}: ${errorMessage(e)}` });
      return null;
    }
  };
  // L2 first (a matched email becomes a card on its order), the AI handover
  // (assigning, so only with the assign switch on), then L1, L4, the backlog
  // lines, the census.
  const mail = await attempt("junk mail", () => clearUnmatchedReplies(businessId, { now, dryRun }));
  // L10: buyer words on an archived, still-owed order bring it back before the
  // watch and the census look (lib/orders/reopen.ts).
  const reopened = await attempt("reopen archived", () => reopenArchivedWithBuyerWords(businessId, { dryRun }));
  const handover = assignOn ? await attempt("ai handover", () => handFailedAiToDesigners(businessId, { now, dryRun })) : null;
  const stale = await attempt("auto close", () => autoCloseStaleExceptions(businessId, { now, dryRun }));
  const watch = await attempt("waiting orders", () => watchWaitingStates(businessId, { now, dryRun }));
  const backlogsClosed = await attempt("designer backlog", () => closeClearedBacklogs(businessId, { now, dryRun }));
  const census = await attempt("census", () => getLimboCensus(businessId, { now }));
  if (watch?.opened) {
    report.exceptionsOpened += watch.opened;
    if (!report.exceptionKinds.includes("stuck_order")) report.exceptionKinds.push("stuck_order");
  }
  report.noLimbo = {
    mail,
    autoClosed: stale?.closed ?? 0,
    autoClosedBy: stale?.byReason ?? {},
    stuckOpened: watch?.opened ?? 0,
    stuckRefreshed: watch?.refreshed ?? 0,
    stuckClosed: watch?.closed ?? 0,
    backlogsClosed: backlogsClosed ?? 0,
    aiHandedOver: handover?.handed ?? 0,
    reopenedByBuyer: reopened?.reopened.length ?? 0,
    census,
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
    await holdAlphaPushesIf(ctx.dryRun, () =>
      withSystemContext(async (tx) => {
        await fn(tx, (apply) => pending.push(apply));
        if (ctx.dryRun) throw new DryRunRollback();
      }),
    );
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
          agentOrderScope(),
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
      // Add-on lines (Print & Ship, rush upgrades) are never the product: skip them,
      // or an add-on listed first on a mixed order opens a bogus "New product" card.
      const firstTx = (order.rawImport as { transactions?: { title?: string | null; sku?: string | null }[] } | null)
        ?.transactions?.find((t) => !isNonPortraitLine(t, shop?.config as ClassifyConfig | null));
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
          agentOrderScope(),
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
// Print drafts: approved orders that route to Gelato become Gelato DRAFT
// orders (nothing prints until a person approves the draft in Gelato). An
// order that ever had a print job is never touched again, so a failed or
// rejected submit is a person's call, never retried in a loop.
// ---------------------------------------------------------------------------

async function printDraftStep(ctx: TickCtx, businessId: string, outOfTime: () => boolean): Promise<void> {
  const rows = await withSystemContext((tx) =>
    tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.status, "approved"),
          liveOrderWhere(),
          agentOrderScope(),
          sql`not exists (select 1 from ${printJobs} pj where pj.order_id = ${orders.id})`,
        ),
      )
      .orderBy(orders.createdAt)
      .limit(BATCH),
  );
  const r = ctx.report;
  for (const { id } of rows) {
    if (outOfTime()) return;
    r.printChecked = (r.printChecked ?? 0) + 1;
    try {
      if (ctx.dryRun) {
        const plan = await withSystemContext((tx) => preparePrintOrder(id, { tx }));
        if (plan && plan.provider === "gelato" && !plan.blockers.length) r.printDrafts = (r.printDrafts ?? 0) + 1;
        else r.printLeftForPerson = (r.printLeftForPerson ?? 0) + 1;
        continue;
      }
      const agentId = await withSystemContext((tx) => ensureAgentDesigner(tx, businessId));
      const res = await submitPrintOrder({ orderId: id, actorUserId: agentId, actorRole: "admin", requireDraft: true });
      if (res.ok) r.printDrafts = (r.printDrafts ?? 0) + 1;
      else r.printLeftForPerson = (r.printLeftForPerson ?? 0) + 1;
    } catch (e) {
      r.errors.push({ orderId: id, message: `print draft: ${errorMessage(e)}` });
    }
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
          agentOrderScope(),
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
          customerId: orders.customerId,
          placedAt: orders.placedAt,
          createdAt: orders.createdAt,
          shopConfig: shops.integrationConfig,
        })
        .from(orders)
        .leftJoin(shops, eq(shops.id, orders.shopId))
        .where(eq(orders.id, id))
        .for("update", { of: orders });
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
      // Add-on-only orders (Print & Ship, rush upgrades) have nothing to draw.
      // Imports before the shop's non-portrait list existed landed here anyway,
      // so check again and hand them to a person rather than a designer.
      const lines = await tx
        .select({ sku: orderItems.sku, title: orderItems.title })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      const cfg = (order.shopConfig ?? null) as ClassifyConfig | null;
      if (classifyOrder({ sourceName: null, lines, config: cfg }) === "fulfillment_only") {
        // No limbo (L3): an add-on rides on the buyer's one portrait order.
        const titles = lines.map((l) => l.title ?? "").filter(Boolean);
        const parents = await findAddonParents(tx, order);
        if (parents.length === 1) {
          await linkAddonTx(tx, { id: order.id, businessId: order.businessId, number: orderLabel(order), status: order.status }, parents[0], titles);
          const open = await tx
            .select({ id: exceptions.id })
            .from(exceptions)
            .where(and(eq(exceptions.orderId, order.id), eq(exceptions.kind, "addon_only"), eq(exceptions.status, "open")));
          await autoResolveTx(tx, open.map((e) => ({ id: e.id, businessId: order.businessId, orderId: order.id, kind: "addon_only", reason: `linked to order ${parents[0].number}` })), ctx.now);
          bump((r) => (r.addonLinked = (r.addonLinked ?? 0) + 1));
          return;
        }
        bump((r) => (r.addonOnly += 1));
        const recommendation = parents.length
          ? `Link it to the right portrait order: ${parents.map((p) => p.number).join(" or ")}.`
          : "No open portrait order from this buyer in the last 30 days: fulfil it on its own or check with the buyer.";
        await raise(tx, bump, ctx.now, order, "addon_only",
          `Order #${orderLabel(order)} is an add-on only (${titles.join(", ") || "no title"}): match it to the portrait order and fulfil it`,
          { titles: lines.map((l) => l.title), candidates: parents.map((p) => ({ id: p.id, number: p.number, status: p.status })), recommendation });
        return;
      }

      const { assigned } = await runAutoAssign(tx, { orderId: order.id, businessId: order.businessId, assignedBy: null });
      if (assigned) {
        await logAgent(tx, order, "agent.assigned", { designerId: assigned, via: "agent_autopilot" });
        bump((r) => (r.assigned += 1));
        await backlogCheck(tx, order, assigned, ctx.now);
        return;
      }

      // No limbo (L3): everyone who draws the style is at a limit, so the
      // style's main designer takes it into their queue; their due date moves
      // out by the queue (orders.due_at never moves).
      const why = await whyNoDesigner(tx, order.businessId, order.id);
      const overflow = why.style ? await pickOverflowDesigner(tx, order.businessId, why.style) : null;
      if (overflow) {
        const sla = (await businessSlaHours(tx, order.businessId)).order;
        const dueAtHours = sla + 24 * Math.floor(overflow.queue / overflow.dailyCapacity);
        await createAssignment(tx, { orderId: order.id, businessId: order.businessId, designerId: overflow.designerId, assignedBy: null, dueAtHours });
        await logAgent(tx, order, "agent.assigned", {
          designerId: overflow.designerId,
          via: "agent_autopilot",
          overflow: true,
          queue: overflow.queue,
          dailyCapacity: overflow.dailyCapacity,
          dueAtHours,
        });
        bump((r) => {
          r.assigned += 1;
          r.overflowAssigned = (r.overflowAssigned ?? 0) + 1;
        });
        await backlogCheck(tx, order, overflow.designerId, ctx.now);
        return;
      }

      // Nobody draws the style (or it is unknown): the owner hears at once, with what I would do.
      bump((r) => (r.noEligibleDesigner += 1));
      const product = lines.find((l) => l.title)?.title ?? null;
      const recommendation = await noDesignerRecommendation(tx, order.businessId, why.style, product);
      await raise(tx, bump, ctx.now, order, "no_eligible_designer",
        `Order #${orderLabel(order)}: no designer can take it (${why.headline})`,
        { ...why, recommendation });
    });
  }
}

/** After an assignment: the designer's not-started queue for the order's style past 3 days of their limit is one line for the owner. */
async function backlogCheck(tx: Tx, order: { id: string; businessId: string }, designerId: string, now: Date): Promise<void> {
  const [item] = await tx
    .select({ style: orderItems.style })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, order.id), sql`${orderItems.style} is not null`))
    .limit(1);
  const style = item?.style?.trim();
  if (!style) return;
  await checkDesignerBacklog(tx, { businessId: order.businessId, designerId, style, now });
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
    // The AI Studio agent is never a human candidate (same filter as loadRankedCandidates).
    .where(and(eq(designerBusinesses.businessId, businessId), eq(designerProfiles.isAgent, false)));
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
