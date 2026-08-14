import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { anthropicFeaturesEnabled } from "@/lib/ai/anthropic";
import { withSystemContext } from "@/lib/db";
import { getBusinessGmailCredentials } from "@/lib/db/credentials";
import { activityLog, businesses, notificationFires, notifications, messages, orders, users } from "@/lib/db/schema";
import { classifyProofReply, type ReplyClassification } from "@/lib/email/reply-classifier";
import { resolveSuppressionReason } from "@/lib/email/suppression";
import { GmailClient } from "./client";
import { GmailApiError, GmailReauthRequiredError } from "./errors";
import { extractPlainText, header } from "./mime";
import type { GmailCredentials, GmailHistoryMessage } from "./types";

export type InboundSummary = {
  businessId: string;
  attached: number;
  skipped: number;
  fetched: number;
  skippedReasons: {
    sent: number;
    draft: number;
    duplicateOrSelf: number;
    notFound: number;
    fetchError: number;
  };
  skippedRun?: "not_connected" | "needs_reauth";
};

const MAX_PAGES = 20; // safety bound on history pagination per run
type GmailMessageReader = Pick<GmailClient, "getMessage">;

/**
 * Gmail polling job (called manually or by Vercel Cron). Reads a
 * business's Gmail history since the stored cursor, attaches new INBOUND replies
 * to the matching order by gmail_thread_id, raises a VA notification, and drops
 * an entry on the order timeline. Idempotent by gmail_message_id, so re-running
 * over an overlapping history window never double-inserts.
 */
export async function pollMailbox(businessId: string): Promise<InboundSummary> {
  const base: InboundSummary = {
    businessId,
    attached: 0,
    skipped: 0,
    fetched: 0,
    skippedReasons: {
      sent: 0,
      draft: 0,
      duplicateOrSelf: 0,
      notFound: 0,
      fetchError: 0,
    },
  };

  const start = await withSystemContext(async (tx) => {
    const [biz] = await tx
      .select({ historyId: businesses.gmailHistoryId, address: businesses.gmailAddress })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    const creds = (await getBusinessGmailCredentials(tx, businessId)) as GmailCredentials | null;
    return { biz, creds };
  });

  if (!start.creds || !start.biz?.historyId) return { ...base, skippedRun: "not_connected" };
  if (start.creds.status === "needs_reauth") return { ...base, skippedRun: "needs_reauth" };

  const selfAddress = (start.biz.address ?? start.creds.address ?? "").toLowerCase();
  let client: GmailClient;
  try {
    client = await GmailClient.forBusiness(businessId);
  } catch {
    return { ...base, skippedRun: "not_connected" };
  }

  // Collect newly-added message ids across the history window.
  const added: GmailHistoryMessage[] = [];
  let latestHistoryId = start.biz.historyId;
  try {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.listHistory(start.biz.historyId, pageToken);
      if (res.historyId) latestHistoryId = res.historyId;
      for (const h of res.history ?? []) {
        for (const m of h.messagesAdded ?? []) added.push(m.message);
      }
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
  } catch (err) {
    if (err instanceof GmailReauthRequiredError) return { ...base, skippedRun: "needs_reauth" };
    throw err;
  }

  const summary = await processHistoryMessages({ client, businessId, historyMessages: added, selfAddress });

  // Advance the cursor so the next run starts after what we processed, and stamp
  // the poll time (drives cron ordering + the dashboard mailbox health).
  await withSystemContext((tx) =>
    tx
      .update(businesses)
      .set({
        gmailLastPolledAt: new Date(),
        ...(latestHistoryId !== start.biz.historyId ? { gmailHistoryId: latestHistoryId } : {}),
      })
      .where(eq(businesses.id, businessId)),
  );

  logInbound(businessId, {
    event: "poll_complete",
    historyStart: start.biz.historyId,
    historyEnd: latestHistoryId,
    historyMessagesAdded: added.length,
    fetched: summary.fetched,
    attached: summary.attached,
    skipped: summary.skipped,
    skippedReasons: summary.skippedReasons,
  });
  return summary;
}

