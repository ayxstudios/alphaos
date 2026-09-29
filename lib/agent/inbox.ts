// Agent inbox pass (docs/AGENT_FIRST.md, phase 2), run by the autopilot tick
// for businesses with agentInboxEnabled. Three jobs:
//   replies   every inbound customer message matched to an order that the
//             agent has not handled: apply clear approvals and revision
//             requests, draft an answer to questions (a VA approves it), and
//             raise a reply_unclear exception for anything else;
//   unmatched inbound replies with no order become one unmatched_reply
//             exception each;
//   silence   awaiting_approval orders whose proof has gone unanswered get a
//             proof_reminder (a draft unless the business auto-sends).
// A message is handled once an agent.reply_applied / reply_escalated /
// reply_answer_drafted activity row names it, so a second tick is a no-op.
// The classification is persisted on the message (metadata.replyClassification,
// like the Gmail poller) and never re-run. Each message and order gets its own
// transaction; a dry run rolls every one back.

import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import { SYSTEM_ACTOR_ID, withSystemContext, type Tx } from "@/lib/db";
import {
  activityLog,
  businesses,
  customers,
  exceptions,
  messages,
  orders,
  proofs,
  reminderFires,
} from "@/lib/db/schema";
import { anthropicFeaturesEnabled } from "@/lib/ai/anthropic";
import { draftFreeformReply, queueStageEmail } from "@/lib/email/dispatch";
import { getUnmatchedReplies } from "@/lib/email/outbox";
import {
  applyReplyClassificationDecision,
  type ReplyDecision,
  type SystemReplyActor,
} from "@/lib/email/reply-decisions";
import {
  classifyProofReply,
  stripQuotedReplyText,
  type ReplyIntent,
} from "@/lib/email/reply-classifier";
import { mergeReplyClassification } from "@/lib/integrations/gmail/inbound";
import { liveOrderWhere } from "@/lib/orders/archive";
import { proofUrl } from "@/lib/urls";

import { draftAnswerToQuestion } from "./answer";
import { getAgentConfig } from "./config";
import { openExceptionTx, type ExceptionKind } from "./exceptions";

/** Activity actions that mark an inbound message as handled by the agent. */
export const HANDLED_ACTIONS = ["agent.reply_applied", "agent.reply_escalated", "agent.reply_answer_drafted"] as const;
/** At most this many agent reminders per proof; after that the day-5 alert takes over. */
const MAX_REMINDERS_PER_PROOF = 2;
/** No second proof reminder inside this window, whoever drafted the first. */
const REMINDER_COOLDOWN_HOURS = 72;
const EXCERPT_CHARS = 300;
const BATCH = 200;
const HOUR = 60 * 60 * 1000;
const SYSTEM: SystemReplyActor = { id: SYSTEM_ACTOR_ID, role: "system" };

export type InboxItemError = { messageId?: string; orderId?: string; message: string };

export type InboxReport = {
  /** Unhandled inbound replies on orders looked at. */
  repliesChecked: number;
  /** Replies the agent classified itself (no stored classification yet). */
  classified: number;
  approvalsApplied: number;
  revisionsApplied: number;
  answersDrafted: number;
  /** Replies handed to a human (reply_unclear or buyer_question). */
  repliesEscalated: number;
  unmatchedChecked: number;
  unmatchedEscalated: number;
  remindersChecked: number;
  remindersDrafted: number;
  exceptionsOpened: number;
  exceptionKinds: string[];
  errors: InboxItemError[];
};

export type InboxPassOptions = {
  dryRun?: boolean;
  now?: Date;
  /** Returns true once the tick's time budget is spent. */
  outOfTime?: () => boolean;
};

export function emptyInboxReport(): InboxReport {
  return {
    repliesChecked: 0,
    classified: 0,
    approvalsApplied: 0,
    revisionsApplied: 0,
    answersDrafted: 0,
    repliesEscalated: 0,
    unmatchedChecked: 0,
    unmatchedEscalated: 0,
    remindersChecked: 0,
    remindersDrafted: 0,
    exceptionsOpened: 0,
    exceptionKinds: [],
    errors: [],
  };
}

