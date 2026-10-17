// Invoiced add-ons (Yousif 2026-10-17: "For all clean slating print and ship, or
// custom invoiced orders should also be marked off the Etsy dashboard like it
// would a normal order. Only difference should be that we'll actually ship out a
// real Product for that"). When a buyer pays a custom invoice the agent made on
// her order (an upgrade to a framed print, a poster of her portrait), Etsy sends
// a new receipt for a private listing AlphaOS has never seen. It was taken for a
// new portrait: CPS 4202590183 (Jennifer's framed poster) reached the owners as
// "New product: ... Pick who draws it", Perfetta 4205391826 sat on "could not
// resolve figure count" and 4202684757 waited on photos.
//
// The agent mirrors every invoice it makes into activity_log as one
// `agent.invoice_made` row (ai-employee-agent lib/invoice-hints.js): order_id =
// the order it adds to, metadata { hintKey, match, listingId, lineTitle, email,
// parentReceiptId, what, physical, kind }. A paid receipt that matches a hint is
// linked to that order (fulfillment_only): no designer, no photo ask, no product
// card; the print road ships it with the order's approved art. match "listing" =
// the Etsy listing id; match "title+email" = a Shopify invoice, its line title
// AND the buyer's email. kind "new" (a genuinely new piece invoiced on her old
// order) is never linked: normal intake.
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, customers, exceptions, orderItems, orders, shops, styles } from "@/lib/db/schema";
import { autoResolveTx, linkAddonTx, type AddonCandidate } from "./limbo";

const DAY = 24 * 3_600_000;
/** How far back a hint can match a paid receipt (an invoice is paid within days, rarely weeks). */
export const INVOICE_HINT_DAYS = 120;
/** Statuses before any design work: the only ones an invoiced add-on is ever moved out of. */
export const PRE_DESIGN_STATUSES = ["awaiting_details", "awaiting_photos", "ready_to_assign", "triage"] as const;
/** Cards an invoiced add-on never needs: nothing to draw, no photos to ask for. */
const ADDON_CLEARS = ["new_product", "intake_unparsed", "addon_only", "photo_count_mismatch", "no_eligible_designer", "stuck_order"];

export type InvoiceHint = {
  id: string;
  /** The order the invoice adds to (null when it was not in AlphaOS when the invoice was made). */
  parentOrderId: string | null;
  hintKey: string;
  match: "listing" | "title+email";
  listingId: string | null;
  lineTitle: string | null;
  email: string | null;
  parentReceiptId: string;
  what: string;
  physical: boolean;
  kind: "addon" | "new";
  createdAt: Date;
};

/** What a paid order offers to match a hint on. */
export type HintTarget = { listingIds: string[]; lineTitles: string[]; email: string | null };

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** One activity_log row as a hint, or null when it is not one the intake can use. Pure. */
export function hintFromRow(row: { id: string; orderId: string | null; metadata: unknown; createdAt: Date }): InvoiceHint | null {
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  const match = m.match === "listing" || m.match === "title+email" ? m.match : null;
  const parentReceiptId = String(m.parentReceiptId ?? "").replace(/^#/, "").trim();
  if (!match || !m.hintKey || !parentReceiptId) return null;
  return {
    id: row.id,
    parentOrderId: row.orderId ?? null,
    hintKey: String(m.hintKey),
    match,
    listingId: m.listingId == null || m.listingId === "" ? null : String(m.listingId),
    lineTitle: m.lineTitle == null || m.lineTitle === "" ? null : String(m.lineTitle),
    email: m.email == null || m.email === "" ? null : String(m.email),
    parentReceiptId,
    what: String(m.what ?? m.lineTitle ?? ""),
    physical: !!m.physical,
    kind: m.kind === "new" ? "new" : "addon",
    createdAt: row.createdAt,
  };
}

/**
 * The invoice this order was paid on: the newest hint that matches it. A match
 * on a "new piece" invoice means normal intake (null). Pure.
 */
export function pickInvoiceHint(target: HintTarget, hints: InvoiceHint[]): InvoiceHint | null {
  const listings = new Set(target.listingIds.map((l) => String(l).trim()).filter(Boolean));
  const titles = new Set(target.lineTitles.map(norm).filter(Boolean));
  const email = norm(target.email);
  const newestFirst = [...hints].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const h of newestFirst) {
    const hit =
      (h.match === "listing" && !!h.listingId && listings.has(h.listingId)) ||
      (h.match === "title+email" && !!email && norm(h.email) === email && !!h.lineTitle && titles.has(norm(h.lineTitle)));
    if (hit) return h.kind === "addon" ? h : null;
  }
  return null;
}

