import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, max, ne, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, messages, orderItems, orders, proofs, shops } from "@/lib/db/schema";
import { notifyVaEmailFailure, sendMessage } from "@/lib/email/dispatch";
import { isNonPortraitLine, type ClassifyConfig } from "@/lib/integrations/classify";
import {
  deliverTogetherDecision,
  holdOf,
  HELD_ACTION,
  RELEASED_ACTION,
  releaseVerdict,
  SIBLING_RELEASED_ACTION,
  SIBLING_WAITING_ACTION,
  type HoldState,
  type TogetherDecision,
  type TogetherOrder,
  type TogetherSibling,
} from "@/lib/orders/deliver-together";
import { ADD_ON_TITLE } from "@/lib/orders/add-ons";
import { buyerWordsWhere } from "@/lib/reminders/buyer-replied";
import { loadSameBuyerContext, orderNumberOf } from "@/lib/orders/same-buyer";

/**
 * Deliver together, the database half (the rule is lib/orders/deliver-together.ts).
 *
 * A held proof is the QC-pass message itself, kept as a `draft` (no email, no
 * Etsy queue), with `messages.metadata.deliverTogether` = HoldState, plus an
 * activity_log row `proof.held_for_siblings`. Letting it go stamps
 * `deliverTogether.releasedAt` (one writer wins), writes `proof.hold_released`,
 * then sends it the same way an unheld pass would have. sendMessage never sends
 * a row twice, so every road may call release.
 */

/** Runs a function in a transaction: withUserContext for a signed-in person, withSystemContext for cron. */
export type Runner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

const systemRunner: Runner = (fn) => withSystemContext(fn);

/** How many of the buyer's other orders are read (newest first). */
const SIBLING_LIMIT = 40;

export type TogetherLoad = { order: TogetherOrder & { archived: boolean }; siblings: TogetherSibling[] };

/** This order and the buyer's other orders, with what the rule needs. Strong links only count (see the rule). */
export async function loadTogether(tx: Tx, orderId: string): Promise<TogetherLoad | null> {
  const [row] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      status: orders.status,
      placedAt: orders.placedAt,
      createdAt: orders.createdAt,
      dueAt: orders.dueAt,
      archivedAt: orders.archivedAt,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) return null;
  const order = {
    id: row.id,
    number: orderNumberOf(row),
    businessId: row.businessId,
    status: row.status,
    placedAt: row.placedAt,
    createdAt: row.createdAt,
    dueAt: row.dueAt,
    archived: !!row.archivedAt,
  };
  const ctx = await loadSameBuyerContext(tx, orderId, { staff: true, limit: SIBLING_LIMIT });
  const linked = new Map<string, "buyer" | "notes">();
  for (const o of ctx?.others ?? []) if (o.id) linked.set(o.id, o.linkedBy);
  const ids = [...linked.keys()];
  if (!ids.length) return { order, siblings: [] };

  const [rows, lines, sentProofs, passMessages] = await Promise.all([
    tx
      .select({
        id: orders.id,
        businessId: orders.businessId,
        status: orders.status,
        placedAt: orders.placedAt,
        createdAt: orders.createdAt,
        dueAt: orders.dueAt,
        archivedAt: orders.archivedAt,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        cfg: shops.integrationConfig,
      })
      .from(orders)
      .leftJoin(shops, eq(shops.id, orders.shopId))
      .where(inArray(orders.id, ids)),
    tx
      .select({ orderId: orderItems.orderId, title: orderItems.title, sku: orderItems.sku })
      .from(orderItems)
      .where(inArray(orderItems.orderId, ids)),
    tx
      .select({ orderId: proofs.orderId })
      .from(proofs)
      .where(and(inArray(proofs.orderId, ids), isNotNull(proofs.sentAt))),
    tx
      .select({ orderId: messages.orderId, status: messages.status, metadata: messages.metadata })
      .from(messages)
      .where(
        and(
          inArray(messages.orderId, ids),
          eq(messages.direction, "outbound"),
          isNull(messages.archivedAt),
          sql`${messages.metadata} ? 'qcPass'`,
        ),
      ),
  ]);
  const proofSent = new Set(sentProofs.map((p) => p.orderId));
  const siblings: TogetherSibling[] = rows.map((r) => {
    const own = lines.filter((l) => l.orderId === r.id);
    const cfg = (r.cfg ?? null) as ClassifyConfig | null;
    const portraitLines = own.filter((l) => !isNonPortraitLine(l, cfg) && !ADD_ON_TITLE.test(l.title ?? "")).length;
    const mine = passMessages.filter((m) => m.orderId === r.id);
    const heldForSiblings = mine.some((m) => m.status === "draft" && !!holdOf(m.metadata) && !holdOf(m.metadata)?.releasedAt);
    const proofOut =
      proofSent.has(r.id) ||
      mine.some((m) => m.status === "queued" || m.status === "sent" || !!holdOf(m.metadata)?.releasedAt);
    return {
      id: r.id,
      number: orderNumberOf(r),
      businessId: r.businessId,
      status: r.status,
      placedAt: r.placedAt,
      createdAt: r.createdAt,
      dueAt: r.dueAt,
      linkedBy: linked.get(r.id) ?? "notes",
      archived: !!r.archivedAt,
      portraitLines,
      proofOut,
      heldForSiblings,
    };
  });
  return { order, siblings };
}

