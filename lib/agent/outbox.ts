// Agent outbox pass, run by the autopilot tick after the other steps. The
// agent's mail goes out by itself (no draft waiting for a VA) when the
// business's agentConfig.autoSendReplies is on (default ON):
//   promote  agent-written drafts (answers to buyer questions, photo
//            shortfall requests, proof reminders) become `queued`;
//   send     every queued email of the business is sent through the normal
//            send path (sendMessage), so sent agent mail stays in the mail
//            history exactly like any other sent email;
//   retry    a `failed` email is retried up to MAX_RETRIES times with
//            backoff; when the last retry fails the agent opens an
//            "Email failed to send" exception instead of leaving a red chip.
// Never auto-sent: anything a human wrote or approved, and answers to buyers
// who are asking about refunds, quotes, cancellations or disputes (those stay
// drafts). Unclear and unmatched replies never produce mail at all; they are
// exceptions. A dry run reads and counts, sends and writes nothing.

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { activityLog, exceptions, messages, orders } from "@/lib/db/schema";
import { sendMessage } from "@/lib/email/dispatch";

import { openExceptionTx } from "./exceptions";

/** Retries after the first failure. */
export const MAX_SEND_RETRIES = 3;
/** Wait before retry n+1 once retry n has failed (retry 1 is due at once). */
export const RETRY_BACKOFF_MINUTES = [15, 60] as const;
/** Templates the agent writes itself; their drafts are the agent's to send. */
const AGENT_TEMPLATES = ["photo_shortfall", "proof_reminder"] as const;
/** A buyer asking about these gets a human, never an automatic answer. */
const SENSITIVE = /\b(refund|money back|charge ?back|dispute|cancel(?:l?ation)?|quote|price|pricing|compensat\w*|legal|lawyer|complain\w*)\b/i;
const FINISHED = ["delivered", "complete", "cancelled"] as const;
const BATCH = 100;
const MINUTE = 60 * 1000;
/** Errors no retry can fix; the exception is raised straight away. */
const HARD_ERROR = /no recipient address|attachment asset is missing/i;

/**
 * agentConfig.autoSendReplies, default true. The key is read straight off the
 * jsonb bag (the typed getter in ./config.ts does not know it yet), so a
 * business only turns it off by saving an explicit false.
 */
export function autoSendRepliesOn(agentConfig: unknown): boolean {
  if (!agentConfig || typeof agentConfig !== "object" || Array.isArray(agentConfig)) return true;
  return (agentConfig as Record<string, unknown>).autoSendReplies !== false;
}

export type OutboxReport = {
  /** Agent drafts moved to the send queue this pass. */
  promoted: number;
  /** Agent drafts left for a human (sensitive topic, order already finished). */
  heldForHuman: number;
  sent: number;
  /** Not sent and not failed: sending is off or the mailbox is not connected. */
  deferred: number;
  /** Failed sends retried this pass (of which `retried` succeeded is in `sent`). */
  retried: number;
  /** Failed emails that ran out of retries and became an exception. */
  exceptionsOpened: number;
  /** Open "Email failed to send" exceptions closed because the email went out. */
  exceptionsResolved: number;
  errors: { messageId?: string; message: string }[];
};

export function emptyOutboxReport(): OutboxReport {
  return { promoted: 0, heldForHuman: 0, sent: 0, deferred: 0, retried: 0, exceptionsOpened: 0, exceptionsResolved: 0, errors: [] };
}

export type OutboxPassOptions = { dryRun?: boolean; now?: Date; outOfTime?: () => boolean };

type SendRetry = { attempts: number; nextAt: string | null; lastError?: string; exceptionId?: string };

function readRetry(metadata: unknown): SendRetry {
  const m = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  const r = m.sendRetry && typeof m.sendRetry === "object" ? (m.sendRetry as Record<string, unknown>) : {};
  return {
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    nextAt: typeof r.nextAt === "string" ? r.nextAt : null,
    lastError: typeof r.lastError === "string" ? r.lastError : undefined,
    exceptionId: typeof r.exceptionId === "string" ? r.exceptionId : undefined,
  };
}

