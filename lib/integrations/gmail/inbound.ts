import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { getBusinessGmailCredentials } from "@/lib/db/credentials";
import { activityLog, businesses, messages, notifications, users } from "@/lib/db/schema";
import { GmailClient } from "./client";
import { GmailReauthRequiredError } from "./errors";
import { extractPlainText, header } from "./mime";
import type { GmailCredentials, GmailHistoryMessage } from "./types";

export type InboundSummary = {
  businessId: string;
  attached: number;
  skipped: number;
  skippedRun?: "not_connected" | "needs_reauth";
};

const MAX_PAGES = 20; // safety bound on history pagination per run

/**
 * Trigger.dev-style polling job (callable now, scheduled later). Reads a
 * business's Gmail history since the stored cursor, attaches new INBOUND replies
 * to the matching order by gmail_thread_id, raises a VA notification, and drops
 * an entry on the order timeline. Idempotent by gmail_message_id, so re-running
 * over an overlapping history window never double-inserts.
 */
export async function pollMailbox(businessId: string): Promise<InboundSummary> {
  const base: InboundSummary = { businessId, attached: 0, skipped: 0 };

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

  // Dedupe ids, skip anything we sent (has the SENT label).
  const seen = new Set<string>();
  const summary = { ...base };
  for (const m of added) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.labelIds?.includes("SENT")) {
      summary.skipped++;
      continue;
    }
    const attached = await attachMessage(client, businessId, m.id, selfAddress);
    if (attached) summary.attached++;
    else summary.skipped++;
  }

  // Advance the cursor so the next run starts after what we processed.
  if (latestHistoryId !== start.biz.historyId) {
    await withSystemContext((tx) =>
      tx.update(businesses).set({ gmailHistoryId: latestHistoryId }).where(eq(businesses.id, businessId)),
    );
  }

  logInbound(businessId, { event: "poll_complete", attached: summary.attached, skipped: summary.skipped });
  return summary;
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

/**
 * Fetch one inbound message and, if it belongs to a known thread, persist it and
 * notify. Returns true when a new inbound row was created.
 */
async function attachMessage(
  client: GmailClient,
  businessId: string,
  gmailMessageId: string,
  selfAddress: string,
): Promise<boolean> {
  const msg = await client.getMessage(gmailMessageId);
  const from = (header(msg, "From") ?? "").toLowerCase();
  // Skip our own sends that slipped through without a SENT label.
  if (selfAddress && from.includes(selfAddress)) return false;

  return withSystemContext(async (tx) => {
    // Idempotency: never insert the same Gmail message twice.
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.gmailMessageId, gmailMessageId))
      .limit(1);
    if (existing) return false;

    // Match the reply to an order by the thread we originally sent on.
    const [threadMatch] = await tx
      .select({ orderId: messages.orderId, customerId: messages.customerId })
      .from(messages)
      .where(and(eq(messages.gmailThreadId, msg.threadId), isNotNull(messages.orderId)))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    const subject = header(msg, "Subject");
    const body = extractPlainText(msg);

    await tx.insert(messages).values({
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
      body,
    });

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
        })),
      );
    }

    logInbound(businessId, { event: "reply_attached", gmailMessageId, orderId: threadMatch?.orderId ?? null });
    return true;
  });
}

function logInbound(businessId: string, extra: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), integration: "gmail", businessId, ...extra }),
  );
}
