import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { currentPeriod } from "@/lib/orders/earnings";
import { isDesignerLike } from "@/lib/auth/roles";

import { withUserContext, type RequestUser } from "@/lib/db";
import {
  orders,
  orderItems,
  assignments,
  activityLog,
  assets,
  customers,
  customerPublic,
  earnings,
  qcChecks,
  proofs,
  designerProfiles,
} from "@/lib/db/schema";
import { DEFAULT_TIMEZONE, isValidTimezone, startOfDayInTimezone } from "@/lib/designers/quiet-hours";
import type { ChecklistSnapshot, ItemResults } from "@/lib/qc/checklist";
import { issueLabels } from "@/lib/proofs/issues";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import { liveOrderWhere } from "@/lib/orders/archive";
import { clampItemQuantity } from "@/lib/orders/item-quantity";
import { loadProofFilePick } from "@/lib/proofs/files";
import { sizedImageUrl } from "@/lib/images";
import { personalizationOf } from "@/lib/orders/options-summary";
import { portraitLinesOf } from "@/lib/orders/add-ons";
import { distinctStyles, STYLE_FALLBACK_ACTION } from "@/lib/orders/order-styles";
import { pickPortraitItem } from "@/lib/orders/portrait-item";
import {
  loadDesignerSiblings,
  productLineOf,
  sameBuyerSentence,
  type BuyerAnchor,
  type DesignerSafeSibling,
  type LineItem,
} from "@/lib/orders/same-buyer";
import {
  COMPLETE_COLUMN_MAX,
  COMPLETE_COLUMN_WINDOW_DAYS,
  SENT_BACK_FROM,
  WITH_CUSTOMER_STATUSES,
} from "@/lib/orders/board-constants";
import {
  SIBLING_RELEASED_ACTION,
  SIBLING_WAITING_ACTION,
  togetherWaitingNote,
  type SiblingSignal,
} from "@/lib/orders/deliver-together";
import { resolveAttachmentViews } from "@/lib/qc/attachment-urls";
import type { QcAttachmentView } from "@/lib/qc/attachments";
import type { OrderStatus } from "./transitions";
import type { ProofAnnotation } from "@/lib/db/schema";

/** A revision the designer must act on — from QC, or from the customer. */
export type QcFailInfo = {
  reason: string | null;
  failedItems: string[];
  /** Pins the customer dropped on the proof preview (normalised 0..1 coords) — customer revisions only. */
  annotations?: ProofAnnotation[];
  /** Pictures the reviewer attached to a failed QC (login-free links), QC fails only. */
  attachments?: QcAttachmentView[];
};

export type BoardCard = {
  orderId: string;
  /** Human order number shown in the UI (Shopify name / Etsy receipt id). */
  orderNumber: string;
  status: OrderStatus;
  /**
   * The deadline this viewer is shown and sorted by (ISO). A designer sees
   * their OWN deadline (the active assignment's due_at, see CLAUDE.md
   * Deadlines); staff see the customer SLA (orders.due_at).
   */
  dueAt: string | null;
  /** Customer-facing SLA (orders.due_at). */
  orderDueAt: string | null;
  /** The assigned designer's own deadline (active assignments.due_at). */
  assignmentDueAt: string | null;
  figureCount: number;
  figuresResolved: boolean;
  style: string | null;
  /** Every portrait's style, the primary first (one entry on a one-style order). */
  styles: string[];
  /** Product title + variant options for the designer ("what am I making"). */
  title: string | null;
  options: { name: string; value: string }[];
  /**
   * Each portrait line on its own (2026-10-29: two portraits in two styles,
   * the card showed only the first), add-ons left out. Empty on a
   * one-portrait order, whose card reads as before.
   */
  portraits: BoardPortrait[];
  /**
   * Portraits in 2+ styles and the designer holding it does not list them all
   * (nobody did): which portrait they draw in its own style. Null otherwise.
   */
  styleNote: string | null;
  /**
   * The customer's personalization (names, wording for the art), verbatim,
   * from EVERY item: what a designer copies onto the portrait. `item` is the
   * 1-based line on an order with more than one item, else null.
   */
  personalization: { item: number | null; name: string; value: string }[];
  /** Free-text notes / special requests (manual orders). */
  notes: string | null;
  /** Order origin — 'manual' orders are badged so staff can tell at a glance. */
  source: "etsy" | "shopify" | "manual" | "legacy" | "trello";
  customerName: string;
  thumbnailUrl: string | null;
  /**
   * The most recent revision reason on a revision card — whichever came last:
   * a failed QC (`qcFail`) or a customer change request (`customerRevision`).
   * At most one is set, so the designer always sees the current instruction.
   */
  qcFail: QcFailInfo | null;
  customerRevision: QcFailInfo | null;
  /**
   * In design with a portrait version newer than the last send-back (QC fail
   * or customer revision): Submit for QC will be accepted. The same rule the
   * server enforces (transitions.ts assertHasSubmission), so the board only
   * offers Submit when it will work.
   */
  readyForQc: boolean;
  /** Marked URGENT (lib/orders/urgent.ts): pill on the card, sorted first. */
  urgent: boolean;
  urgentReason: string | null;
  /**
   * One buyer, several orders: one plain sentence naming the buyer's OTHER
   * orders (number, product, delivered or not) and telling the designer to
   * keep them apart. Null when the buyer has no other order. Order numbers and
   * products only, never a name, email or address (lib/orders/same-buyer.ts).
   */
  sameBuyer: string | null;
  /** The other orders' numbers, for the short chip on the card. */
  sameBuyerNumbers: string[];
  /**
   * Deliver together (lib/orders/deliver-together.ts): her other portrait
   * passed QC and its proof waits for this order, so she gets them together.
   * A quiet label only, never a message. Null when nothing waits on it.
   */
  togetherWaiting: string | null;
};