class DryRunRollback extends Error {
  constructor() {
    super("agent inbox dry run rollback");
  }
}

type Bump = (apply: (r: InboxReport) => void) => void;
type Ctx = { dryRun: boolean; now: Date; report: InboxReport };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One item in its own transaction; counters apply only once the outcome is final. */
async function perItem(
  ctx: Ctx,
  ref: { messageId?: string; orderId?: string },
  fn: (tx: Tx, bump: Bump) => Promise<void>,
): Promise<void> {
  const pending: ((r: InboxReport) => void)[] = [];
  try {
    await withSystemContext(async (tx) => {
      await fn(tx, (apply) => pending.push(apply));
      if (ctx.dryRun) throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) {
      ctx.report.errors.push({ ...ref, message: errorMessage(e) });
      return;
    }
  }
  for (const apply of pending) apply(ctx.report);
}

async function logAgent(
  tx: Tx,
  ref: { businessId: string; orderId: string | null },
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(activityLog).values({
    businessId: ref.businessId,
    orderId: ref.orderId,
    actorId: null,
    action,
    metadata,
  });
}

async function alreadyHandled(tx: Tx, businessId: string, messageId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.businessId, businessId),
        inArray(activityLog.action, [...HANDLED_ACTIONS]),
        sql`${activityLog.metadata}->>'messageId' = ${messageId}`,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Open an exception unless an open one of this kind is already on the order;
 * then the message id is added to that one's detail.messageIds instead, so a
 * human sees every reply it covers.
 */
async function raise(
  tx: Tx,
  bump: Bump,
  ref: { businessId: string; orderId: string | null },
  kind: ExceptionKind,
  summary: string,
  detail: Record<string, unknown> & { messageId: string },
): Promise<string> {
  const opened = await openExceptionTx(tx, { ...ref, kind, summary, detail });
  if (opened.created) {
    await logAgent(tx, ref, "agent.exception_opened", { exceptionId: opened.id, kind });
    bump((r) => {
      r.exceptionsOpened += 1;
      if (!r.exceptionKinds.includes(kind)) r.exceptionKinds.push(kind);
    });
  } else {
    await tx
      .update(exceptions)
      .set({
        detail: sql`jsonb_set(${exceptions.detail}, '{messageIds}', coalesce(${exceptions.detail}->'messageIds', '[]'::jsonb) || to_jsonb(${detail.messageId}::text))`,
      })
      .where(eq(exceptions.id, opened.id));
  }
  return opened.id;
}

function excerptOf(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT_CHARS ? clean.slice(0, EXCERPT_CHARS) : clean;
}

type StoredClassification = {
  intent: ReplyIntent;
  confidence: number;
  rationale: string;
  strippedText: string;
};

function storedClassification(metadata: unknown): StoredClassification | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const c = (metadata as Record<string, unknown>).replyClassification;
  if (!c || typeof c !== "object") return null;
  const r = c as Record<string, unknown>;
  const intents: ReplyIntent[] = ["approval", "revision_request", "question", "unclear"];
  if (!intents.includes(r.intent as ReplyIntent) || typeof r.confidence !== "number") return null;
  return {
    intent: r.intent as ReplyIntent,
    confidence: r.confidence,
    rationale: typeof r.rationale === "string" ? r.rationale : "",
    strippedText: typeof r.strippedText === "string" ? r.strippedText : "",
  };
}

function stageWords(status: string): string {
  if (status === "awaiting_approval") return "waiting for the customer to approve the proof";
  return status.replace(/_/g, " ");
}