/** The business's recent invoice hints (newest first). */
export async function loadInvoiceHints(tx: Tx, businessId: string, now: Date): Promise<InvoiceHint[]> {
  const rows = await tx
    .select({ id: activityLog.id, orderId: activityLog.orderId, metadata: activityLog.metadata, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.businessId, businessId),
        eq(activityLog.action, "agent.invoice_made"),
        gte(activityLog.createdAt, new Date(now.getTime() - INVOICE_HINT_DAYS * DAY)),
      ),
    )
    .orderBy(desc(activityLog.createdAt));
  return rows.map(hintFromRow).filter((h): h is InvoiceHint => !!h);
}

/** Etsy listing ids on a stored receipt (raw_import.transactions[].listing_id). Pure. */
export function receiptListingIds(rawImport: unknown): string[] {
  const txs = (rawImport as { transactions?: { listing_id?: unknown }[] } | null)?.transactions;
  return Array.isArray(txs) ? txs.map((t) => (t?.listing_id == null ? "" : String(t.listing_id))).filter(Boolean) : [];
}

/** What one order offers to match on: listing ids, line titles, the buyer's email. */
async function targetOf(tx: Tx, orderId: string): Promise<{ target: HintTarget; linkedBefore: boolean } | null> {
  const [o] = await tx
    .select({
      rawImport: orders.rawImport,
      email: customers.email,
      linkedBefore: sql<boolean>`exists (select 1 from activity_log l where l.order_id = ${orders.id} and l.action = 'agent.invoice_addon_linked')`,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId));
  if (!o) return null;
  const items = await tx.select({ title: orderItems.title }).from(orderItems).where(eq(orderItems.orderId, orderId));
  const rawTitles = ((o.rawImport as { transactions?: { title?: string | null }[] } | null)?.transactions ?? []).map((t) => t?.title ?? "");
  return {
    target: { listingIds: receiptListingIds(o.rawImport), lineTitles: [...items.map((i) => i.title ?? ""), ...rawTitles], email: o.email ?? null },
    linkedBefore: !!o.linkedBefore,
  };
}

/**
 * The invoice hint for one order, or null. An order linked once and moved back
 * by a person is theirs: never linked again.
 */
export async function invoiceHintForOrderTx(tx: Tx, order: { id: string; businessId: string }, now: Date, hints?: InvoiceHint[]): Promise<InvoiceHint | null> {
  const list = hints ?? (await loadInvoiceHints(tx, order.businessId, now));
  if (!list.length) return null;
  const t = await targetOf(tx, order.id);
  if (!t || t.linkedBefore) return null;
  return pickInvoiceHint(t.target, list);
}