/**
 * One portrait line on a card: its portrait numbers (a line bought twice is
 * two, numbered as the upload picker and QC number them), style, figures,
 * product and options.
 */
export type BoardPortrait = {
  slots: number[];
  style: string | null;
  figureCount: number | null;
  title: string | null;
  options: { name: string; value: string }[];
};

type OrderRow = {
  id: string;
  platformOrderId: string;
  platformOrderName: string | null;
  status: OrderStatus;
  dueAt: Date | null;
  assignmentDueAt: Date | null;
  businessId: string;
  customerId: string | null;
  revisionCount: number;
  source: "etsy" | "shopify" | "manual" | "legacy" | "trello";
  notes: string | null;
  urgentAt: Date | null;
  urgentReason: string | null;
  /** The designer of the active assignment, if any. */
  assignedDesignerId: string | null;
};

type Tx = Parameters<Parameters<typeof withUserContext>[1]>[0];

/**
 * Small board-card variant of a reference photo. The mock seed's picsum URLs
 * get downsized (900x900 -> 400x400 in the path, still a real picsum size so
 * the image exists); Shopify CDN photos ask the CDN for a 640 px wide copy
 * (a customer's 2.2 MB phone photo becomes ~90 KB, docs/PERF.md). R2
 * presigned URLs are returned untouched. The full-size original is what the
 * card modal/detail view loads; only the board thumbnail wants the small one.
 */
function boardThumbnailUrl(url: string): string {
  return url.includes("picsum.photos") ? url.replace(/\/900\/900$/, "/400/400") : sizedImageUrl(url, 640);
}

/**
 * One buyer, several orders: the designer-safe siblings of each card's order
 * (lib/orders/same-buyer.ts). Its own read-only transaction, started beside
 * enrich()'s two others so the board waits no longer for it. It is an extra,
 * so a failure leaves the cards without the note rather than failing the board.
 */
async function sameBuyerSiblings(user: RequestUser, rows: OrderRow[]): Promise<Map<string, DesignerSafeSibling[]>> {
  const anchors: BuyerAnchor[] = rows.map((o) => ({
    id: o.id,
    businessId: o.businessId,
    number: o.platformOrderName ?? o.platformOrderId,
    customerId: o.customerId,
    notes: o.notes,
  }));
  try {
    return await withUserContext(user, (tx) => loadDesignerSiblings(tx, anchors));
  } catch (err) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "board_same_buyer_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return new Map();
  }
}

/** Statuses where a held proof can wait on the card (being drawn or checked). */
const TOGETHER_STATUSES = new Set<string>(["ready_to_assign", "in_design", "awaiting_qc", "awaiting_approval"]);
/** A hold lasts at most about 3 days: older signal rows cannot be open. */
const TOGETHER_SIGNAL_DAYS = 7;

/**
 * The deliver-together label for each card a held proof waits on, from the
 * signal rows on the card's own order. Its own read-only transaction; an
 * extra, so a failure leaves the cards without the label.
 */
