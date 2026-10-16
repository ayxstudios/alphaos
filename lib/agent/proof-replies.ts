// Proof replies (clean slating audit, 2026-10-16, deck item 4): a buyer who
// approves a proof by email, or asks for changes, is heard by AlphaOS whatever
// the business's inbox switch says.
//
// Why: the full inbox pass (./inbox.ts) only runs for businesses with
// agentInboxEnabled, and on 2026-10-16 that was PixArt alone. On CPS, Emily Page
// 4199506964 ("absolutely perfect ... I love it!!") and Megan Coakley
// 4197002875 approved by email and their orders sat in awaiting_approval with
// reminders still going; Megan Six 4201085914's approval was classified at 97%
// and never applied; Shelby Leachet 4199624202 asked for changes and was asked
// to approve 45 min later.
//
// This pass is deliberately narrow, so it is safe on every business:
//   - only orders in awaiting_approval whose latest proof is undecided;
//   - only buyer words written after that proof went out;
//   - a clear change request (at the business's confidence bar) wins over any
//     approval: the order goes back to design with her words as the reason;
//   - otherwise a clear approval approves the order;
//   - anything else (a question, a thank-you, below the bar) is left exactly
//     where it was: the classification is stored for the VA card, nothing is
//     drafted, sent or escalated here.
// Decisions go through applyReplyClassificationDecision, the same road a VA's
// tap and the inbox pass use, and are stamped agent.reply_applied so the inbox
// pass (if switched on later) never handles the same message twice. Any proof
// reminder still waiting on that order is withdrawn.

import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { SYSTEM_ACTOR_ID, withSystemContext, type Tx } from "@/lib/db";
import { activityLog, messages, orders, proofs } from "@/lib/db/schema";
import { anthropicFeaturesEnabled } from "@/lib/ai/anthropic";
import { applyReplyClassificationDecision, type ReplyDecision, type SystemReplyActor } from "@/lib/email/reply-decisions";
import { classifyProofReply, stripQuotedReplyText, type ReplyIntent } from "@/lib/email/reply-classifier";
import { mergeReplyClassification } from "@/lib/integrations/gmail/inbound";
import { buyerWordsWhere, withdrawProofReminder } from "@/lib/reminders/buyer-replied";
import { buyerOrdersForReply } from "./buyer-orders";
import { getAgentConfig } from "./config";
import { HANDLED_ACTIONS } from "./inbox";
import { agentOrderScope } from "./scope";

const SYSTEM: SystemReplyActor = { id: SYSTEM_ACTOR_ID, role: "system" };
const BATCH = 200;
/** Classifier calls per business per tick: the cron has a time budget, the rest wait a tick. */
const MAX_CLASSIFY_PER_TICK = 25;

export type ProofRepliesReport = {
  ordersChecked: number;
  classified: number;
  approvalsApplied: number;
  revisionsApplied: number;
  remindersWithdrawn: number;
  errors: { orderId?: string; messageId?: string; message: string }[];
};

export function emptyProofRepliesReport(): ProofRepliesReport {
  return { ordersChecked: 0, classified: 0, approvalsApplied: 0, revisionsApplied: 0, remindersWithdrawn: 0, errors: [] };
}

type Reply = {
  id: string;
  orderId: string;
  subject: string | null;
  body: string | null;
  metadata: unknown;
  createdAt: Date;
};

type Stored = { intent: ReplyIntent; confidence: number; strippedText: string };

function stored(metadata: unknown): Stored | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const c = (metadata as Record<string, unknown>).replyClassification;
  if (!c || typeof c !== "object") return null;
  const r = c as Record<string, unknown>;
  const intents: ReplyIntent[] = ["approval", "revision_request", "question", "unclear"];
  if (!intents.includes(r.intent as ReplyIntent) || typeof r.confidence !== "number") return null;
  return { intent: r.intent as ReplyIntent, confidence: r.confidence, strippedText: typeof r.strippedText === "string" ? r.strippedText : "" };
}

/**
 * The decision for one order from every buyer message after its proof, oldest
 * first. A clear change request anywhere wins (approving over "can you change
 * the hair" is the expensive mistake); else the latest clear approval.
 */