/** Pre-design orders of this business that a hint says are invoiced add-ons. */
export async function findInvoiceAddons(tx: Tx, businessId: string, now: Date): Promise<{ orderId: string; hint: InvoiceHint }[]> {
  const hints = await loadInvoiceHints(tx, businessId, now);
  if (!hints.some((h) => h.kind === "addon")) return [];
  const since = new Date(Math.min(...hints.map((h) => h.createdAt.getTime())) - 2 * DAY);
  const rows = await tx
    .select({
      id: orders.id,
      rawImport: orders.rawImport,
      email: customers.email,
      titles: sql<string[]>`coalesce((select array_agg(coalesce(i.title, '')) from order_items i where i.order_id = ${orders.id}), '{}'::text[])`,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(
        eq(orders.businessId, businessId),
        inArray(orders.status, [...PRE_DESIGN_STATUSES]),
        sql`${orders.archivedAt} is null`,
        gte(orders.createdAt, since),
        sql`not exists (select 1 from activity_log l where l.order_id = ${orders.id} and l.action = 'agent.invoice_addon_linked')`,
      ),
    );
  const out: { orderId: string; hint: InvoiceHint }[] = [];
  for (const r of rows) {
    const rawTitles = ((r.rawImport as { transactions?: { title?: string | null }[] } | null)?.transactions ?? []).map((t) => t?.title ?? "");
    const hint = pickInvoiceHint({ listingIds: receiptListingIds(r.rawImport), lineTitles: [...(r.titles ?? []), ...rawTitles], email: r.email ?? null }, hints);
    if (hint) out.push({ orderId: r.id, hint });
  }
  return out;
}

/**
 * The portrait order an invoiced add-on rides on: the hint's order, or the
 * receipt it names; an add-on of an add-on rides on the order under it.
 */
async function invoiceParent(tx: Tx, addon: { id: string; businessId: string }, hint: InvoiceHint): Promise<AddonCandidate | null> {
  let id = hint.parentOrderId;
  if (!id) {
    const [p] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.businessId, addon.businessId), eq(orders.platformOrderId, hint.parentReceiptId), ne(orders.id, addon.id)))
      .orderBy(sql`${orders.archivedAt} nulls first`, desc(orders.createdAt))
      .limit(1);
    id = p?.id ?? null;
  }
  for (let hop = 0; id && hop < 3; hop++) {
    const [link] = await tx
      .select({ parent: sql<string | null>`${activityLog.metadata}->>'parentOrderId'` })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, id), eq(activityLog.action, "agent.addon_linked")))
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    if (!link?.parent || link.parent === addon.id) break;
    id = link.parent;
  }
  if (!id || id === addon.id) return null;
  const [p] = await tx
    .select({
      id: orders.id,
      number: sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
      status: sql<string>`${orders.status}::text`,
      placedAt: orders.placedAt,
    })
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.businessId, addon.businessId)));
  return p ?? null;
}

/**
 * Catalog rows intake made up for this order's invoice listing ("New product"),
 * removed while still unclaimed: nobody picked who draws it and no order uses it.
 */
async function retireInvoiceStylesTx(tx: Tx, addon: { id: string; businessId: string }): Promise<string[]> {
  const regs = await tx
    .select({ styleId: sql<string | null>`${activityLog.metadata}->>'styleId'` })
    .from(activityLog)
    .where(and(eq(activityLog.orderId, addon.id), eq(activityLog.action, "agent.product_registered")));
  const retired: string[] = [];
  for (const { styleId } of regs) {
    if (!styleId) continue;
    const [s] = await tx
      .select({ id: styles.id, name: styles.name, autoCreated: styles.autoCreated })
      .from(styles)
      .where(and(eq(styles.id, styleId), eq(styles.businessId, addon.businessId)));
    if (!s?.autoCreated) continue;
    const [used] = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(and(eq(orderItems.businessId, addon.businessId), sql`lower(${orderItems.style}) = ${s.name.toLowerCase()}`))
      .limit(1);
    if (used) continue;
    const [otherCard] = await tx
      .select({ id: exceptions.id })
      .from(exceptions)
      .where(
        and(
          eq(exceptions.kind, "new_product"),
          eq(exceptions.status, "open"),
          sql`${exceptions.detail}->>'styleId' = ${s.id}`,
          sql`${exceptions.orderId} is distinct from ${addon.id}`,
        ),
      )
      .limit(1);
    if (otherCard) continue;
    await tx.delete(styles).where(eq(styles.id, s.id));
    await tx
      .update(shops)
      .set({ styles: sql`array_remove(${shops.styles}, ${s.name})` })
      .where(and(eq(shops.businessId, addon.businessId), sql`${s.name} = any(${shops.styles})`));
    await tx.insert(activityLog).values({
      businessId: addon.businessId,
      orderId: addon.id,
      actorId: null,
      action: "agent.product_unregistered",
      metadata: { styleId: s.id, styleName: s.name, why: "invoiced add-on, not a product" },
    });
    retired.push(s.name);
  }
  return retired;
}