async function togetherWaitingNotes(user: RequestUser, rows: OrderRow[]): Promise<Map<string, string>> {
  const ids = rows.filter((o) => TOGETHER_STATUSES.has(o.status)).map((o) => o.id);
  const out = new Map<string, string>();
  if (!ids.length) return out;
  try {
    const since = new Date(Date.now() - TOGETHER_SIGNAL_DAYS * 86_400_000);
    const signals = await withUserContext(user, (tx) =>
      tx
        .select({ orderId: activityLog.orderId, action: activityLog.action, metadata: activityLog.metadata, createdAt: activityLog.createdAt })
        .from(activityLog)
        .where(
          and(
            inArray(activityLog.orderId, ids),
            inArray(activityLog.action, [SIBLING_WAITING_ACTION, SIBLING_RELEASED_ACTION]),
            gte(activityLog.createdAt, since),
          ),
        ),
    );
    const byOrder = new Map<string, SiblingSignal[]>();
    for (const r of signals) {
      if (!r.orderId) continue;
      const list = byOrder.get(r.orderId);
      if (list) list.push(r);
      else byOrder.set(r.orderId, [r]);
    }
    const now = new Date();
    for (const [orderId, list] of byOrder) {
      const note = togetherWaitingNote(list, now);
      if (note) out.set(orderId, note);
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "board_together_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return out;
}

async function enrich(user: RequestUser, rows: OrderRow[]): Promise<BoardCard[]> {
  if (!rows.length) return [];
  const viewerRole = user.role;
  const ids = rows.map((o) => o.id);
  const revisionIds = rows.filter((o) => o.status === "in_design").map((o) => o.id);
  const custIds = rows.map((o) => o.customerId).filter((x): x is string => !!x);

  // Every query below only reads from `ids`/`revisionIds`/`custIds` (already
  // known from `rows`), so none depends on another's result. A transaction is
  // ONE connection, so queries "in parallel" on it still go over the wire one
  // after another (docs/PERF.md: the ~5 s board). The queries are therefore
  // split over read-only transactions that run side by side (two here, a third
  // for the same-buyer note below); each sets its own RLS GUCs (withUserContext),
  // so scoping is unchanged.
  const [[items, refs, customerRows, styleNoteRows], [failRows, revRows, vaRevisionRows, submissionRows], siblingsByOrder, togetherByOrder] = await Promise.all([
    withUserContext(user, (tx) => Promise.all([
    tx
      .select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        figureCount: orderItems.figureCount,
        style: orderItems.style,
        title: orderItems.title,
        variation: orderItems.variation,
        sku: orderItems.sku,
        options: orderItems.options,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, ids)),
    tx
      .select({ orderId: assets.orderId, url: assets.url, storage: assets.storage, r2Key: assets.r2Key })
      .from(assets)
      .where(and(inArray(assets.orderId, ids), eq(assets.type, "reference"), isNull(assets.deletedAt))),
    custIds.length
      ? isDesignerLike(viewerRole)
        ? tx
            .select({ id: customerPublic.id, firstName: customerPublic.firstName })
            .from(customerPublic)
            .where(inArray(customerPublic.id, custIds))
        : tx
            .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName })
            .from(customers)
            .where(inArray(customers.id, custIds))
      : Promise.resolve([]),
    // Two styles, a designer who does not list both (lib/orders/assign.ts STYLE_FALLBACK_ACTION).
    tx
      .select({ orderId: activityLog.orderId, metadata: activityLog.metadata })
      .from(activityLog)
      .where(and(inArray(activityLog.orderId, ids), eq(activityLog.action, STYLE_FALLBACK_ACTION)))
      .orderBy(desc(activityLog.createdAt)),
    ])),
    withUserContext(user, (tx) => Promise.all([
    revisionIds.length
      ? tx
          .select({
            orderId: qcChecks.orderId,
            reason: qcChecks.reason,
            checklistSnapshot: qcChecks.checklistSnapshot,
            itemResults: qcChecks.itemResults,
            attachments: qcChecks.attachments,
            createdAt: qcChecks.createdAt,
          })
          .from(qcChecks)
          .where(and(inArray(qcChecks.orderId, revisionIds), eq(qcChecks.result, "fail")))
          .orderBy(desc(qcChecks.createdAt))
      : Promise.resolve([]),
    revisionIds.length
      ? tx
          .select({
            orderId: proofs.orderId,
            revisionNotes: proofs.revisionNotes,
            failedItems: proofs.failedItems,
            annotations: proofs.annotations,
            decidedAt: proofs.decidedAt,
          })
          .from(proofs)
          .where(and(inArray(proofs.orderId, revisionIds), eq(proofs.decision, "revision")))
          .orderBy(desc(proofs.decidedAt))
      : Promise.resolve([]),
    revisionIds.length
      ? tx
          .select({
            orderId: activityLog.orderId,
            fromState: activityLog.fromState,
            metadata: activityLog.metadata,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(and(inArray(activityLog.orderId, revisionIds), eq(activityLog.action, "order.in_design")))
          .orderBy(desc(activityLog.createdAt))
      : Promise.resolve([]),
    revisionIds.length
      ? tx
          .select({ orderId: assets.orderId, createdAt: assets.createdAt })
          .from(assets)
          .where(and(inArray(assets.orderId, revisionIds), eq(assets.type, "submission"), isNull(assets.deletedAt)))
      : Promise.resolve([]),
    ])),
    sameBuyerSiblings(user, rows),
    togetherWaitingNotes(user, rows),
  ]);
  // Ready for QC: the newest portrait version is newer than the last send-back.
  const lastSendBack = new Map<string, number>();
  for (const r of vaRevisionRows) {
    if (!r.orderId || !r.fromState || !(SENT_BACK_FROM as readonly string[]).includes(r.fromState)) continue;
    const at = r.createdAt.getTime();
    if (at > (lastSendBack.get(r.orderId) ?? 0)) lastSendBack.set(r.orderId, at);
  }
  const readyForQc = new Set<string>();
  for (const s of submissionRows) {
    if (s.createdAt.getTime() > (lastSendBack.get(s.orderId) ?? 0)) readyForQc.add(s.orderId);
  }
  // A 2+ portrait order is ready only once every portrait has a file (the
  // server refuses Submit for QC before that). Only those few cards pay for
  // the pick QC uses; one portrait (most cards) skips it.
  const units = new Map<string, number>();
  for (const it of items) units.set(it.orderId, (units.get(it.orderId) ?? 0) + clampItemQuantity(it.quantity));
  const multi = [...readyForQc].filter((id) => (units.get(id) ?? 0) >= 2);
  if (multi.length) {
    const picks = await withUserContext(user, (tx) => Promise.all(multi.map((id) => loadProofFilePick(tx, id))));
    picks.forEach((pick, i) => pick.missing.length && readyForQc.delete(multi[i]));
  }

  const fig = new Map<string, number>();
  const hasNull = new Map<string, boolean>();
  const style = new Map<string, string>();
  const styles = new Map<string, string[]>();
  const title = new Map<string, string>();
  const options = new Map<string, { name: string; value: string }[]>();
  const portraits = new Map<string, BoardPortrait[]>();
  const itemCount = new Map<string, number>();
  const itemsOf = new Map<string, typeof items>();
  for (const it of items) {
    itemCount.set(it.orderId, (itemCount.get(it.orderId) ?? 0) + 1);
    const list = itemsOf.get(it.orderId);
    if (list) list.push(it);
    else itemsOf.set(it.orderId, [it]);
  }
  // Portrait lines only (add-ons have nothing to draw), in id order, the
  // primary portrait leading for the card's own style, title and options. The
  // built-in add-on words only: a designer cannot read the shop's own list.
  const optionsOf = (it: (typeof items)[number]) =>
    Array.isArray(it.options) ? (it.options as { name: string; value: string }[]) : [];
  for (const [orderId, all] of itemsOf) {
    const lines = portraitLinesOf([...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), null);
    const primary = pickPortraitItem(lines, null);
    const ordered = primary ? [primary, ...lines.filter((it) => it !== primary)] : lines;
    for (const it of lines) {
      fig.set(orderId, (fig.get(orderId) ?? 0) + (it.figureCount ?? 0));
      if (it.figureCount == null) hasNull.set(orderId, true);
    }
    for (const it of ordered) {
      if (it.style && !style.has(orderId)) style.set(orderId, it.style);
      if (it.title && !title.has(orderId)) title.set(orderId, it.title);
      if (optionsOf(it).length && !options.has(orderId)) options.set(orderId, optionsOf(it));
    }
    styles.set(orderId, distinctStyles(ordered.map((it) => it.style)));
    if (lines.length > 1) {
      let next = 1;
      portraits.set(
        orderId,
        lines.map((it) => ({
          slots: Array.from({ length: clampItemQuantity(it.quantity) }, () => next++),
          style: it.style?.trim() || null,
          figureCount: it.figureCount,
          title: it.title,
          options: optionsOf(it),
        })),
      );
    }
  }

  // Every item's personalization, not only the first item's (the options
  // above keep the first item): a two-cat order carries one name per item.
  const personalization = new Map<string, BoardCard["personalization"]>();
  const itemNo = new Map<string, number>();
  for (const it of items) {
    const n = (itemNo.get(it.orderId) ?? 0) + 1;
    itemNo.set(it.orderId, n);
    const item = (itemCount.get(it.orderId) ?? 0) > 1 ? n : null;
    const lines = personalizationOf(it.options).map((line) => ({ item, ...line }));
    if (lines.length) personalization.set(it.orderId, [...(personalization.get(it.orderId) ?? []), ...lines]);
  }

  // First reference photo per order; CDN urls resolve directly (downsized for
  // the board thumbnail), R2 via a short-lived presigned GET (private bucket).
  const firstRef = new Map<string, { url: string | null; storage: string; r2Key: string | null }>();
  for (const a of refs) if (!firstRef.has(a.orderId)) firstRef.set(a.orderId, a);
  const r2Ok = isR2Configured();
  const thumb = new Map<string, string>();
  await Promise.all(
    [...firstRef.entries()].map(async ([orderId, a]) => {
      if (a.url) thumb.set(orderId, boardThumbnailUrl(a.url));
      else if (a.storage === "r2" && a.r2Key && r2Ok) {
        try {
          thumb.set(orderId, await presignGet(a.r2Key));
        } catch {
          /* leave without a thumbnail rather than fail the board */
        }
      }
    }),
  );

  // Revision detail per in-design order — the reason a card is back in design.
  // A card can be here from a failed QC (qc_checks) OR a customer change request
  // (proofs); we surface whichever happened most recently.
  const qcFail = new Map<string, QcFailInfo>();
  const customerRevision = new Map<string, QcFailInfo>();
  const customerRevisionAt = new Map<string, Date>();
  if (revisionIds.length) {
    const qcAt = new Map<string, Date>();
    for (const f of failRows) {
      if (qcFail.has(f.orderId)) continue; // keep only the most recent fail
      qcFail.set(f.orderId, {
        reason: f.reason,
        failedItems: failedLabels(f.checklistSnapshot, f.itemResults),
        attachments: await resolveAttachmentViews(f.attachments),
      });
      qcAt.set(f.orderId, f.createdAt);
    }

    for (const r of revRows) {
      if (customerRevision.has(r.orderId)) continue; // most recent request only
      customerRevision.set(r.orderId, {
        reason: r.revisionNotes,
        failedItems: issueLabels(r.failedItems ?? []),
        annotations: r.annotations ?? [],
      });
      if (r.decidedAt) customerRevisionAt.set(r.orderId, r.decidedAt);
      // Keep only the newer of the two: if a QC fail is more recent, drop the
      // customer request from this card (and vice versa).
      const qAt = qcAt.get(r.orderId);
      if (qAt && r.decidedAt && qAt > r.decidedAt) customerRevision.delete(r.orderId);
      else qcFail.delete(r.orderId);
    }

    for (const r of vaRevisionRows) {
      if (!r.orderId) continue;
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const reason = typeof meta.revisionReason === "string" ? meta.revisionReason.trim() : "";
      if (!reason) continue;
      const existingAt = customerRevisionAt.get(r.orderId);
      if (existingAt && existingAt > r.createdAt) continue;
      const qAt = qcAt.get(r.orderId);
      if (qAt && qAt > r.createdAt) continue;
      customerRevision.set(r.orderId, { reason, failedItems: [] });
      customerRevisionAt.set(r.orderId, r.createdAt);
      qcFail.delete(r.orderId);
    }
  }

  const name = new Map<string, string>();
  if (isDesignerLike(viewerRole)) {
    for (const c of customerRows as { id: string | null; firstName: string | null }[]) {
      if (c.id) name.set(c.id, c.firstName ?? "-");
    }
  } else {
    for (const c of customerRows as { id: string; firstName: string | null; lastName: string | null }[]) {
      name.set(c.id, [c.firstName, c.lastName].filter(Boolean).join(" ") || "-");
    }
  }

  // One buyer, several orders: each card's sentence and the other orders'
  // numbers, from the siblings read above and this order's own product line.
  const lineItems = new Map<string, LineItem[]>();
  for (const it of items) {
    const line: LineItem = {
      title: it.title,
      variation: it.variation,
      sku: it.sku,
      options: it.options,
      figureCount: it.figureCount,
      style: it.style,
      quantity: it.quantity,
    };
    const list = lineItems.get(it.orderId);
    if (list) list.push(line);
    else lineItems.set(it.orderId, [line]);
  }
  const sameBuyer = new Map<string, { sentence: string; numbers: string[] }>();
  for (const o of rows) {
    const siblings = siblingsByOrder.get(o.id);
    if (!siblings?.length) continue;
    const productLine = productLineOf(lineItems.get(o.id) ?? []) || null;
    const sentence = sameBuyerSentence({ number: o.platformOrderName ?? o.platformOrderId, productLine }, siblings);
    if (sentence) sameBuyer.set(o.id, { sentence, numbers: siblings.map((x) => x.number) });
  }

  // The newest style note per order, only while that designer still holds it.
  const styleNote = new Map<string, string>();
  const holderOf = new Map(rows.map((o) => [o.id, o.assignedDesignerId]));
  for (const r of styleNoteRows) {
    if (!r.orderId || styleNote.has(r.orderId)) continue;
    const meta = (r.metadata ?? {}) as { note?: unknown; designerId?: unknown };
    if (typeof meta.note === "string" && meta.designerId === holderOf.get(r.orderId)) styleNote.set(r.orderId, meta.note);
    else styleNote.set(r.orderId, "");
  }

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return rows.map((o) => ({
    orderId: o.id,
    orderNumber: o.platformOrderName ?? o.platformOrderId,
    status: o.status,
    // A designer works to their own deadline; the customer SLA is staff-facing.
    // An assignment without a due_at (legacy rows) falls back to the SLA.
    dueAt: iso(isDesignerLike(viewerRole) ? (o.assignmentDueAt ?? o.dueAt) : o.dueAt),
    orderDueAt: iso(o.dueAt),
    assignmentDueAt: iso(o.assignmentDueAt),
    figureCount: fig.get(o.id) ?? 0,
    figuresResolved: !hasNull.get(o.id),
    style: style.get(o.id) ?? null,
    styles: styles.get(o.id) ?? [],
    title: title.get(o.id) ?? null,
    options: options.get(o.id) ?? [],
    portraits: portraits.get(o.id) ?? [],
    styleNote: styleNote.get(o.id) || null,
    personalization: personalization.get(o.id) ?? [],
    notes: o.notes,
    source: o.source,
    customerName: o.customerId ? (name.get(o.customerId) ?? "-") : "-",
    thumbnailUrl: thumb.get(o.id) ?? null,
    qcFail: qcFail.get(o.id) ?? null,
    customerRevision: customerRevision.get(o.id) ?? null,
    readyForQc: o.status === "in_design" && readyForQc.has(o.id),
    urgent: !!o.urgentAt,
    urgentReason: o.urgentAt ? o.urgentReason : null,
    sameBuyer: sameBuyer.get(o.id)?.sentence ?? null,
    sameBuyerNumbers: sameBuyer.get(o.id)?.numbers ?? [],
    togetherWaiting: togetherByOrder.get(o.id) ?? null,
  }));
}