/** The rule for one order, read now. Null when the order is gone. */
export async function deliverTogetherFor(tx: Tx, orderId: string, now = new Date()): Promise<TogetherDecision | null> {
  const load = await loadTogether(tx, orderId);
  return load ? deliverTogetherDecision(load.order, load.siblings, now) : null;
}

/**
 * Record a hold on the QC-pass message (still a draft) and on the order's
 * history. Run it in the same transaction as the move to awaiting_approval, so
 * the order never sits there with an unsent draft nobody will let go.
 */
export async function recordDeliveryHold(
  tx: Tx,
  input: {
    orderId: string;
    businessId: string;
    messageId: string;
    proofId: string | null;
    decision: TogetherDecision;
    passedBy: string | null;
    delivery: "email" | "etsy";
    now?: Date;
  },
): Promise<HoldState> {
  const state: HoldState = {
    heldAt: (input.now ?? new Date()).toISOString(),
    holdUntil: (input.decision.holdUntil ?? input.now ?? new Date()).toISOString(),
    waitingOn: input.decision.waitingOn,
    why: input.decision.why,
    passedBy: input.passedBy,
  };
  await tx
    .update(messages)
    .set({ metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || jsonb_build_object('deliverTogether', ${JSON.stringify(state)}::jsonb)` })
    .where(eq(messages.id, input.messageId));
  await tx.insert(activityLog).values({
    businessId: input.businessId,
    orderId: input.orderId,
    actorId: input.passedBy,
    action: HELD_ACTION,
    metadata: {
      messageId: input.messageId,
      proofId: input.proofId,
      waitingOn: state.waitingOn,
      ready: input.decision.ready,
      holdUntil: state.holdUntil,
      why: state.why,
      delivery: input.delivery,
    },
  });
  const [own] = await tx
    .select({ platformOrderName: orders.platformOrderName, platformOrderId: orders.platformOrderId })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);
  await signalSiblings(
    tx,
    input.businessId,
    state.waitingOn.map((w) => w.id),
    SIBLING_WAITING_ACTION,
    { messageId: input.messageId, heldOrderId: input.orderId, heldOrderNumber: own ? orderNumberOf(own) : "", holdUntil: state.holdUntil },
    input.passedBy,
  );
  return state;
}

/**
 * The quiet board signal on the orders a held proof waits on: one activity row
 * each (order numbers only, designer-safe). The board reads it as a card label
 * (togetherWaitingNote). Never a message to anyone.
 */
async function signalSiblings(
  tx: Tx,
  businessId: string,
  orderIds: string[],
  action: typeof SIBLING_WAITING_ACTION | typeof SIBLING_RELEASED_ACTION,
  metadata: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  const ids = [...new Set(orderIds)];
  if (!ids.length) return;
  await tx.insert(activityLog).values(ids.map((orderId) => ({ businessId, orderId, actorId, action, metadata })));
}

/** The draft emails 2..N of a held proof: queue them (the flush sends them) or archive them. */
async function settleRestOfHeldProof(tx: Tx, orderId: string, firstMessageId: string, how: "queue" | "archive", now: Date): Promise<void> {
  await tx
    .update(messages)
    .set(how === "queue" ? { status: "queued" } : { archivedAt: now })
    .where(
      and(
        eq(messages.orderId, orderId),
        eq(messages.status, "draft"),
        isNull(messages.archivedAt),
        sql`${messages.metadata}->'proofEmail'->>'firstMessageId' = ${firstMessageId}`,
      ),
    );
}

export type OpenHold = { messageId: string; orderId: string; businessId: string; channel: string; hold: HoldState };

/** Held proofs not let go yet: QC-pass drafts carrying a hold with no releasedAt. */
export async function openHolds(tx: Tx, filter: { orderIds?: string[]; limit?: number; newestFirst?: boolean } = {}): Promise<OpenHold[]> {
  if (filter.orderIds && !filter.orderIds.length) return [];
  const rows = await tx
    .select({
      id: messages.id,
      orderId: messages.orderId,
      businessId: messages.businessId,
      channel: messages.channel,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "outbound"),
        eq(messages.status, "draft"),
        isNull(messages.archivedAt),
        isNotNull(messages.orderId),
        sql`${messages.metadata} ? 'qcPass'`,
        sql`${messages.metadata} ? 'deliverTogether'`,
        sql`${messages.metadata}->'deliverTogether'->>'releasedAt' is null`,
        filter.orderIds ? inArray(messages.orderId, filter.orderIds) : undefined,
      ),
    )
    .orderBy(filter.newestFirst ? desc(messages.createdAt) : asc(messages.createdAt))
    .limit(filter.limit ?? 200);
  return rows.flatMap((r) => {
    const hold = holdOf(r.metadata);
    return hold && r.orderId ? [{ messageId: r.id, orderId: r.orderId, businessId: r.businessId, channel: r.channel, hold }] : [];
  });
}

/**
 * A new QC pass on an order replaces its older held proofs (sent back and
 * passed again): close them unsent, in the caller's transaction.
 */
export async function closeSupersededHolds(tx: Tx, orderId: string, keepMessageId: string, byUserId: string | null): Promise<number> {
  const old = (await openHolds(tx, { orderIds: [orderId] })).filter((h) => h.messageId !== keepMessageId);
  const at = new Date().toISOString();
  for (const h of old) {
    const patch = { releasedAt: at, releaseReason: "superseded", releasedBy: byUserId };
    // Archived too, so nobody sends the old proof from the outbox.
    await tx
      .update(messages)
      .set({
        archivedAt: new Date(),
        metadata: sql`jsonb_set(${messages.metadata}, '{deliverTogether}', (${messages.metadata}->'deliverTogether') || ${JSON.stringify(patch)}::jsonb)`,
      })
      .where(eq(messages.id, h.messageId));
    await settleRestOfHeldProof(tx, orderId, h.messageId, "archive", new Date());
    await tx.insert(activityLog).values({
      businessId: h.businessId,
      orderId,
      actorId: byUserId,
      action: RELEASED_ACTION,
      metadata: { messageId: h.messageId, reason: "superseded", sending: false, heldAt: h.hold.heldAt, holdUntil: h.hold.holdUntil, waitingOn: h.hold.waitingOn },
    });
    await signalSiblings(tx, h.businessId, h.hold.waitingOn.map((w) => w.id), SIBLING_RELEASED_ACTION, { messageId: h.messageId, reason: "superseded" }, byUserId);
  }
  return old.length;
}

/** The open hold on one order (the order page banner), or null. */
export async function heldProofFor(tx: Tx, orderId: string): Promise<OpenHold | null> {
  const [h] = await openHolds(tx, { orderIds: [orderId], limit: 1, newestFirst: true });
  return h ?? null;
}

export type ReleaseReason = "she_asked" | "group_ready" | "due" | "send_now";
export type ReleaseResult =
  | { ok: true; sent: boolean; closed?: string }
  | { ok: false; code: string; message: string };

type HeldMessage = {
  id: string;
  orderId: string;
  businessId: string;
  channel: string;
  proofId: string | null;
  address: string | null;
  templateKey: string | null;
};

/**
 * Let one held proof go. Exactly one caller claims it (the releasedAt stamp);
 * the others get `sent: false`. When the order moved on, the message was sent
 * from the outbox or discarded, the hold is closed without sending.
 */
export async function releaseHeldProof(
  messageId: string,
  opts: { reason: ReleaseReason; byUserId?: string | null; run?: Runner; now?: Date },
): Promise<ReleaseResult> {
  const run = opts.run ?? systemRunner;
  const now = opts.now ?? new Date();
  const by = opts.byUserId ?? null;
  const claim = await run(async (tx) => {
    const [m] = await tx
      .select({
        id: messages.id,
        orderId: messages.orderId,
        businessId: messages.businessId,
        status: messages.status,
        channel: messages.channel,
        proofId: messages.proofId,
        address: messages.address,
        templateKey: messages.templateKey,
        archivedAt: messages.archivedAt,
        sentAt: messages.sentAt,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!m?.orderId) return { kind: "none" as const, code: "not_found", message: "That held proof is gone." };
    const hold = holdOf(m.metadata);
    if (!hold) return { kind: "none" as const, code: "not_held", message: "This proof is not held." };
    if (hold.releasedAt) return { kind: "done" as const };
    // The order row lock orders this against a QC move or a second release.
    const [o] = await tx
      .select({ status: orders.status, archivedAt: orders.archivedAt })
      .from(orders)
      .where(eq(orders.id, m.orderId))
      .for("update");
    // A newer QC pass (sent back and passed again) replaced this proof: the old one never goes.
    const [newer] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orderId, m.orderId),
          eq(messages.direction, "outbound"),
          sql`${messages.metadata} ? 'qcPass'`,
          ne(messages.id, m.id),
          // Compared in SQL: a JS Date drops the microseconds, so the row would be newer than itself.
          sql`${messages.createdAt} > (select m2.created_at from messages m2 where m2.id = ${m.id})`,
        ),
      )
      .limit(1);
    const sendable = m.status === "draft" && !m.archivedAt && o?.status === "awaiting_approval" && !o.archivedAt && !newer;
    const closed = sendable
      ? null
      : m.status === "sent"
        ? "sent_elsewhere"
        : m.archivedAt || m.status !== "draft"
          ? "discarded"
          : newer
            ? "superseded"
            : "order_moved";
    const patch = { releasedAt: now.toISOString(), releaseReason: closed ?? opts.reason, releasedBy: by };
    // A stale draft (replaced, or its order moved on) is archived so nobody sends it from the outbox.
    const stale = closed === "superseded" || closed === "order_moved";
    const claimed = await tx
      .update(messages)
      .set({
        ...(stale ? { archivedAt: now } : {}),
        metadata: sql`jsonb_set(${messages.metadata}, '{deliverTogether}', (${messages.metadata}->'deliverTogether') || ${JSON.stringify(patch)}::jsonb)`,
      })
      .where(and(eq(messages.id, messageId), sql`${messages.metadata}->'deliverTogether'->>'releasedAt' is null`))
      .returning({ id: messages.id });
    if (!claimed.length) return { kind: "done" as const };
    // Sent by hand from the outbox: the proof clock (reminders) still needs its sent time.
    if (closed === "sent_elsewhere" && m.proofId && m.channel === "email") {
      await tx
        .update(proofs)
        .set({ sentAt: m.sentAt ?? now })
        .where(and(eq(proofs.id, m.proofId), isNull(proofs.sentAt)));
    }
    // Emails 2..N of a proof too big for one follow the first: queued when it went, archived when it never will.
    if (closed) await settleRestOfHeldProof(tx, m.orderId, messageId, closed === "sent_elsewhere" ? "queue" : "archive", now);
    await tx.insert(activityLog).values({
      businessId: m.businessId,
      orderId: m.orderId,
      actorId: by,
      action: RELEASED_ACTION,
      metadata: {
        messageId,
        reason: closed ?? opts.reason,
        sending: !closed,
        heldAt: hold.heldAt,
        holdUntil: hold.holdUntil,
        waitingOn: hold.waitingOn,
      },
    });
    await signalSiblings(tx, m.businessId, hold.waitingOn.map((w) => w.id), SIBLING_RELEASED_ACTION, { messageId, reason: closed ?? opts.reason }, by);
    if (closed) return { kind: "closed" as const, closed };
    const held: HeldMessage = {
      id: m.id,
      orderId: m.orderId,
      businessId: m.businessId,
      channel: m.channel,
      proofId: m.proofId,
      address: m.address,
      templateKey: m.templateKey,
    };
    return { kind: "send" as const, held, hold };
  });
  if (claim.kind === "none") return { ok: false, code: claim.code, message: claim.message };
  if (claim.kind === "done") return { ok: true, sent: false };
  if (claim.kind === "closed") return { ok: true, sent: false, closed: claim.closed };
  return deliverReleased(run, claim.held, by ?? claim.hold.passedBy, opts.reason);
}

/**
 * Send a released proof exactly as an unheld QC pass would have: the email
 * (proofs.sent_at, email.sent) or the Etsy row queued (etsy.queued), then the
 * rest of a proof too big for one email. The send counts as the approval of
 * the person who passed QC, so the automatic-send cap does not hold it.
 */
async function deliverReleased(run: Runner, m: HeldMessage, approvedBy: string | null, reason: string): Promise<ReleaseResult> {
  const approvedById = approvedBy ?? undefined;
  const sent = await sendMessage(m.id, { approvedById, markRetryableFailed: true });
  if (!sent.ok) {
    if (sent.busy) return { ok: true, sent: false };
    await run(async (tx) => {
      await notifyVaEmailFailure(tx, { businessId: m.businessId, orderId: m.orderId, messageId: m.id, error: sent.error });
      await tx.insert(activityLog).values({
        businessId: m.businessId,
        orderId: m.orderId,
        actorId: approvedBy,
        action: "email.send_failed",
        metadata: { messageId: m.id, error: sent.error, to: m.address, via: "deliver_together" },
      });
    });
    return { ok: false, code: "send_failed", message: sent.error };
  }
  await run(async (tx) => {
    if (m.channel === "etsy") {
      await tx.insert(activityLog).values({
        businessId: m.businessId,
        orderId: m.orderId,
        actorId: approvedBy,
        action: "etsy.queued",
        metadata: { messageId: m.id, templateKey: m.templateKey, reason: "no_email", via: "deliver_together", release: reason },
      });
      return;
    }
    if (m.proofId) await tx.update(proofs).set({ sentAt: new Date() }).where(eq(proofs.id, m.proofId));
    await tx.insert(activityLog).values({
      businessId: m.businessId,
      orderId: m.orderId,
      actorId: approvedBy,
      action: "email.sent",
      metadata: { messageId: m.id, templateKey: m.templateKey, to: m.address, via: "deliver_together", release: reason },
    });
  });
  await sendRestOfHeldProof(run, m, approvedBy);
  return { ok: true, sent: true };
}

/** Emails 2..N of a held proof too big for one: queued now, sent now; the outbox retries any that fail. */
async function sendRestOfHeldProof(run: Runner, m: HeldMessage, approvedBy: string | null): Promise<void> {
  const rest = await run((tx) =>
    tx
      .update(messages)
      .set({ status: "queued", approvedBy, error: null })
      .where(
        and(
          eq(messages.orderId, m.orderId),
          eq(messages.status, "draft"),
          sql`${messages.metadata}->'proofEmail'->>'firstMessageId' = ${m.id}`,
        ),
      )
      .returning({ id: messages.id, metadata: messages.metadata }),
  );
  const ordered = rest.sort(
    (a, b) =>
      Number((a.metadata as { proofEmail?: { n?: number } } | null)?.proofEmail?.n ?? 0) -
      Number((b.metadata as { proofEmail?: { n?: number } } | null)?.proofEmail?.n ?? 0),
  );
  for (const r of ordered) {
    const res = await sendMessage(r.id, { approvedById: approvedBy ?? undefined, markRetryableFailed: true });
    if (res.ok || res.busy) continue;
    await run(async (tx) => {
      await notifyVaEmailFailure(tx, { businessId: m.businessId, orderId: m.orderId, messageId: r.id, error: res.error });
      await tx.insert(activityLog).values({
        businessId: m.businessId,
        orderId: m.orderId,
        actorId: approvedBy,
        action: "email.send_failed",
        metadata: { messageId: r.id, error: res.error, to: m.address, proofEmailOf: m.id, via: "deliver_together" },
      });
    });
  }
}

export type ReviewOutcome = "released" | "kept" | "closed" | "failed";

/**
 * Her newest words (email reply, Etsy conversation message) after the hold
 * began, on the held order or any order of its group (stored and fresh), or
 * null. A buyer who writes in is chasing: the held proof goes at once.
 */
async function lastBuyerWordsSince(run: Runner, h: OpenHold, fresh: TogetherDecision | null): Promise<Date | null> {
  const heldAt = new Date(h.hold.heldAt);
  if (Number.isNaN(heldAt.getTime())) return null;
  const ids = [
    ...new Set([h.orderId, ...h.hold.waitingOn.map((w) => w.id), ...(fresh?.waitingOn ?? []).map((w) => w.id), ...(fresh?.ready ?? []).map((w) => w.id)]),
  ];
  const [row] = await run((tx) =>
    tx
      .select({ at: max(messages.createdAt) })
      .from(messages)
      .where(and(inArray(messages.orderId, ids), buyerWordsWhere(), gt(messages.createdAt, heldAt))),
  );
  return row?.at ? new Date(row.at) : null;
}

/**
 * Look at one held proof again: let it go when its time is up, when nothing it
 * waits on still counts, or when its own order moved on (closed unsent).
 * Otherwise keep it, refreshing who it waits on; the stored holdUntil is never
 * pushed later.
 */
async function reviewHold(run: Runner, h: OpenHold, now: Date, by: string | null): Promise<ReviewOutcome> {
  const [load, newest] = await run((tx) =>
    Promise.all([
      loadTogether(tx, h.orderId),
      tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.orderId, h.orderId), eq(messages.direction, "outbound"), sql`${messages.metadata} ? 'qcPass'`))
        .orderBy(desc(messages.createdAt))
        .limit(1)
        .then((r) => r[0]?.id ?? null),
    ]),
  );
  // Gone, moved on, or replaced by a newer pass: the release closes it unsent.
  const gone = !load || load.order.archived || load.order.status !== "awaiting_approval" || newest !== h.messageId;
  const fresh = load ? deliverTogetherDecision(load.order, load.siblings, now) : null;
  const lastWords = gone ? null : await lastBuyerWordsSince(run, h, fresh);
  const verdict = gone ? ({ release: true, reason: "group_ready" } as const) : releaseVerdict(h.hold, fresh, now, lastWords);
  if (verdict.release) {
    const res = await releaseHeldProof(h.messageId, { reason: verdict.reason, byUserId: by, run, now });
    if (!res.ok) return "failed";
    return res.sent ? "released" : "closed";
  }
  const waiting = JSON.stringify((fresh?.waitingOn ?? []).map((w) => [w.id, w.status]));
  if (fresh && waiting !== JSON.stringify(h.hold.waitingOn.map((w) => [w.id, w.status]))) {
    const patch = { waitingOn: fresh.waitingOn, why: fresh.why };
    const before = new Set(h.hold.waitingOn.map((w) => w.id));
    const after = new Set(fresh.waitingOn.map((w) => w.id));
    const heldOrderNumber = load?.order.number ?? "";
    await run(async (tx) => {
      const done = await tx
        .update(messages)
        .set({
          metadata: sql`jsonb_set(${messages.metadata}, '{deliverTogether}', (${messages.metadata}->'deliverTogether') || ${JSON.stringify(patch)}::jsonb)`,
        })
        .where(and(eq(messages.id, h.messageId), sql`${messages.metadata}->'deliverTogether'->>'releasedAt' is null`))
        .returning({ id: messages.id });
      if (!done.length) return;
      // The board labels follow who it waits on now.
      await signalSiblings(tx, h.businessId, [...after].filter((id) => !before.has(id)), SIBLING_WAITING_ACTION, { messageId: h.messageId, heldOrderId: h.orderId, heldOrderNumber, holdUntil: h.hold.holdUntil }, by);
      await signalSiblings(tx, h.businessId, [...before].filter((id) => !after.has(id)), SIBLING_RELEASED_ACTION, { messageId: h.messageId, reason: "not_waiting" }, by);
    });
  }
  return "kept";
}

/**
 * After an order's proof went out (QC pass, owner approval): look again at the
 * held proofs of the same buyer, so the ones that waited on it go now, in the
 * same step. Never throws; the sweep catches anything left.
 */
export async function releaseSiblingHolds(run: Runner, orderId: string, byUserId: string | null, now = new Date()): Promise<number> {
  try {
    const holds = await run(async (tx) => {
      const ctx = await loadSameBuyerContext(tx, orderId, { staff: true, limit: SIBLING_LIMIT });
      const ids = (ctx?.others ?? []).filter((o) => o.id && o.linkedBy === "buyer").map((o) => o.id as string);
      return openHolds(tx, { orderIds: ids });
    });
    let released = 0;
    for (const h of holds) {
      try {
        if ((await reviewHold(run, h, now, byUserId)) === "released") released += 1;
      } catch (err) {
        console.error("deliver together: sibling release failed", h.orderId, err);
      }
    }
    return released;
  } catch (err) {
    console.error("deliver together: sibling review failed", orderId, err);
    return 0;
  }
}

/** Owner "Send now" on the order page: the held proof goes at once. */
export async function sendHeldProofNow(run: Runner, orderId: string, byUserId: string): Promise<ReleaseResult> {
  const h = await run((tx) => heldProofFor(tx, orderId));
  if (!h) return { ok: false, code: "not_held", message: "This order has no held proof any more. Refresh the page." };
  return releaseHeldProof(h.messageId, { reason: "send_now", byUserId, run });
}

export type DeliveryHoldSweep = { checked: number; released: number; kept: number; closed: number; failed: number; retried: number };

/** A release claimed this long ago whose message is still a draft (the sender died): send it again. */
const STUCK_RELEASE_MS = 10 * 60 * 1000;

/**
 * The cron half (called from /api/cron/reminders, which the agent ticks every
 * 10 to 15 min): every held proof whose holdUntil has passed, whose waiting
 * orders no longer count (passed, delivered, cancelled, archived, gone, now
 * waiting on the buyer), or whose buyer wrote in since it was held, goes out. Idempotent: one release per hold, and
 * sendMessage never sends a row twice.
 */
export async function releaseDueDeliveryHolds(
  opts: { now?: Date; limit?: number; outOfTime?: () => boolean } = {},
): Promise<DeliveryHoldSweep> {
  const now = opts.now ?? new Date();
  const run = systemRunner;
  const out: DeliveryHoldSweep = { checked: 0, released: 0, kept: 0, closed: 0, failed: 0, retried: 0 };
  const holds = await run((tx) => openHolds(tx, { limit: opts.limit ?? 200 }));
  for (const h of holds) {
    if (opts.outOfTime?.()) break;
    out.checked += 1;
    try {
      out[await reviewHold(run, h, now, null)] += 1;
    } catch (err) {
      out.failed += 1;
      console.error("deliver together: sweep release failed", h.orderId, err);
    }
  }
  // A release whose send never ran (the process died between the claim and the send).
  const stuck = await run((tx) =>
    tx
      .select({
        id: messages.id,
        orderId: messages.orderId,
        businessId: messages.businessId,
        channel: messages.channel,
        proofId: messages.proofId,
        address: messages.address,
        templateKey: messages.templateKey,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "outbound"),
          eq(messages.status, "draft"),
          isNull(messages.archivedAt),
          sql`${messages.metadata} ? 'qcPass'`,
          sql`${messages.metadata}->'deliverTogether'->>'releaseReason' in ('she_asked', 'group_ready', 'due', 'send_now')`,
          sql`(${messages.metadata}->'deliverTogether'->>'releasedAt')::timestamptz < ${new Date(now.getTime() - STUCK_RELEASE_MS).toISOString()}::timestamptz`,
        ),
      )
      .limit(50),
  );
  for (const s of stuck) {
    if (opts.outOfTime?.() || !s.orderId) continue;
    const hold = holdOf(s.metadata);
    const res = await deliverReleased(
      run,
      { id: s.id, orderId: s.orderId, businessId: s.businessId, channel: s.channel, proofId: s.proofId, address: s.address, templateKey: s.templateKey },
      hold?.releasedBy ?? hold?.passedBy ?? null,
      hold?.releaseReason ?? "due",
    );
    if (res.ok && res.sent) out.retried += 1;
  }
  return out;
}