export async function processHistoryMessages(args: {
  client: GmailMessageReader;
  businessId: string;
  historyMessages: GmailHistoryMessage[];
  selfAddress: string;
}): Promise<InboundSummary> {
  const summary: InboundSummary = {
    businessId: args.businessId,
    attached: 0,
    skipped: 0,
    fetched: 0,
    skippedReasons: {
      sent: 0,
      draft: 0,
      duplicateOrSelf: 0,
      notFound: 0,
      fetchError: 0,
    },
  };
  const seen = new Set<string>();
  for (const m of args.historyMessages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.labelIds?.includes("DRAFT")) {
      summary.skipped++;
      summary.skippedReasons.draft++;
      continue;
    }
    if (m.labelIds?.includes("SENT")) {
      summary.skipped++;
      summary.skippedReasons.sent++;
      continue;
    }
    summary.fetched++;
    try {
      const attached = await attachMessage(args.client, args.businessId, m.id, args.selfAddress);
      if (attached) summary.attached++;
      else {
        summary.skipped++;
        summary.skippedReasons.duplicateOrSelf++;
      }
    } catch (err) {
      summary.skipped++;
      if (err instanceof GmailApiError && err.status === 404) {
        summary.skippedReasons.notFound++;
      } else {
        summary.skippedReasons.fetchError++;
        logInbound(args.businessId, {
          level: "error",
          event: "message_fetch_failed",
          gmailMessageId: m.id,
          threadId: m.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return summary;
}

export type PollBatchResult = {
  budgetMs: number;
  processed: number;
  skippedOverBudget: number;
  attached: number;
  mailboxes: {
    businessId: string;
    attached: number;
    skipped: number;
    fetched: number;
    skippedReasons: InboundSummary["skippedReasons"];
    skippedRun?: string;
  }[];
  stalls: GmailMailboxStall[];
};

/**
 * Cron entry point: poll every connected mailbox, least-recently-polled first,
 * bounded by a wall-clock budget so 14 mailboxes never risk the function
 * timeout. Whatever a run doesn't reach stays oldest and is picked up next tick
 * (batch-and-resume, mirroring syncAllShops).
 */
export async function pollMailboxesScheduled(opts: { budgetMs?: number } = {}): Promise<PollBatchResult> {
  const budgetMs = opts.budgetMs ?? 50_000;
  const rows = await withSystemContext((tx) =>
    tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(and(isNotNull(businesses.gmailHistoryId), isNotNull(businesses.gmailCredentials)))
      .orderBy(sql`${businesses.gmailLastPolledAt} asc nulls first`),
  );

  const start = Date.now();
  const result: PollBatchResult = { budgetMs, processed: 0, skippedOverBudget: 0, attached: 0, mailboxes: [], stalls: [] };
  for (const r of rows) {
    if (Date.now() - start > budgetMs) {
      result.skippedOverBudget++;
      continue;
    }
    try {
      const s = await pollMailbox(r.id);
      result.processed++;
      result.attached += s.attached;
      result.mailboxes.push({
        businessId: r.id,
        attached: s.attached,
        skipped: s.skipped,
        fetched: s.fetched,
        skippedReasons: s.skippedReasons,
        skippedRun: s.skippedRun,
      });
    } catch (err) {
      logInbound(r.id, { level: "error", event: "poll_failed", error: String(err) });
      result.mailboxes.push({
        businessId: r.id,
        attached: 0,
        skipped: 0,
        fetched: 0,
        skippedReasons: { sent: 0, draft: 0, duplicateOrSelf: 0, notFound: 0, fetchError: 0 },
        skippedRun: "error",
      });
    }
  }
  result.stalls = await detectGmailMailboxStalls({ notifyAdmins: true });
  return result;
}

/** Poll every business that has a connected Gmail mailbox. */
export async function pollAllMailboxes(): Promise<InboundSummary[]> {
  const rows = await withSystemContext((tx) =>
    tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(and(isNotNull(businesses.gmailHistoryId), isNotNull(businesses.gmailCredentials))),
  );
  const out: InboundSummary[] = [];
  for (const r of rows) {
    try {
      out.push(await pollMailbox(r.id));
    } catch (err) {
      logInbound(r.id, { level: "error", event: "poll_failed", error: String(err) });
    }
  }
  return out;
}

export type GmailMailboxStall = {
  businessId: string;
  businessName: string;
  gmailAddress: string | null;
  dbHistoryId: string;
  gmailHistoryId: string;
  lastPolledAt: string | null;
  ageHours: number | null;
};

export async function detectGmailMailboxStalls(opts: { notifyAdmins?: boolean; businessId?: string } = {}): Promise<GmailMailboxStall[]> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const candidates = await withSystemContext((tx) =>
    tx
      .select({
        id: businesses.id,
        name: businesses.name,
        gmailAddress: businesses.gmailAddress,
        historyId: businesses.gmailHistoryId,
        lastPolledAt: businesses.gmailLastPolledAt,
      })
      .from(businesses)
      .where(
        and(
          isNotNull(businesses.gmailHistoryId),
          isNotNull(businesses.gmailCredentials),
          ...(opts.businessId ? [eq(businesses.id, opts.businessId)] : []),
          sql`(${businesses.gmailLastPolledAt} is null or ${businesses.gmailLastPolledAt} < ${cutoff})`,
        ),
      ),
  );

  const stalls: GmailMailboxStall[] = [];
  for (const candidate of candidates) {
    if (!candidate.historyId) continue;
    try {
      const client = await GmailClient.forBusiness(candidate.id);
      const profile = await client.getProfile();
      if (profile.historyId === candidate.historyId) continue;
      const ageHours = candidate.lastPolledAt
        ? Math.round(((Date.now() - candidate.lastPolledAt.getTime()) / 3_600_000) * 10) / 10
        : null;
      stalls.push({
        businessId: candidate.id,
        businessName: candidate.name,
        gmailAddress: candidate.gmailAddress,
        dbHistoryId: candidate.historyId,
        gmailHistoryId: profile.historyId,
        lastPolledAt: candidate.lastPolledAt?.toISOString() ?? null,
        ageHours,
      });
    } catch (err) {
      logInbound(candidate.id, {
        level: "error",
        event: "stall_check_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (opts.notifyAdmins && stalls.length) {
    await notifyMailboxStalls(stalls);
  }
  return stalls;
}

async function notifyMailboxStalls(stalls: GmailMailboxStall[]): Promise<void> {
  const windowKey = new Date().toISOString().slice(0, 13);
  await withSystemContext(async (tx) => {
    const admins = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.active, true)));
    if (!admins.length) return;

    for (const stall of stalls) {
      const dedupeKey = `gmail_mailbox_stalled:${stall.businessId}:${windowKey}`;
      const [fire] = await tx
        .insert(notificationFires)
        .values({
          businessId: stall.businessId,
          alertType: "gmail.mailbox_stalled",
          subjectType: "business",
          subjectId: stall.businessId,
          dedupeKey,
          metadata: stall,
        })
        .onConflictDoNothing({ target: notificationFires.dedupeKey })
        .returning({ id: notificationFires.id });
      if (!fire) continue;

      await tx.insert(notifications).values(
        admins.map((admin) => ({
          businessId: stall.businessId,
          userId: admin.id,
          type: "gmail.mailbox_stalled",
          fireId: fire.id,
          title: "Gmail poller is stalled",
          body: `${stall.businessName} has newer Gmail history but has not advanced its cursor for ${stall.ageHours ?? "unknown"}h.`,
          href: "/health",
          metadata: stall,
        })),
      );
    }
  });
}

/**
 * Fetch one inbound message and, if it belongs to a known thread, persist it and
 * notify. Returns true when a new inbound row was created.
 */
type AttachedMessage = {
  messageId: string;
  orderId: string | null;
  businessId: string;
  orderStatus: string | null;
  subject: string | null;
  body: string;
  suppressed: boolean;
};

async function attachMessage(
  client: GmailMessageReader,
  businessId: string,
  gmailMessageId: string,
  selfAddress: string,
): Promise<boolean> {
  const msg = await client.getMessage(gmailMessageId);
  const from = (header(msg, "From") ?? "").toLowerCase();
  // Skip our own sends that slipped through without a SENT label.
  if (selfAddress && from.includes(selfAddress)) return false;

  const attached = await withSystemContext<AttachedMessage | null>(async (tx) => {
    // Idempotency: never insert the same Gmail message twice.
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.gmailMessageId, gmailMessageId))
      .limit(1);
    if (existing) return null;

    // Match the reply to an order by the thread we originally sent on.
    const [threadMatch] = await tx
      .select({ orderId: messages.orderId, customerId: messages.customerId, orderStatus: orders.status })
      .from(messages)
      .leftJoin(orders, eq(orders.id, messages.orderId))
      .where(and(eq(messages.gmailThreadId, msg.threadId), isNotNull(messages.orderId)))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    const subject = header(msg, "Subject");
    const rfcMessageId = header(msg, "Message-ID");
    const body = extractPlainText(msg);
    const suppression = await resolveSuppressionReason(tx, businessId, header(msg, "From"));

    const [inserted] = await tx.insert(messages).values({
      businessId,
      orderId: threadMatch?.orderId ?? null,
      customerId: threadMatch?.customerId ?? null,
      direction: "inbound",
      channel: "email",
      status: "received",
      subject,
      address: header(msg, "From"),
      gmailThreadId: msg.threadId,
      gmailMessageId,
      gmailRfcMessageId: rfcMessageId,
      body,
      ...(suppression
        ? { suppressedAt: new Date(), suppressedReason: suppression }
        : {}),
    }).returning({ id: messages.id });

    // Timeline entry (only when we could tie it to an order).
    if (threadMatch?.orderId) {
      await tx.insert(activityLog).values({
        businessId,
        orderId: threadMatch.orderId,
        actorId: null, // customer, no internal user
        action: "message.received",
        metadata: { channel: "email", subject, gmailThreadId: msg.threadId },
      });
    }

    // Raise a notification for every VA + admin so a reply gets triaged.
    // Suppressed mail is still stored, but it stays quiet unless a VA views it.
    if (!suppression) {
      const staff = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.role, ["admin", "va"]), eq(users.active, true)));
      if (staff.length) {
        await tx.insert(notifications).values(
          staff.map((s) => ({
            businessId,
            userId: s.id,
            type: "message.received",
            orderId: threadMatch?.orderId ?? null,
            href: threadMatch?.orderId ? `/orders/${threadMatch.orderId}` : "/emails",
          })),
        );
      }
    }

    logInbound(businessId, {
      event: "reply_attached",
      gmailMessageId,
      orderId: threadMatch?.orderId ?? null,
      suppressed: !!suppression,
    });
    return {
      messageId: inserted.id,
      orderId: threadMatch?.orderId ?? null,
      businessId,
      orderStatus: threadMatch?.orderStatus ?? null,
      subject,
      body,
      suppressed: !!suppression,
    };
  });
  if (!attached) return false;
  if (!attached.suppressed && anthropicFeaturesEnabled() && attached.orderId && attached.orderStatus === "awaiting_approval") {
    await classifyAndStoreReply(attached);
  }
  return true;
}