/** What a human should probably do with a reply the agent would not act on. */
function suggestionFor(
  c: StoredClassification | null,
  orderStatus: string,
  threshold: number,
  illegal: string | null,
): string {
  if (!c) return "The agent could not classify this reply. Read it and decide: approve, send back to design, or answer.";
  if (illegal) {
    return c.intent === "approval"
      ? `Looks like an approval, but ${illegal}. Check whether anything still needs doing.`
      : c.intent === "revision_request"
        ? `Looks like a revision request, but ${illegal}. Decide whether to reopen the design.`
        : `Read the reply; ${illegal}.`;
  }
  const pct = `${Math.round(c.confidence * 100)}%`;
  if (c.intent === "approval") {
    return `Probably an approval (${pct}, below the ${Math.round(threshold * 100)}% bar). If it is, approve the order.`;
  }
  if (c.intent === "revision_request") {
    return `Probably a revision request (${pct}, below the ${Math.round(threshold * 100)}% bar). If it is, send the order back to design with the buyer's words.`;
  }
  if (orderStatus === "awaiting_approval") {
    return "Not clearly an approval or a change request. Ask the buyer whether they approve the proof or want changes.";
  }
  return "Not clearly an approval, a change request or a question. Read it and reply if needed.";
}

export async function runInboxPass(
  business: { id: string; name: string; agentConfig?: unknown },
  opts: InboxPassOptions = {},
): Promise<InboxReport> {
  const report = emptyInboxReport();
  const ctx: Ctx = { dryRun: !!opts.dryRun, now: opts.now ?? new Date(), report };
  const outOfTime = opts.outOfTime ?? (() => false);
  const cfg = getAgentConfig(business);
  const lookback = new Date(ctx.now.getTime() - cfg.inboxLookbackHours * HOUR);
  const enabledAt = cfg.inboxEnabledAt ? new Date(cfg.inboxEnabledAt) : null;
  // Never reach back past the moment the switch went on (no backlog flood).
  const since = enabledAt && enabledAt > lookback ? enabledAt : lookback;

  if (!outOfTime()) await repliesStep(ctx, business.id, cfg.replyConfidenceThreshold, since, outOfTime);
  if (!outOfTime()) await unmatchedStep(ctx, business.id, since, outOfTime);
  if (!outOfTime()) await reminderStep(ctx, business.id, cfg.proofReminderAfterHours, outOfTime);
  return report;
}

// ---------------------------------------------------------------------------
// Replies matched to an order
// ---------------------------------------------------------------------------

type ReplyRow = {
  id: string;
  businessId: string;
  orderId: string;
  subject: string | null;
  body: string | null;
  address: string | null;
  metadata: unknown;
};

