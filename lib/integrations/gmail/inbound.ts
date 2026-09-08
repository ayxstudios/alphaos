import { randomUUID } from "node:crypto";

import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";

import { anthropicFeaturesEnabled } from "@/lib/ai/anthropic";
import { withSystemContext, type Tx } from "@/lib/db";
import { getBusinessGmailCredentials } from "@/lib/db/credentials";
import {
  activityLog,
  businesses,
  customers,
  notificationFires,
  notifications,
  messages,
  orders,
  shops,
  users,
} from "@/lib/db/schema";
import { classifyProofReply, type ReplyClassification } from "@/lib/email/reply-classifier";
import { resolveSuppressionReason } from "@/lib/email/suppression";
import { normalizeOrderNumber } from "@/lib/orders/reconcile";
import { GmailClient } from "./client";
import { GmailApiError, GmailReauthRequiredError } from "./errors";
import { isEtsyNotificationSender, parseEtsyEmail, type ParsedEtsyEmail } from "./etsy-mail";
import { extractPlainText, header } from "./mime";
import type { GmailCredentials, GmailHistoryMessage, GmailMessage } from "./types";

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

  // Etsy has no messaging API (CLAUDE.md): every buyer message and sale
  // notification instead arrives as an email FROM Etsy itself to the shop's
  // mailbox. Route those through the Etsy-specific parser/matcher instead of
  // treating them as a generic customer reply.
  if (isEtsyNotificationSender(from)) {
    return attachEtsyNotification(businessId, gmailMessageId, msg);
  }

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

/**
 * Find the order this Etsy notification is about. Receipt id is authoritative
 * (Etsy's human order number IS the receipt id — matches either a fully
 * synced order or a not-yet-reconciled `manual:` stub whose platform_order_name
 * is the same number, see lib/orders/reconcile.ts). Falling back to buyer name
 * + shop is a heuristic ("regarding my portrait" with no order number quoted)
 * — Etsy conversation notifications usually carry only the buyer's Etsy
 * username, which rarely matches a real customer name, so this fallback is
 * expected to miss more often than it hits; a miss lands in the unmatched tray.
 */
async function matchEtsyOrder(
  tx: Tx,
  businessId: string,
  parsed: ParsedEtsyEmail,
): Promise<{ orderId: string; customerId: string | null } | null> {
  if (parsed.receiptId) {
    const [byReceipt] = await tx
      .select({ id: orders.id, customerId: orders.customerId })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          or(eq(orders.platformOrderId, parsed.receiptId), eq(orders.platformOrderName, parsed.receiptId)),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(1);
    if (byReceipt) return { orderId: byReceipt.id, customerId: byReceipt.customerId };
  }

  if (!parsed.buyerName) return null;
  let shopIds: string[] | null = null;
  if (parsed.shopName) {
    const shopRows = await tx
      .select({ id: shops.id })
      .from(shops)
      .where(and(eq(shops.businessId, businessId), eq(shops.platform, "etsy"), ilike(shops.name, `%${parsed.shopName}%`)));
    if (shopRows.length) shopIds = shopRows.map((r) => r.id);
  }
  const needle = `%${parsed.buyerName}%`;
  const custRows = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.businessId, businessId),
        or(ilike(customers.firstName, needle), sql`concat_ws(' ', ${customers.firstName}, ${customers.lastName}) ilike ${needle}`),
      ),
    );
  if (!custRows.length) return null;
  const custIds = custRows.map((c) => c.id);
  const candidates = await tx
    .select({ id: orders.id, shopId: orders.shopId, customerId: orders.customerId })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), inArray(orders.customerId, custIds)))
    .orderBy(desc(orders.createdAt))
    .limit(10);
  if (!candidates.length) return null;
  const scoped = shopIds ? candidates.filter((c) => shopIds!.includes(c.shopId)) : candidates;
  const pick = scoped[0] ?? candidates[0];
  return { orderId: pick.id, customerId: pick.customerId };
}

/**
 * Which Etsy shop (under this business) a sale notification belongs to, so a
 * not-yet-imported sale can create a properly-shopped order stub. Matches the
 * parsed shop name when the email states one; falls back to the business's
 * only active Etsy shop when there is exactly one (the common case — most
 * businesses run one Etsy shop per mailbox).
 */