export function decideFromReplies(
  replies: { id: string; c: Stored | null }[],
  threshold: number,
): { decision: ReplyDecision; messageId: string } | null {
  const clear = replies.filter((r) => r.c && r.c.confidence >= threshold);
  const revision = clear.filter((r) => r.c!.intent === "revision_request").at(-1);
  if (revision) return { decision: "revision", messageId: revision.id };
  const approval = clear.filter((r) => r.c!.intent === "approval").at(-1);
  if (approval) return { decision: "approved", messageId: approval.id };
  return null;
}

class DryRunRollback extends Error {
  constructor() {
    super("proof replies dry run rollback");
  }
}

export async function runProofRepliesPass(
  business: { id: string; agentConfig?: unknown },
  opts: { dryRun?: boolean; outOfTime?: () => boolean } = {},
): Promise<ProofRepliesReport> {
  const report = emptyProofRepliesReport();
  const cfg = getAgentConfig(business);
  if (!cfg.proofReplyDecisions) return report;
  const outOfTime = opts.outOfTime ?? (() => false);
  const threshold = cfg.replyConfidenceThreshold;

  // Orders out for approval with an undecided latest proof and buyer words after it.
  const work = await withSystemContext(async (tx) => {
    const waiting = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, business.id),
          eq(orders.status, "awaiting_approval"),
          isNull(orders.archivedAt),
          agentOrderScope(),
        ),
      )
      .orderBy(asc(orders.createdAt))
      .limit(BATCH);
    if (!waiting.length) return [];
    const latest = await tx
      .selectDistinctOn([proofs.orderId], {
        orderId: proofs.orderId,
        decision: proofs.decision,
        at: sql<Date>`coalesce(${proofs.sentAt}, ${proofs.createdAt})`.mapWith((v) => new Date(v as string)),
      })
      .from(proofs)
      .where(inArray(proofs.orderId, waiting.map((w) => w.id)))
      .orderBy(proofs.orderId, desc(proofs.createdAt));
    const open = latest.filter((p) => p.decision == null);
    const out: { orderId: string; replies: Reply[] }[] = [];
    for (const p of open) {
      const replies = await tx
        .select({
          id: messages.id,
          orderId: sql<string>`${messages.orderId}`,
          subject: messages.subject,
          body: messages.body,
          metadata: messages.metadata,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.orderId, p.orderId),
            buyerWordsWhere(),
            isNull(messages.archivedAt),
            gt(messages.createdAt, p.at),
            // A VA already decided this reply from the suggestion card.
            sql`coalesce(${messages.metadata}->'replyClassification'->'vaDecision', 'null'::jsonb) = 'null'::jsonb`,
            sql`not exists (select 1 from ${activityLog} al where al.business_id = ${messages.businessId}
              and al.action in (${sql.join(HANDLED_ACTIONS.map((a) => sql`${a}`), sql`, `)})
              and al.metadata->>'messageId' = ${messages.id})`,
          ),
        )
        .orderBy(asc(messages.createdAt));
      if (replies.length) out.push({ orderId: p.orderId, replies });
    }
    return out;
  });

  let classifyBudget = MAX_CLASSIFY_PER_TICK;
  for (const item of work) {
    if (outOfTime()) break;
    report.ordersChecked += 1;

    // Network calls happen before the write transaction opens.
    const fresh = new Map<string, Awaited<ReturnType<typeof classifyProofReply>>>();
    const unclassified = item.replies.filter((r) => !stored(r.metadata));
    if (unclassified.length && anthropicFeaturesEnabled()) {
      const buyer = await buyerOrdersForReply(withSystemContext, item.orderId);
      for (const r of unclassified) {
        if (classifyBudget <= 0 || outOfTime()) break;
        classifyBudget -= 1;
        try {
          const c = await classifyProofReply({ subject: r.subject, body: r.body ?? "", buyerOrders: buyer?.block });
          if (c) fresh.set(r.id, c);
        } catch (e) {
          report.errors.push({ orderId: item.orderId, messageId: r.id, message: `classify: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    }

    const pending: ((r: ProofRepliesReport) => void)[] = [];
    try {
      await withSystemContext(async (tx) => {
        await applyForOrder(tx, item, fresh, threshold, (f) => pending.push(f));
        if (opts.dryRun) throw new DryRunRollback();
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) {
        report.errors.push({ orderId: item.orderId, message: e instanceof Error ? e.message : String(e) });
        continue;
      }
    }
    for (const f of pending) f(report);
  }
  return report;
}

async function applyForOrder(
  tx: Tx,
  item: { orderId: string; replies: Reply[] },
  fresh: Map<string, Awaited<ReturnType<typeof classifyProofReply>>>,
  threshold: number,
  bump: (f: (r: ProofRepliesReport) => void) => void,
): Promise<void> {
  const [order] = await tx
    .select({ id: orders.id, businessId: orders.businessId, status: orders.status })
    .from(orders)
    .where(eq(orders.id, item.orderId))
    .for("update")
    .limit(1);
  if (!order || order.status !== "awaiting_approval") return;

  const judged: { id: string; c: Stored | null }[] = [];
  for (const r of item.replies) {
    let c = stored(r.metadata);
    const f = fresh.get(r.id);
    if (!c && f) {
      const [msg] = await tx.select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, r.id)).for("update").limit(1);
      if (msg && !stored(msg.metadata)) {
        await tx.update(messages).set({ metadata: mergeReplyClassification(msg.metadata, f) }).where(eq(messages.id, r.id));
        await tx.insert(activityLog).values({
          businessId: order.businessId,
          orderId: order.id,
          actorId: null,
          action: "message.reply_classified",
          metadata: {
            messageId: r.id,
            via: "agent_proof_replies",
            classification: { model: f.model, intent: f.intent, confidence: f.confidence, rationale: f.rationale },
          },
        });
        bump((rep) => (rep.classified += 1));
      }
      c = { intent: f.intent, confidence: f.confidence, strippedText: f.strippedText };
    }
    judged.push({ id: r.id, c });
  }

  const pick = decideFromReplies(judged, threshold);
  if (!pick) return;
  const chosen = item.replies.find((r) => r.id === pick.messageId)!;
  const c = judged.find((j) => j.id === pick.messageId)!.c!;
  const words = c.strippedText || stripQuotedReplyText(chosen.body ?? "") || (chosen.body ?? "").trim();
  // Savepoint: a refused transition leaves the outer transaction usable.
  const res = await tx.transaction((sp) =>
    applyReplyClassificationDecision(sp, SYSTEM, pick.messageId, pick.decision, {
      via: "agent_proof_replies",
      revisionReason: pick.decision === "revision" ? words : undefined,
    }),
  );
  if (!res.ok) {
    // Keep the stored classifications (no re-classify next tick); the order is left as it was.
    bump((rep) => rep.errors.push({ orderId: order.id, messageId: pick.messageId, message: res.message }));
    return;
  }

  // Every buyer message on this proof is now handled: the inbox pass, if it is
  // switched on later, must not read a superseded approval and raise a card.
  for (const r of item.replies) {
    const j = judged.find((x) => x.id === r.id)!;
    await tx.insert(activityLog).values({
      businessId: order.businessId,
      orderId: order.id,
      actorId: null,
      action: "agent.reply_applied",
      metadata: {
        messageId: r.id,
        via: "agent_proof_replies",
        intent: j.c?.intent ?? null,
        confidence: j.c?.confidence ?? null,
        decision: r.id === pick.messageId ? pick.decision : "covered",
        decidedBy: pick.messageId,
      },
    });
  }
  bump((rep) => {
    if (pick.decision === "approved") rep.approvalsApplied += 1;
    else rep.revisionsApplied += 1;
  });

  // A reminder drafted or queued before she answered never goes out now.
  const reminders = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.orderId, order.id),
        eq(messages.direction, "outbound"),
        eq(messages.templateKey, "proof_reminder"),
        inArray(messages.status, ["draft", "queued", "failed"]),
        isNull(messages.archivedAt),
      ),
    );
  for (const m of reminders) {
    const reason = pick.decision === "approved" ? "the buyer approved by email" : "the buyer asked for changes by email";
    if (await withdrawProofReminder(tx, { id: m.id, businessId: order.businessId, orderId: order.id }, reason)) {
      bump((rep) => (rep.remindersWithdrawn += 1));
    }
  }
}