export type InvoiceLinkResult = {
  parentOrderId: string | null;
  parentNumber: string;
  cleared: number;
  stylesRetired: string[];
};

/**
 * Link one paid invoice to the order it adds to (caller holds the order row):
 * fulfillment_only, a note on both orders, the product and figure cards it never
 * needed closed, the catalog row intake made up for it removed. No photo ask, no
 * designer. Nothing happens unless the order is still before design.
 */
export async function linkInvoiceAddonTx(
  tx: Tx,
  addon: { id: string; businessId: string; status: string; platformOrderId: string; platformOrderName: string | null },
  hint: InvoiceHint,
  now: Date,
): Promise<InvoiceLinkResult | null> {
  if (!(PRE_DESIGN_STATUSES as readonly string[]).includes(addon.status)) return null;
  const number = addon.platformOrderName ?? addon.platformOrderId;
  const parent = await invoiceParent(tx, addon, hint);
  const titles = (await tx.select({ title: orderItems.title }).from(orderItems).where(eq(orderItems.orderId, addon.id)))
    .map((r) => r.title ?? "")
    .filter(Boolean);
  if (parent) {
    await linkAddonTx(tx, { id: addon.id, businessId: addon.businessId, number, status: addon.status }, parent, titles.length ? titles : [hint.what]);
  } else {
    await tx
      .update(orders)
      .set({
        status: "fulfillment_only",
        updatedAt: now,
        notes: sql`concat_ws(E'\n', nullif(${orders.notes}, ''), ${`Invoiced add-on to order ${hint.parentReceiptId} (not in AlphaOS): it ships with that order's art.`}::text)`,
      })
      .where(eq(orders.id, addon.id));
  }
  const parentNumber = parent?.number ?? hint.parentReceiptId;
  await tx.insert(activityLog).values({
    businessId: addon.businessId,
    orderId: addon.id,
    actorId: null,
    action: "agent.invoice_addon_linked",
    // linkAddonTx already logged the move when there is a parent.
    ...(parent ? {} : { fromState: addon.status as typeof orders.$inferSelect.status, toState: "fulfillment_only" as const }),
    metadata: {
      hintKey: hint.hintKey,
      hintId: hint.id,
      parentOrderId: parent?.id ?? null,
      parentNumber,
      parentReceiptId: hint.parentReceiptId,
      what: hint.what,
      physical: hint.physical,
    },
  });
  const open = await tx
    .select({ id: exceptions.id, kind: exceptions.kind })
    .from(exceptions)
    .where(and(eq(exceptions.orderId, addon.id), eq(exceptions.status, "open"), inArray(exceptions.kind, ADDON_CLEARS as never[])));
  const cleared = await autoResolveTx(
    tx,
    open.map((e) => ({
      id: e.id,
      businessId: addon.businessId,
      orderId: addon.id,
      kind: String(e.kind),
      reason: `invoiced add-on to order ${parentNumber}: nothing to draw, it ships with that order's art`,
    })),
    now,
  );
  const stylesRetired = await retireInvoiceStylesTx(tx, addon);
  return { parentOrderId: parent?.id ?? null, parentNumber, cleared, stylesRetired };
}