async function resolveEtsyShop(tx: Tx, businessId: string, shopName: string | null): Promise<string | null> {
  const rows = await tx
    .select({ id: shops.id, name: shops.name })
    .from(shops)
    .where(and(eq(shops.businessId, businessId), eq(shops.platform, "etsy"), eq(shops.active, true)));
  if (!rows.length) return null;
  if (shopName) {
    const needle = shopName.trim().toLowerCase();
    const match = rows.find((r) => r.name.toLowerCase().includes(needle) || needle.includes(r.name.toLowerCase()));
    if (match) return match.id;
  }
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * A "You made a sale!" notification for a receipt AlphaOS has not imported
 * yet (the sync hasn't run, or the shop isn't connected at all) still tells a
 * VA a real order exists. Create the same `manual:` sentinel stub the manual
 * order form uses, in `awaiting_details` (mirrors syncShopReceipts's own
 * import shape) — when the real Etsy sync later imports this receipt,
 * reconcileManualOrder promotes this row in place instead of duplicating it.
 */
async function createEtsySaleStub(
  tx: Tx,
  businessId: string,
  parsed: ParsedEtsyEmail,
): Promise<{ orderId: string; createdOrder: true } | { orderId: null; createdOrder: false; reason: string }> {
  if (!parsed.receiptId) return { orderId: null, createdOrder: false, reason: "No receipt id in the sale email" };
  const shopId = await resolveEtsyShop(tx, businessId, parsed.shopName);
  if (!shopId) return { orderId: null, createdOrder: false, reason: "Could not determine which Etsy shop this sale belongs to" };

  const norm = normalizeOrderNumber(parsed.receiptId);
  const [inserted] = await tx
    .insert(orders)
    .values({
      businessId,
      shopId,
      customerId: null,
      platformOrderId: `manual:${norm}`,
      platformOrderName: parsed.receiptId,
      status: "awaiting_details",
      source: "manual",
      placedAt: new Date(),
      uploadToken: randomUUID(),
      needsReview: false,
      notes: parsed.buyerName ? `Customer: ${parsed.buyerName}` : null,
      rawImport: { source: "etsy_sale_email", receiptId: parsed.receiptId, buyerName: parsed.buyerName, itemTitle: parsed.itemTitle, shopName: parsed.shopName },
    })
    .onConflictDoNothing({ target: [orders.shopId, orders.platformOrderId] })
    .returning({ id: orders.id });

  if (!inserted) {
    // Another concurrent poll already created it (or a real order number
    // collision) — look it up rather than treat this as a failure.
    const [existing] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.shopId, shopId), eq(orders.platformOrderId, `manual:${norm}`)))
      .limit(1);
    if (existing) return { orderId: existing.id, createdOrder: true };
    return { orderId: null, createdOrder: false, reason: "Could not create the order stub" };
  }

  await tx.insert(activityLog).values({
    businessId,
    orderId: inserted.id,
    actorId: null,
    action: "order.imported",
    fromState: null,
    toState: "awaiting_details",
    metadata: { source: "etsy_sale_email", receiptId: parsed.receiptId, shopName: parsed.shopName },
  });
  return { orderId: inserted.id, createdOrder: true };
}

const ETSY_NOTIFICATION_TITLES: Record<EtsyEmailKindLike, string> = {
  message: "New Etsy message",
  sale: "New Etsy sale",
  shipped: "Etsy shipping update",
};
type EtsyEmailKindLike = ParsedEtsyEmail["kind"];

/**
 * Attach (or file as unmatched) one Etsy notification email. Distinct from
 * attachMessage: the sender is Etsy itself, never the buyer, so there is no
 * suppression/self-send check, and a "You made a sale" notice for a receipt
 * we've never seen can create the order header itself.
 */
async function attachEtsyNotification(businessId: string, gmailMessageId: string, msg: GmailMessage): Promise<boolean> {
  const subject = header(msg, "Subject") ?? "";
  const body = extractPlainText(msg);
  const parsed = parseEtsyEmail({ subject, body });
  if (!parsed) {
    // Etsy also sends marketing/weekly-stats mail with no actionable content —
    // recognised as "from Etsy" but not one of our three kinds. Nothing to
    // store.
    return false;
  }

  const result = await withSystemContext(async (tx) => {
    const [existing] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.gmailMessageId, gmailMessageId))
      .limit(1);
    if (existing) return null;

    let match = await matchEtsyOrder(tx, businessId, parsed);
    let createdOrder = false;
    if (!match && parsed.kind === "sale") {
      const stub = await createEtsySaleStub(tx, businessId, parsed);
      if (stub.createdOrder) {
        match = { orderId: stub.orderId, customerId: null };
        createdOrder = true;
      }
    }

    const [inserted] = await tx
      .insert(messages)
      .values({
        businessId,
        orderId: match?.orderId ?? null,
        customerId: match?.customerId ?? null,
        direction: "inbound",
        channel: "etsy",
        status: "received",
        subject,
        address: parsed.buyerName,
        body: parsed.body,
        gmailMessageId,
        gmailThreadId: msg.threadId,
        metadata: {
          etsyLink: parsed.link,
          kind: parsed.kind,
          receiptId: parsed.receiptId,
          buyerName: parsed.buyerName,
          shopName: parsed.shopName,
          itemTitle: parsed.itemTitle,
          createdOrder,
        },
      })
      .returning({ id: messages.id });

    if (match?.orderId) {
      await tx.insert(activityLog).values({
        businessId,
        orderId: match.orderId,
        actorId: null,
        action: "message.received",
        metadata: { channel: "etsy", kind: parsed.kind, etsyLink: parsed.link },
      });
    }

    const staff = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.role, ["admin", "va"]), eq(users.active, true)));
    if (staff.length) {
      const title = ETSY_NOTIFICATION_TITLES[parsed.kind];
      const preview = parsed.body.slice(0, 180);
      const bodyText = match?.orderId
        ? preview
        : `${preview}${preview ? " — " : ""}Could not match this to an order automatically. Open Emails to link it.`;
      await tx.insert(notifications).values(
        staff.map((s) => ({
          businessId,
          userId: s.id,
          type: "message.received",
          orderId: match?.orderId ?? null,
          title,
          body: bodyText,
          href: match?.orderId ? `/orders/${match.orderId}` : "/emails",
        })),
      );
    }

    logInbound(businessId, {
      event: "etsy_notification_attached",
      gmailMessageId,
      kind: parsed.kind,
      matched: !!match?.orderId,
      createdOrder,
    });
    return inserted.id;
  });
  return !!result;
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