/** Labels of items the VA marked failed, from the qc_checks snapshot + results. */
function failedLabels(snapshot: unknown, results: unknown): string[] {
  const items = (snapshot as ChecklistSnapshot | null)?.items;
  if (!Array.isArray(items)) return [];
  const res = (results ?? {}) as ItemResults;
  return items.filter((it) => res[it.key] === false).map((it) => it.label);
}

export type DesignerBoard = {
  columns: {
    myQueue: BoardCard[];
    inDesign: BoardCard[];
    failedQc: BoardCard[];
    awaitingQc: BoardCard[];
    revisions: BoardCard[];
    /** Passed QC, now with the customer (approval, print, delivery): read only. */
    withCustomer: BoardCard[];
    complete: BoardCard[];
  };
  dailyEarnings: number;
  periodEarnings: number;
  earningHistory: DesignerEarningHistory[];
  /** The board owner's own timezone (their deadlines are shown in it). */
  timeZone: string;
};

export type DesignerEarningHistory = {
  id: string;
  orderId: string;
  orderNumber: string;
  style: string;
  figureCount: number;
  rate: string | null;
  amount: string | null;
  status: "blocked" | "pending" | "paid" | "voided";
  createdAt: string;
};

/** The styles an earning paid for; empty (the row just leaves it out) when unknown. */
function styleSummary(breakdown: unknown): string {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return "";
  const styles = [
    ...new Set(
      breakdown
        .map((row) => (typeof row === "object" && row ? (row as { style?: unknown }).style : null))
        .filter((style): style is string => typeof style === "string" && style.trim().length > 0),
    ),
  ];
  return styles.join(", ");
}