async function writeRetry(messageId: string, retry: SendRetry): Promise<void> {
  await withSystemContext((tx) =>
    tx
      .update(messages)
      .set({ metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ sendRetry: retry })}::jsonb` })
      .where(eq(messages.id, messageId)),
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runOutboxPass(
  business: { id: string; name: string; agentConfig?: unknown },
  opts: OutboxPassOptions = {},
): Promise<OutboxReport> {
  const report = emptyOutboxReport();
  const now = opts.now ?? new Date();
  const dryRun = !!opts.dryRun;
  const outOfTime = opts.outOfTime ?? (() => false);
  const autoSend = autoSendRepliesOn(business.agentConfig);

  try {
    if (!dryRun) await resolveSentFailures(business.id, report);
    if (autoSend && !outOfTime()) await promoteStep(business.id, dryRun, report);
    if (autoSend && !outOfTime()) await sendStep(business.id, dryRun, now, report, outOfTime);
    if (!outOfTime()) await retryStep(business, dryRun, now, report, outOfTime);
  } catch (e) {
    report.errors.push({ message: errorMessage(e) });
  }
  return report;
}

// ---------------------------------------------------------------------------
// promote: agent drafts -> queued
// ---------------------------------------------------------------------------

async function promoteStep(businessId: string, dryRun: boolean, report: OutboxReport): Promise<void> {
  const drafts = await withSystemContext((tx) =>
    tx
      .select({
        id: messages.id,
        templateKey: messages.templateKey,
        metadata: messages.metadata,
        orderStatus: orders.status,
        inboundBody: sql<string | null>`(select i.body from messages i where i.id::text = ${messages.metadata}->>'replyToMessageId')`,
      })
      .from(messages)
      .leftJoin(orders, eq(orders.id, messages.orderId))
      .where(
        and(
          eq(messages.businessId, businessId),
          eq(messages.direction, "outbound"),
          eq(messages.status, "draft"),
          isNull(messages.archivedAt),
          sql`(${messages.metadata}->>'agentDrafted' = 'true' or ${messages.templateKey} in (${sql.join(
            AGENT_TEMPLATES.map((k) => sql`${k}`),
            sql`, `,
          )}))`,
          // Set when turning sending on marked this stale email as skipped.
          sql`${messages.metadata}->'skippedOnEnable' is null`,
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(BATCH),
  );

  const go: string[] = [];
  for (const d of drafts) {
    const finished = d.orderStatus && (FINISHED as readonly string[]).includes(d.orderStatus);
    const staleReminder = d.templateKey === "proof_reminder" && d.orderStatus !== "awaiting_approval";
    const sensitive = !!d.inboundBody && SENSITIVE.test(d.inboundBody);
    if (finished || staleReminder || sensitive) {
      report.heldForHuman += 1;
      continue;
    }
    go.push(d.id);
  }
  if (!go.length) return;
  report.promoted += go.length;
  if (dryRun) return;
  await withSystemContext(async (tx) => {
    await tx
      .update(messages)
      .set({ status: "queued", metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || '{"autoSent": true}'::jsonb` })
      .where(and(inArray(messages.id, go), eq(messages.status, "draft")));
    await tx.insert(activityLog).values({
      businessId,
      orderId: null,
      actorId: null,
      action: "agent.emails_auto_queued",
      metadata: { count: go.length, messageIds: go },
    });
  });
}

// ---------------------------------------------------------------------------
// send: every queued email of the business
// ---------------------------------------------------------------------------

async function sendStep(
  businessId: string,
  dryRun: boolean,
  now: Date,
  report: OutboxReport,
  outOfTime: () => boolean,
): Promise<void> {
  const rows = await withSystemContext((tx) =>
    tx
      .select({ id: messages.id, metadata: messages.metadata })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), eq(messages.direction, "outbound"), eq(messages.status, "queued"), isNull(messages.archivedAt)))
      .orderBy(asc(messages.createdAt))
      .limit(BATCH),
  );
  // A dry run cannot know which sends would work; it reports what is waiting.
  if (dryRun) {
    report.sent += rows.length;
    return;
  }
  for (const r of rows) {
    if (outOfTime()) return;
    let res: Awaited<ReturnType<typeof sendMessage>>;
    try {
      res = await sendMessage(r.id);
    } catch (e) {
      // sendMessage throws for an unexpected fault; count it like a hard failure.
      const error = errorMessage(e);
      await withSystemContext((tx) => tx.update(messages).set({ status: "failed", error }).where(eq(messages.id, r.id)));
      res = { ok: false, error, retryable: false };
    }
    if (res.ok) report.sent += 1;
    else if (res.retryable) report.deferred += 1;
    else {
      // First failure: the retry policy starts from here.
      await writeRetry(r.id, { attempts: 0, nextAt: now.toISOString(), lastError: res.error });
      report.errors.push({ messageId: r.id, message: res.error });
    }
  }
}

// ---------------------------------------------------------------------------
// retry: failed emails, then the exception
// ---------------------------------------------------------------------------