async function classifyAndStoreReply(attached: AttachedMessage): Promise<void> {
  const classification = await classifyProofReply({ subject: attached.subject, body: attached.body });
  if (!classification) {
    logInbound(attached.businessId, { event: "reply_classification_unavailable", messageId: attached.messageId });
    return;
  }

  await withSystemContext(async (tx) => {
    const [current] = await tx
      .select({ metadata: messages.metadata, orderId: messages.orderId })
      .from(messages)
      .where(eq(messages.id, attached.messageId))
      .limit(1);
    if (!current) return;
    const metadata = mergeReplyClassification(current.metadata, classification);
    await tx.update(messages).set({ metadata }).where(eq(messages.id, attached.messageId));
    await tx.insert(activityLog).values({
      businessId: attached.businessId,
      orderId: attached.orderId,
      actorId: null,
      action: "message.reply_classified",
      metadata: {
        messageId: attached.messageId,
        classification: metadata.replyClassification,
      },
    });

    if (classification.intent === "approval" || classification.intent === "revision_request") {
      const staff = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.role, ["admin", "va"]), eq(users.active, true)));
      if (staff.length) {
        const title =
          classification.intent === "approval"
            ? "Reply may approve this proof"
            : "Reply may request a revision";
        const body =
          classification.intent === "approval"
            ? "Review the customer reply and confirm whether to mark the order approved."
            : "Review the customer reply and confirm whether to send the order back to design.";
        await tx.insert(notifications).values(
          staff.map((s) => ({
            businessId: attached.businessId,
            userId: s.id,
            type: "message.reply_suggestion",
            orderId: attached.orderId,
            title,
            body,
            href: `/orders/${attached.orderId}`,
            metadata: { messageId: attached.messageId, intent: classification.intent },
          })),
        );
      }
    }
  });
  logInbound(attached.businessId, {
    event: "reply_classified",
    messageId: attached.messageId,
    intent: classification.intent,
    confidence: classification.confidence,
  });
}

function mergeReplyClassification(metadata: unknown, classification: ReplyClassification) {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
  return {
    ...base,
    replyClassification: {
      model: classification.model,
      intent: classification.intent,
      confidence: classification.confidence,
      rationale: classification.rationale,
      strippedText: classification.strippedText,
      classifiedAt: new Date().toISOString(),
    },
  };
}

function logInbound(businessId: string, extra: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), integration: "gmail", businessId, ...extra }),
  );
}