async function repliesStep(
  ctx: Ctx,
  businessId: string,
  threshold: number,
  since: Date,
  outOfTime: () => boolean,
): Promise<void> {
  const handled = sql`exists (select 1 from ${activityLog} al where al.business_id = ${messages.businessId}
    and al.action in ('agent.reply_applied', 'agent.reply_escalated', 'agent.reply_answer_drafted')
    and al.metadata->>'messageId' = ${messages.id})`;
  const rows: ReplyRow[] = await withSystemContext((tx) =>
    tx
      .select({
        id: messages.id,
        businessId: messages.businessId,
        orderId: sql<string>`${messages.orderId}`,
        subject: messages.subject,
        body: messages.body,
        address: messages.address,
        metadata: messages.metadata,
      })
      .from(messages)
      .innerJoin(orders, eq(orders.id, messages.orderId))
      .where(
        and(
          eq(messages.businessId, businessId),
          eq(messages.direction, "inbound"),
          isNotNull(messages.orderId),
          isNull(messages.archivedAt),
          isNull(messages.suppressedAt),
          gte(messages.createdAt, since),
          // Customer words only: email replies and Etsy conversation messages
          // (not Etsy sale / shipped notifications).
          or(
            eq(messages.channel, "email"),
            and(eq(messages.channel, "etsy"), sql`${messages.metadata}->>'kind' = 'message'`),
          ),
          // A VA already decided this reply from the suggestion card.
          sql`coalesce(${messages.metadata}->'replyClassification'->'vaDecision', 'null'::jsonb) = 'null'::jsonb`,
          sql`not ${handled}`,
          liveOrderWhere(),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(BATCH),
  );

  for (const row of rows) {
    if (outOfTime()) return;
    ctx.report.repliesChecked += 1;
    await handleReply(ctx, row, threshold);
  }
}

async function handleReply(ctx: Ctx, row: ReplyRow, threshold: number): Promise<void> {
  // Network calls happen before the transaction opens.
  let classification = storedClassification(row.metadata);
  let fresh: Awaited<ReturnType<typeof classifyProofReply>> = null;
  if (!classification && anthropicFeaturesEnabled()) {
    try {
      fresh = await classifyProofReply({ subject: row.subject, body: row.body ?? "" });
    } catch {
      fresh = null;
    }
    if (fresh) classification = fresh;
  }
  const cleaned = classification?.strippedText || stripQuotedReplyText(row.body ?? "") || (row.body ?? "").trim();

  // Order facts for the answer prompt (read outside the write transaction).
  let answer: string | null = null;
  if (classification?.intent === "question" && anthropicFeaturesEnabled()) {
    const facts = await withSystemContext(async (tx) => {
      const [o] = await tx
        .select({
          status: orders.status,
          platformOrderId: orders.platformOrderId,
          platformOrderName: orders.platformOrderName,
          businessName: businesses.name,
          firstName: customers.firstName,
        })
        .from(orders)
        .innerJoin(businesses, eq(businesses.id, orders.businessId))
        .leftJoin(customers, eq(customers.id, orders.customerId))
        .where(eq(orders.id, row.orderId))
        .limit(1);
      return o ?? null;
    });
    if (facts) {
      try {
        answer = await draftAnswerToQuestion({
          businessName: facts.businessName,
          firstName: facts.firstName,
          orderNumber: facts.platformOrderName ?? facts.platformOrderId,
          orderStage: stageWords(facts.status),
          question: cleaned,
        });
      } catch {
        answer = null;
      }
    }
  }

  await perItem(ctx, { messageId: row.id, orderId: row.orderId }, async (tx, bump) => {
    const [msg] = await tx
      .select({ metadata: messages.metadata, gmailThreadId: messages.gmailThreadId, address: messages.address })
      .from(messages)
      .where(eq(messages.id, row.id))
      .for("update")
      .limit(1);
    if (!msg) return;
    if (await alreadyHandled(tx, row.businessId, row.id)) return;

    if (fresh && !storedClassification(msg.metadata)) {
      await tx
        .update(messages)
        .set({ metadata: mergeReplyClassification(msg.metadata, fresh) })
        .where(eq(messages.id, row.id));
      await tx.insert(activityLog).values({
        businessId: row.businessId,
        orderId: row.orderId,
        actorId: null,
        action: "message.reply_classified",
        metadata: {
          messageId: row.id,
          via: "agent",
          classification: {
            model: fresh.model,
            intent: fresh.intent,
            confidence: fresh.confidence,
            rationale: fresh.rationale,
          },
        },
      });
      bump((r) => (r.classified += 1));
    }

    const [order] = await tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        customerId: orders.customerId,
        status: orders.status,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
      })
      .from(orders)
      .where(eq(orders.id, row.orderId))
      .limit(1);
    if (!order) return;
    const ref = { businessId: row.businessId, orderId: order.id };
    const orderNo = order.platformOrderName ?? order.platformOrderId;
    const c = classification;
    const classifier = c ? { intent: c.intent, confidence: c.confidence, rationale: c.rationale } : null;

    // 1. Clear approval or revision request on a proof that is out for approval.
    const decision: ReplyDecision | null =
      c && c.confidence >= threshold
        ? c.intent === "approval"
          ? "approved"
          : c.intent === "revision_request"
            ? "revision"
            : null
        : null;
    let illegal: string | null = null;
    if (decision && order.status !== "awaiting_approval") {
      illegal = `the order is ${order.status.replace(/_/g, " ")}, not awaiting approval`;
    } else if (decision) {
      let failure: string | null = null;
      try {
        // Savepoint: a refused transition leaves the outer transaction usable.
        const res = await tx.transaction((sp) =>
          applyReplyClassificationDecision(sp, SYSTEM, row.id, decision, {
            via: "agent_inbox",
            revisionReason: decision === "revision" ? cleaned : undefined,
          }),
        );
        if (!res.ok) failure = res.message;
      } catch (e) {
        failure = errorMessage(e);
      }
      if (!failure) {
        await logAgent(tx, ref, "agent.reply_applied", {
          messageId: row.id,
          intent: c!.intent,
          confidence: c!.confidence,
          decision,
        });
        bump((r) => {
          if (decision === "approved") r.approvalsApplied += 1;
          else r.revisionsApplied += 1;
        });
        return;
      }
      illegal = `the agent could not apply it (${failure})`;
    }

    // 2. A question: draft an answer for the VA, or hand it over.
    if (c?.intent === "question" && !illegal) {
      const draftId = answer
        ? await draftFreeformReply(tx, {
            order,
            inReplyTo: { id: row.id, address: msg.address, gmailThreadId: msg.gmailThreadId },
            subject: /^re:/i.test(row.subject ?? "") ? row.subject! : `Re: ${row.subject || `Your order ${orderNo}`}`,
            body: answer,
            metadata: { agentDrafted: true },
          })
        : null;
      if (draftId) {
        await logAgent(tx, ref, "agent.reply_answer_drafted", { messageId: row.id, draftMessageId: draftId });
        bump((r) => (r.answersDrafted += 1));
        return;
      }
      const exceptionId = await raise(tx, bump, ref, "buyer_question", `Buyer question on order ${orderNo}`, {
        messageId: row.id,
        excerpt: excerptOf(cleaned),
        suggested: null,
      });
      await logAgent(tx, ref, "agent.reply_escalated", { messageId: row.id, kind: "buyer_question", exceptionId });
      bump((r) => (r.repliesEscalated += 1));
      return;
    }

    // 3. Anything else: below the bar, unclear, or not applicable now.
    const exceptionId = await raise(tx, bump, ref, "reply_unclear", `Buyer reply on order ${orderNo} needs a human`, {
      messageId: row.id,
      excerpt: excerptOf(cleaned),
      classifier,
      suggested: suggestionFor(c, order.status, threshold, illegal),
    });
    await logAgent(tx, ref, "agent.reply_escalated", {
      messageId: row.id,
      kind: "reply_unclear",
      exceptionId,
      intent: c?.intent ?? null,
      confidence: c?.confidence ?? null,
    });
    bump((r) => (r.repliesEscalated += 1));
  });
}