async function retryStep(
  business: { id: string; name: string },
  dryRun: boolean,
  now: Date,
  report: OutboxReport,
  outOfTime: () => boolean,
): Promise<void> {
  const rows = await withSystemContext((tx) =>
    tx
      .select({
        id: messages.id,
        orderId: messages.orderId,
        subject: messages.subject,
        address: messages.address,
        error: messages.error,
        metadata: messages.metadata,
        orderNumber: sql<string | null>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
      })
      .from(messages)
      .leftJoin(orders, eq(orders.id, messages.orderId))
      .where(
        and(
          eq(messages.businessId, business.id),
          eq(messages.direction, "outbound"),
          eq(messages.status, "failed"),
          isNull(messages.archivedAt),
          sql`${messages.manualSentAt} is null`,
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(BATCH),
  );

  for (const m of rows) {
    if (outOfTime()) return;
    const retry = readRetry(m.metadata);
    if (retry.exceptionId) continue; // already handed to a human
    const hard = HARD_ERROR.test(m.error ?? "");
    const exhausted = retry.attempts >= MAX_SEND_RETRIES;
    if (!hard && !exhausted) {
      if (retry.nextAt && new Date(retry.nextAt) > now) continue; // backing off
      report.retried += 1;
      if (dryRun) continue;
      let res: Awaited<ReturnType<typeof sendMessage>>;
      try {
        res = await sendMessage(m.id, { markRetryableFailed: true });
      } catch (e) {
        res = { ok: false, error: errorMessage(e), retryable: false };
      }
      if (res.ok) {
        report.sent += 1;
        await withSystemContext((tx) =>
          tx.insert(activityLog).values({
            businessId: business.id,
            orderId: m.orderId,
            actorId: null,
            action: "agent.email_retry_sent",
            metadata: { messageId: m.id, attempts: retry.attempts + 1 },
          }),
        );
        continue;
      }
      // Sending switched off is a setting, not a fault: keep the email failed, burn no retry.
      if (/turned off/i.test(res.error)) {
        report.retried -= 1;
        report.deferred += 1;
        continue;
      }
      const attempts = retry.attempts + 1;
      if (attempts < MAX_SEND_RETRIES) {
        const wait = RETRY_BACKOFF_MINUTES[Math.min(attempts - 1, RETRY_BACKOFF_MINUTES.length - 1)];
        await writeRetry(m.id, { attempts, nextAt: new Date(now.getTime() + wait * MINUTE).toISOString(), lastError: res.error });
        continue;
      }
      await raiseFailed(business, m, { attempts, nextAt: null, lastError: res.error }, res.error, report);
      continue;
    }
    // Out of retries (or a fault no retry fixes): a human gets a card.
    if (dryRun) {
      report.exceptionsOpened += 1;
      continue;
    }
    await raiseFailed(business, m, { ...retry, attempts: retry.attempts }, m.error ?? "Unknown error", report);
  }
}

async function raiseFailed(
  business: { id: string },
  m: { id: string; orderId: string | null; subject: string | null; address: string | null; orderNumber: string | null },
  retry: SendRetry,
  error: string,
  report: OutboxReport,
): Promise<void> {
  const to = m.address ?? "the customer";
  await withSystemContext(async (tx) => {
    const opened = await openExceptionTx(tx, {
      businessId: business.id,
      orderId: m.orderId,
      kind: "email_send_failed",
      summary: `Email failed to send${m.orderNumber ? ` (order ${m.orderNumber})` : ""}`,
      detail: {
        messageId: m.id,
        subject: m.subject,
        to,
        error,
        retries: retry.attempts,
        suggested: "Fix the cause (mailbox connection or address), then retry the send from the Messages screen, or send it by hand and mark it sent.",
      },
    });
    await tx
      .update(messages)
      .set({ metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ sendRetry: { ...retry, exceptionId: opened.id } })}::jsonb` })
      .where(eq(messages.id, m.id));
    if (opened.created) {
      await tx.insert(activityLog).values({
        businessId: business.id,
        orderId: m.orderId,
        actorId: null,
        action: "agent.exception_opened",
        metadata: { exceptionId: opened.id, kind: "email_send_failed", messageId: m.id },
      });
      report.exceptionsOpened += 1;
    }
  });
}

/** An email that went out after its exception was raised (a human retried it) closes the card. */
async function resolveSentFailures(businessId: string, report: OutboxReport): Promise<void> {
  const rows = await withSystemContext((tx) =>
    tx
      .update(exceptions)
      .set({ status: "resolved", resolvedAt: sql`now()`, resolutionNote: "The email was sent." })
      .where(
        and(
          eq(exceptions.businessId, businessId),
          eq(exceptions.kind, "email_send_failed"),
          eq(exceptions.status, "open"),
          sql`exists (select 1 from messages m where m.id::text = ${exceptions.detail}->>'messageId' and (m.status = 'sent' or m.manual_sent_at is not null or m.archived_at is not null))`,
        ),
      )
      .returning({ id: exceptions.id }),
  );
  report.exceptionsResolved += rows.length;
}