const BOARD_ROW_SELECT = {
  id: orders.id,
  platformOrderId: orders.platformOrderId,
  platformOrderName: orders.platformOrderName,
  status: orders.status,
  dueAt: orders.dueAt,
  assignmentDueAt: assignments.dueAt,
  assignedDesignerId: assignments.designerId,
  businessId: orders.businessId,
  customerId: orders.customerId,
  revisionCount: orders.revisionCount,
  source: orders.source,
  notes: orders.notes,
  urgentAt: orders.urgentAt,
  urgentReason: orders.urgentReason,
} as const;

type EarningRow = {
  id: string;
  orderId: string;
  orderNumber: string | null;
  fallbackOrderNumber: string;
  figureCount: number;
  rate: string;
  amount: string;
  status: DesignerEarningHistory["status"];
  breakdown: unknown;
  createdAt: Date;
};

/** Designer board for `designerId` (self, or a VA viewing ?designer=X). */
export async function getDesignerBoard(
  user: RequestUser,
  designerId?: string,
  /** Staff view: only this business's orders on the board (the switcher's selection). */
  businessId?: string,
  options: {
    /** False: no pay anywhere (0 / 0 / []). Always false for a helper, whatever is passed. */
    includeEarnings?: boolean;
    /** A helper's principal designer (session.user.helperFor). */
    helperFor?: string | null;
  } = {},
): Promise<DesignerBoard> {
  const isHelper = user.role === "helper";
  // A helper loads exactly their principal's board, nobody else's.
  if (isHelper && (!options.helperFor || (designerId && designerId !== options.helperFor))) {
    throw new Error("Not permitted");
  }
  const target = isHelper ? (options.helperFor as string) : (designerId ?? user.id);
  const includeEarnings = isHelper ? false : options.includeEarnings !== false;
  const assignedToTarget = (status: OrderRow["status"] | OrderRow["status"][]) =>
    and(
      Array.isArray(status) ? inArray(orders.status, status) : eq(orders.status, status),
      liveOrderWhere(),
      businessId ? eq(orders.businessId, businessId) : undefined,
    );

  // Speed (docs/PERF.md): one transaction is ONE connection, so "Promise.all"
  // inside it still runs query after query (the ~5 s board). The independent
  // read groups below each get their own read-only withUserContext
  // transaction (each sets its own RLS GUCs) and run side by side:
  //   1. the owner's timezone, then (if allowed) the three earnings reads;
  //   2. the live columns; 3. the capped Complete column.
  // Then enrich() fans out over two more transactions.
  const ownerPay = withUserContext(user, async (tx) => {
    // The board owner's zone first: "Today" (earnings) is their day, like every deadline they see.
    const [profile] = await tx
      .select({ timezone: designerProfiles.timezone })
      .from(designerProfiles)
      .where(eq(designerProfiles.userId, target))
      .limit(1);
    const timeZone = isValidTimezone(profile?.timezone ?? null) ? (profile?.timezone as string) : DEFAULT_TIMEZONE;
    if (!includeEarnings) {
      return { timeZone, daily: undefined, period: undefined, earningRows: [] as EarningRow[] };
    }
    const dayStart = startOfDayInTimezone(new Date(), timeZone);
    const [[daily], [period], earningRows] = await Promise.all([
      tx
        .select({ total: sql<string>`coalesce(sum(${earnings.amount}), 0)` })
        .from(earnings)
        .where(and(eq(earnings.designerId, target), inArray(earnings.status, ["pending", "paid"]), gte(earnings.createdAt, dayStart))),
      tx
        .select({ total: sql<string>`coalesce(sum(${earnings.amount}), 0)` })
        .from(earnings)
        .where(and(eq(earnings.designerId, target), inArray(earnings.status, ["pending", "paid"]), eq(earnings.period, currentPeriod()))),
      tx
        .select({
          id: earnings.id,
          orderId: earnings.orderId,
          orderNumber: orders.platformOrderName,
          fallbackOrderNumber: orders.platformOrderId,
          figureCount: earnings.figureCount,
          rate: earnings.rate,
          amount: earnings.amount,
          status: earnings.status,
          breakdown: earnings.breakdown,
          createdAt: earnings.createdAt,
        })
        .from(earnings)
        .innerJoin(orders, eq(orders.id, earnings.orderId))
        .where(eq(earnings.designerId, target))
        .orderBy(desc(earnings.createdAt))
        .limit(20) as Promise<EarningRow[]>,
    ]);
    return { timeZone, daily, period, earningRows };
  });

  const activeP = withUserContext(user, (tx) =>
    tx
      .select(BOARD_ROW_SELECT)
      .from(orders)
      .innerJoin(
        assignments,
        and(eq(assignments.orderId, orders.id), eq(assignments.active, true), eq(assignments.designerId, target)),
      )
      .where(assignedToTarget(["ready_to_assign", "in_design", "awaiting_qc", ...WITH_CUSTOMER_STATUSES])) as Promise<OrderRow[]>,
  );
  const completeP = withUserContext(user, (tx) =>
    tx
      .select(BOARD_ROW_SELECT)
      .from(orders)
      .innerJoin(
        assignments,
        and(eq(assignments.orderId, orders.id), eq(assignments.active, true), eq(assignments.designerId, target)),
      )
      .where(
        and(
          assignedToTarget("complete"),
          gte(orders.updatedAt, sql`now() - interval '1 day' * ${COMPLETE_COLUMN_WINDOW_DAYS}`),
        ),
      )
      .orderBy(desc(orders.updatedAt))
      .limit(COMPLETE_COLUMN_MAX) as Promise<OrderRow[]>,
  );

  {
    const [activeRows, completeRows] = await Promise.all([activeP, completeP]);
    const { timeZone, daily, period, earningRows } = await ownerPay;
    const rows = [...activeRows, ...completeRows];
    const cards = await enrich(user, rows);
    const meta = new Map(rows.map((r) => [r.id, r]));
    // "Urgent, then soonest deadline first": every live column puts URGENT
    // cards on top, then sorts by the date the viewer is shown (undated cards
    // last). Complete keeps most-recent-first.
    const byDue = (a: BoardCard, b: BoardCard) =>
      Number(b.urgent) - Number(a.urgent) ||
      (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);
    const pick = (pred: (r: OrderRow) => boolean) => cards.filter((c) => pred(meta.get(c.orderId)!)).sort(byDue);

    return {
      columns: {
        myQueue: pick((r) => r.status === "ready_to_assign"),
        inDesign: pick((r) => r.status === "in_design" && r.revisionCount === 0),
        failedQc: pick((r) => r.status === "in_design" && !!cards.find((c) => c.orderId === r.id)?.qcFail),
        awaitingQc: pick((r) => r.status === "awaiting_qc"),
        revisions: pick((r) => {
          const card = cards.find((c) => c.orderId === r.id);
          return r.status === "in_design" && r.revisionCount > 0 && !card?.qcFail;
        }),
        // After a QC pass the order is out of the designer's hands until it
        // completes; it stays visible here (quiet, no countdown) so a pass
        // never looks like the card vanished.
        withCustomer: pick((r) => (WITH_CUSTOMER_STATUSES as readonly string[]).includes(r.status)),
        complete: cards.filter((c) => meta.get(c.orderId)!.status === "complete"),
      },
      timeZone,
      dailyEarnings: Number(daily?.total ?? 0),
      periodEarnings: Number(period?.total ?? 0),
      earningHistory: earningRows.map((earning) => ({
        id: earning.id,
        orderId: earning.orderId,
        orderNumber: earning.orderNumber ?? earning.fallbackOrderNumber,
        style: styleSummary(earning.breakdown),
        figureCount: earning.figureCount,
        rate: earning.rate,
        amount: earning.amount,
        status: earning.status,
        createdAt: earning.createdAt.toISOString(),
      })),
    };
  }
}