// ---------------------------------------------------------------------------
// Replies with no order
// ---------------------------------------------------------------------------

async function unmatchedStep(ctx: Ctx, businessId: string, since: Date, outOfTime: () => boolean): Promise<void> {
  const replies = await getUnmatchedReplies({ id: SYSTEM_ACTOR_ID, role: "admin" }, { businessId, since });
  const people = replies.filter((r) => !r.noise && !r.suppressed && r.businessId === businessId);
  if (!people.length) return;

  const done = await withSystemContext((tx) =>
    tx
      .select({ messageId: sql<string>`${activityLog.metadata}->>'messageId'` })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.businessId, businessId),
          inArray(activityLog.action, [...HANDLED_ACTIONS]),
          sql`${activityLog.metadata}->>'messageId' in (${sql.join(
            people.map((p) => sql`${p.messageId}`),
            sql`, `,
          )})`,
        ),
      ),
  );
  const handled = new Set(done.map((d) => d.messageId));

  for (const r of people) {
    if (handled.has(r.messageId)) continue;
    if (outOfTime()) return;
    ctx.report.unmatchedChecked += 1;
    await perItem(ctx, { messageId: r.messageId }, async (tx, bump) => {
      if (await alreadyHandled(tx, businessId, r.messageId)) return;
      // The sender lookup behind `suggestion` is not business-scoped; keep only
      // candidates from this business.
      let candidates: { orderId: string; orderNumber: string; customerName: string; reason: string }[] = [];
      if (r.suggestion) {
        const [o] = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.id, r.suggestion.orderId), eq(orders.businessId, businessId)))
          .limit(1);
        if (o) candidates = [r.suggestion];
      }
      const ref = { businessId, orderId: null };
      const from = r.fromAddress ?? "unknown sender";
      const opened = await openExceptionTx(tx, {
        ...ref,
        kind: "unmatched_reply",
        summary: `Reply from ${from} matches no order`,
        detail: {
          messageId: r.messageId,
          from,
          subject: r.subject,
          excerpt: excerptOf(stripQuotedReplyText(r.body) || r.body),
          candidates,
        },
      });
      await logAgent(tx, ref, "agent.exception_opened", { exceptionId: opened.id, kind: "unmatched_reply" });
      await logAgent(tx, ref, "agent.reply_escalated", {
        messageId: r.messageId,
        kind: "unmatched_reply",
        exceptionId: opened.id,
      });
      bump((rep) => {
        rep.unmatchedEscalated += 1;
        rep.exceptionsOpened += 1;
        if (!rep.exceptionKinds.includes("unmatched_reply")) rep.exceptionKinds.push("unmatched_reply");
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Chasing silence: proof reminders
// ---------------------------------------------------------------------------

async function reminderStep(
  ctx: Ctx,
  businessId: string,
  afterHours: number,
  outOfTime: () => boolean,
): Promise<void> {
  const staleBefore = new Date(ctx.now.getTime() - afterHours * HOUR);
  const candidates = await withSystemContext(async (tx) => {
    const waiting = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.status, "awaiting_approval"), liveOrderWhere()))
      .orderBy(asc(orders.createdAt))
      .limit(BATCH);
    if (!waiting.length) return [];
    const latest = await tx
      .selectDistinctOn([proofs.orderId], {
        orderId: proofs.orderId,
        proofId: proofs.id,
        token: proofs.token,
        decision: proofs.decision,
        at: sql<Date>`coalesce(${proofs.sentAt}, ${proofs.createdAt})`.mapWith((v) => new Date(v as string)),
      })
      .from(proofs)
      .where(inArray(proofs.orderId, waiting.map((w) => w.id)))
      .orderBy(proofs.orderId, desc(proofs.createdAt));
    return latest.filter((p) => p.decision == null && p.at <= staleBefore);
  });

  for (const p of candidates) {
    if (outOfTime()) return;
    ctx.report.remindersChecked += 1;
    await perItem(ctx, { orderId: p.orderId }, async (tx, bump) => {
      const [order] = await tx
        .select({
          id: orders.id,
          businessId: orders.businessId,
          customerId: orders.customerId,
          status: orders.status,
          platformOrderId: orders.platformOrderId,
          platformOrderName: orders.platformOrderName,
        })
        .from(orders)
        .where(eq(orders.id, p.orderId))
        .for("update")
        .limit(1);
      if (!order || order.status !== "awaiting_approval") return;

      // The buyer said something since the proof: not silence.
      const [reply] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.orderId, order.id), eq(messages.direction, "inbound"), gt(messages.createdAt, p.at)))
        .limit(1);
      if (reply) return;

      // A reminder (the sweep's or ours) went out or is waiting in the outbox.
      const [recent] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.orderId, order.id),
            eq(messages.templateKey, "proof_reminder"),
            gte(messages.createdAt, new Date(ctx.now.getTime() - REMINDER_COOLDOWN_HOURS * HOUR)),
          ),
        )
        .limit(1);
      if (recent) return;

      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.orderId, order.id),
            eq(activityLog.action, "agent.proof_reminder_drafted"),
            sql`${activityLog.metadata}->>'proofId' = ${p.proofId}`,
          ),
        );
      if (n >= MAX_REMINDERS_PER_PROOF) return;

      const messageId = await queueStageEmail(tx, order, "proof_reminder", { proof_link: proofUrl(p.token) });
      if (!messageId) return; // no customer email: nothing to draft
      // Claim the reminder sweep's slot for this proof so it does not draft a second one.
      await tx
        .insert(reminderFires)
        .values({
          businessId: order.businessId,
          orderId: order.id,
          kind: "proof_reminder",
          subjectId: p.proofId,
          dedupeKey: `proof_reminder:${p.proofId}`,
          metadata: { by: "agent" },
        })
        .onConflictDoNothing({ target: reminderFires.dedupeKey });
      await logAgent(tx, { businessId: order.businessId, orderId: order.id }, "agent.proof_reminder_drafted", {
        proofId: p.proofId,
        messageId,
      });
      bump((r) => (r.remindersDrafted += 1));
    });
  }
}
