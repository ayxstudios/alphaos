// Orders that live outside AlphaOS, and products AlphaOS has not indexed yet
// (docs/trello-transition.md).
//
//   Legacy stub    A buyer email that matches no order becomes a stub order
//                  (source 'legacy', status awaiting_details) holding what was
//                  parsed, with the thread attached to it, plus ONE card:
//                  "Order not in AlphaOS yet. Check it on Trello, then confirm
//                  the details here." Confirming runs the normal
//                  complete-details path, so the order enters assignment like
//                  any other. Repeated mail for the same order attaches to the
//                  same stub.
//   New product    An order whose product matches no style gets an unmapped
//                  catalog row (auto_created, no designer, AI designer off)
//                  and ONE card per product: "New product: <title>. Pick who
//                  draws it." Picking saves the mapping (the designer gets the
//                  style), so the next order of that product routes itself.
//
// Nothing here is a hardcoded product list: the catalog is the styles table.

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { withSystemContext, withUserContext, type RequestUser, type Tx } from "@/lib/db";
import {
  activityLog,
  assignments,
  customers,
  designerBusinesses,
  designerProfiles,
  exceptions,
  messages,
  orders,
  shops,
  styles,
  users,
} from "@/lib/db/schema";
import { describeStyleMatch, listBusinessStyles } from "@/lib/designers/styles";
import { completeOrderDetailsCore, emailProblem, splitName } from "@/lib/orders/complete-details";

import { openExceptionTx } from "./exceptions";

export const LEGACY_CARD_TEXT = "Order not in AlphaOS yet. Check it on Trello, then confirm the details here.";
const EXCERPT_CHARS = 400;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type LegacyRef = { orderNumber: string | null; email: string | null; name: string | null };

/** "Name <a@b.com>" or "a@b.com" into an email and, when present, a name. */
export function parseSender(address: string | null | undefined): { email: string | null; name: string | null } {
  const raw = (address ?? "").trim();
  const m = raw.match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/);
  const email = (m ? m[2] : raw).trim().toLowerCase();
  const name = m?.[1]?.trim() || null;
  return { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null, name };
}

/**
 * The order number a buyer mentions: "order #3912345678", "Order PC31972",
 * "receipt 1234567890". Null when there is none (a plain "where is my
 * portrait?" from someone we cannot find).
 */
export function parseOrderNumber(subject: string | null | undefined, body: string | null | undefined): string | null {
  const text = `${subject ?? ""}\n${(body ?? "").slice(0, 4000)}`;
  const m =
    text.match(/\b(?:order|receipt|purchase)\s*(?:number|no\.?|id|ref(?:erence)?)?\s*[:#]?\s*#?\s*([A-Z]{0,3}\d{4,12})\b/i) ??
    text.match(/#\s*([A-Z]{0,3}\d{5,12})\b/);
  return m ? m[1].toUpperCase() : null;
}

export function parseLegacyRef(input: { address: string | null; subject: string | null; body: string | null }): LegacyRef {
  const from = parseSender(input.address);
  return { orderNumber: parseOrderNumber(input.subject, input.body), email: from.email, name: from.name };
}

function excerptOf(text: string | null | undefined): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT_CHARS ? clean.slice(0, EXCERPT_CHARS) : clean;
}

// ---------------------------------------------------------------------------
// Legacy stub
// ---------------------------------------------------------------------------

export type LegacyStubResult = { orderId: string; exceptionId: string; createdOrder: boolean; createdCard: boolean };

async function pickShop(tx: Tx, businessId: string): Promise<string | null> {
  const [shop] = await tx
    .select({ id: shops.id })
    .from(shops)
    .where(and(eq(shops.businessId, businessId), eq(shops.active, true)))
    .orderBy(sql`case when ${shops.platform} = 'etsy' then 0 else 1 end`, asc(shops.createdAt))
    .limit(1);
  return shop?.id ?? null;
}

/** An existing, still unconfirmed legacy stub this message belongs to. */
async function findOpenStub(
  tx: Tx,
  input: { businessId: string; orderNumber: string | null; threadId: string | null; email: string | null },
): Promise<string | null> {
  const stubWhere = and(eq(orders.businessId, input.businessId), eq(orders.source, "legacy"), eq(orders.status, "awaiting_details"));
  if (input.orderNumber) {
    const [row] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(stubWhere, eq(orders.platformOrderName, input.orderNumber)))
      .limit(1);
    if (row) return row.id;
  }
  if (input.threadId) {
    const [row] = await tx
      .select({ id: orders.id })
      .from(messages)
      .innerJoin(orders, eq(orders.id, messages.orderId))
      .where(and(stubWhere, eq(messages.gmailThreadId, input.threadId)))
      .limit(1);
    if (row) return row.id;
  }
  if (input.email) {
    const [row] = await tx
      .select({ id: orders.id })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(stubWhere, eq(customers.email, input.email)))
      .orderBy(desc(orders.createdAt))
      .limit(1);
    if (row) return row.id;
  }
  return null;
}

/**
 * Turn an unmatched inbound message into (or attach it to) a legacy stub order
 * and make sure exactly one glance-clear card is open for it. Idempotent: a
 * message already attached to an order is left alone, and a second email for
 * the same legacy order attaches to the same stub and card. Runs in the
 * caller's transaction. Returns null when the message does not exist or the
 * business has no shop to hang the stub on.
 */
export async function ensureLegacyStub(tx: Tx, messageId: string): Promise<LegacyStubResult | null> {
  const [msg] = await tx
    .select({
      id: messages.id,
      businessId: messages.businessId,
      orderId: messages.orderId,
      address: messages.address,
      subject: messages.subject,
      body: messages.body,
      threadId: messages.gmailThreadId,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .for("update");
  if (!msg || msg.orderId) return null;

  const ref = parseLegacyRef(msg);
  let orderId = await findOpenStub(tx, {
    businessId: msg.businessId,
    orderNumber: ref.orderNumber,
    threadId: msg.threadId,
    email: ref.email,
  });
  let createdOrder = false;

  if (!orderId) {
    const shopId = await pickShop(tx, msg.businessId);
    if (!shopId) return null;
    let customerId: string | null = null;
    if (ref.email) {
      const [first, last] = splitName(ref.name ?? undefined);
      await tx
        .insert(customers)
        .values({ businessId: msg.businessId, email: ref.email, firstName: first, lastName: last })
        .onConflictDoNothing({ target: [customers.businessId, customers.email] });
      const [c] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.businessId, msg.businessId), eq(customers.email, ref.email)));
      customerId = c?.id ?? null;
    }
    const platformOrderId = ref.orderNumber ? `legacy-${ref.orderNumber}` : `legacy-${msg.threadId ?? msg.id}`;
    const [inserted] = await tx
      .insert(orders)
      .values({
        businessId: msg.businessId,
        shopId,
        customerId,
        platformOrderId,
        platformOrderName: ref.orderNumber,
        source: "legacy",
        status: "awaiting_details",
        needsReview: true,
        uploadToken: randomUUID(),
        rawImport: {
          legacy: {
            orderNumber: ref.orderNumber,
            buyerEmail: ref.email,
            buyerName: ref.name,
            subject: msg.subject,
            snippet: excerptOf(msg.body),
            firstMessageId: msg.id,
          },
        },
      })
      .onConflictDoNothing({ target: [orders.shopId, orders.platformOrderId] })
      .returning({ id: orders.id });
    if (inserted) {
      orderId = inserted.id;
      createdOrder = true;
      await tx.insert(activityLog).values({
        businessId: msg.businessId,
        orderId,
        actorId: null,
        action: "agent.legacy_stub_created",
        metadata: { messageId: msg.id, orderNumber: ref.orderNumber, from: ref.email },
      });
    } else {
      const [existing] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.shopId, shopId), eq(orders.platformOrderId, platformOrderId)));
      if (!existing) throw new Error("ensureLegacyStub: conflict but no order found");
      orderId = existing.id;
    }
  }

  // Attach this message and any other unattached message in its thread.
  await tx
    .update(messages)
    .set({ orderId })
    .where(
      and(
        eq(messages.businessId, msg.businessId),
        isNull(messages.orderId),
        msg.threadId ? sql`(${messages.id} = ${msg.id} or ${messages.gmailThreadId} = ${msg.threadId})` : eq(messages.id, msg.id),
      ),
    );

  const opened = await openExceptionTx(tx, {
    businessId: msg.businessId,
    orderId,
    kind: "legacy_order",
    summary: LEGACY_CARD_TEXT,
    detail: {
      from: ref.email ?? msg.address ?? "unknown sender",
      buyerName: ref.name,
      orderNumber: ref.orderNumber,
      subject: msg.subject,
      excerpt: excerptOf(msg.body),
      messageIds: [msg.id],
    },
  });
  if (opened.created) {
    await tx.insert(activityLog).values({
      businessId: msg.businessId,
      orderId,
      actorId: null,
      action: "agent.exception_opened",
      metadata: { exceptionId: opened.id, kind: "legacy_order" },
    });
  } else {
    await tx
      .update(exceptions)
      .set({
        detail: sql`jsonb_set(${exceptions.detail}, '{messageIds}', coalesce(${exceptions.detail}->'messageIds', '[]'::jsonb) || to_jsonb(${msg.id}::text))`,
      })
      .where(eq(exceptions.id, opened.id));
  }
  return { orderId: orderId as string, exceptionId: opened.id, createdOrder, createdCard: opened.created };
}

export type ConfirmLegacyInput = {
  exceptionId: string;
  productTitle?: string;
  style: string;
  figureCount: number | null;
  productType: "digital" | "physical";
  dueAt?: string;
  customerName?: string;
  customerEmail?: string;
  notes?: string;
};

/**
 * The card's confirm form: upgrade the stub to a normal order through the same
 * complete-details path a VA uses (so it lands in awaiting_photos or
 * ready_to_assign and auto-assign runs), then resolve the card.
 */
export async function confirmLegacyOrder(
  user: RequestUser,
  input: ConfirmLegacyInput,
): Promise<{ ok: true; orderId: string; toStatus: string } | { ok: false; message: string }> {
  if (!input.style?.trim()) return { ok: false, message: "Pick the product style first." };
  if (!input.dueAt?.trim()) return { ok: false, message: "Set the due date first." };
  const [card] = await withSystemContext((tx) =>
    tx.select().from(exceptions).where(eq(exceptions.id, input.exceptionId)).limit(1),
  );
  if (!card || card.kind !== "legacy_order" || !card.orderId) return { ok: false, message: "That card no longer exists." };
  if (card.status !== "open") return { ok: false, message: "Someone already confirmed this one." };
  const badEmail = emailProblem(input.customerEmail);
  if (badEmail) return { ok: false, message: badEmail };

  const res = await completeOrderDetailsCore(
    user,
    {
      orderId: card.orderId,
      figureCount: input.figureCount,
      style: input.style,
      productTitle: input.productTitle,
      productType: input.productType,
      notes: input.notes,
      dueAt: input.dueAt,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
    },
    (fn) => withUserContext(user, fn),
    { expectedStatus: "awaiting_details", via: "legacy_confirm" },
  );
  if (!res.ok) return res;
  await withSystemContext(async (tx) => {
    await tx.update(orders).set({ needsReview: false }).where(eq(orders.id, card.orderId as string));
    await tx
      .update(exceptions)
      .set({ status: "resolved", resolvedAt: sql`now()`, resolvedBy: user.id, resolutionNote: "Confirmed from Trello details" })
      .where(and(eq(exceptions.id, card.id), eq(exceptions.status, "open")));
    await tx.insert(activityLog).values({
      businessId: card.businessId,
      orderId: card.orderId,
      actorId: user.id,
      action: "legacy.confirmed",
      metadata: { exceptionId: card.id, style: input.style },
    });
  });
  return { ok: true, orderId: res.orderId, toStatus: res.toStatus };
}

// ---------------------------------------------------------------------------
// Unindexed products
// ---------------------------------------------------------------------------

/** "Custom Pet Portrait | Digital Download, Gift for Dog Lover" into a short style name. */
export function styleNameFromTitle(title: string): string {
  const first = title.split(/\s[|\-–]\s|\|/)[0] ?? title;
  const clean = first.replace(/\s+/g, " ").trim();
  return (clean.length > 60 ? clean.slice(0, 60).replace(/\s\S*$/, "") : clean) || "New product";
}

export type CatalogHit = { id: string; name: string; autoCreated: boolean; via: "sku" | "title" };

/** The catalog row that already covers this product, by exact SKU or title rule. Never the default fallback. */
export async function findCatalogStyle(
  tx: Tx,
  businessId: string,
  input: { title: string | null; sku?: string | null },
): Promise<CatalogHit | null> {
  const list = await listBusinessStyles(tx, businessId);
  const match = describeStyleMatch(input.title, input.sku ?? null, list);
  if (!match.styleId || (match.via !== "sku" && match.via !== "title")) return null;
  const [row] = await tx
    .select({ id: styles.id, name: styles.name, autoCreated: styles.autoCreated })
    .from(styles)
    .where(eq(styles.id, match.styleId));
  return row ? { ...row, via: match.via } : null;
}

/**
 * Register a product AlphaOS has never seen: an unmapped catalog row (no
 * designer, AI designer off) matched by the exact listing title, and one
 * "New product" card per product. A second order for the same product joins
 * the card instead of opening another. Idempotent.
 */
export async function registerUnindexedProduct(
  tx: Tx,
  input: { businessId: string; shopId: string; orderId: string; title: string; sku?: string | null },
): Promise<{ styleId: string; styleName: string; exceptionId: string; createdStyle: boolean; createdCard: boolean }> {
  const title = input.title.trim();
  let hit = await findCatalogStyle(tx, input.businessId, { title, sku: input.sku });
  let createdStyle = false;
  if (!hit) {
    const base = styleNameFromTitle(title);
    let name = base;
    for (let n = 2; n < 20; n++) {
      const [taken] = await tx
        .select({ id: styles.id })
        .from(styles)
        .where(and(eq(styles.businessId, input.businessId), sql`lower(${styles.name}) = ${name.toLowerCase()}`))
        .limit(1);
      if (!taken) break;
      name = `${base} (${n})`;
    }
    const sku = input.sku?.trim();
    const [row] = await tx
      .insert(styles)
      .values({
        businessId: input.businessId,
        name,
        titleMatches: [title],
        skuMatches: sku ? [sku] : [],
        aiDesignerEnabled: false,
        autoCreated: true,
        listingTitle: title,
      })
      .returning({ id: styles.id, name: styles.name });
    hit = { id: row.id, name: row.name, autoCreated: true, via: "title" };
    createdStyle = true;
    // A shop that keeps its own style list must offer the new one to the VA form.
    await tx
      .update(shops)
      .set({ styles: sql`array_append(${shops.styles}, ${name})` })
      .where(and(eq(shops.id, input.shopId), sql`coalesce(array_length(${shops.styles}, 1), 0) > 0`));
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: null,
      action: "agent.product_registered",
      metadata: { styleId: row.id, styleName: name, title },
    });
  }

  // One open card per product; more orders join it.
  const [existing] = await tx
    .select({ id: exceptions.id })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.businessId, input.businessId),
        eq(exceptions.kind, "new_product"),
        eq(exceptions.status, "open"),
        sql`${exceptions.detail}->>'styleId' = ${hit.id}`,
      ),
    )
    .limit(1);
  if (existing) {
    await tx
      .update(exceptions)
      .set({
        detail: sql`jsonb_set(${exceptions.detail}, '{orderIds}', (case when ${exceptions.detail}->'orderIds' ? ${input.orderId} then ${exceptions.detail}->'orderIds' else coalesce(${exceptions.detail}->'orderIds', '[]'::jsonb) || to_jsonb(${input.orderId}::text) end))`,
      })
      .where(eq(exceptions.id, existing.id));
    return { styleId: hit.id, styleName: hit.name, exceptionId: existing.id, createdStyle, createdCard: false };
  }
  const opened = await openExceptionTx(tx, {
    businessId: input.businessId,
    orderId: input.orderId,
    kind: "new_product",
    summary: `New product: ${title}. Pick who draws it.`,
    detail: { styleId: hit.id, styleName: hit.name, title, sku: input.sku ?? null, orderIds: [input.orderId] },
  });
  if (opened.created) {
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: null,
      action: "agent.exception_opened",
      metadata: { exceptionId: opened.id, kind: "new_product" },
    });
  }
  return { styleId: hit.id, styleName: hit.name, exceptionId: opened.id, createdStyle, createdCard: opened.created };
}

export type DesignerChoice = { id: string; name: string; openCount: number; styles: string[] };

/** This business's human designers with the work each has open right now. */
export async function listDesignerChoices(tx: Tx, businessId: string): Promise<DesignerChoice[]> {
  const rows = await tx
    .select({ id: users.id, name: users.name, email: users.email, styles: designerProfiles.styles })
    .from(designerBusinesses)
    .innerJoin(users, and(eq(users.id, designerBusinesses.userId), eq(users.active, true), eq(users.role, "designer")))
    .innerJoin(designerProfiles, eq(designerProfiles.userId, users.id))
    .where(and(eq(designerBusinesses.businessId, businessId), eq(designerProfiles.isAgent, false)));
  if (!rows.length) return [];
  const counts = await tx
    .select({ designerId: assignments.designerId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .innerJoin(orders, eq(orders.id, assignments.orderId))
    .where(
      and(
        eq(assignments.active, true),
        inArray(assignments.designerId, rows.map((r) => r.id)),
        inArray(orders.status, ["in_design", "awaiting_qc"]),
      ),
    )
    .groupBy(assignments.designerId);
  const open = new Map(counts.map((c) => [c.designerId, Number(c.n)]));
  return rows
    .map((r) => ({ id: r.id, name: r.name || r.email.split("@")[0], openCount: open.get(r.id) ?? 0, styles: r.styles ?? [] }))
    .sort((a, b) => a.openCount - b.openCount || a.name.localeCompare(b.name));
}

/**
 * The card's designer picker: give the designer this style (so auto-assign
 * routes every future order of the product to them), take the catalog row out
 * of "unmapped", and resolve the card. Orders waiting on the product are
 * picked up by the next agent tick.
 */
export async function pickDesignerForProduct(
  user: RequestUser,
  input: { exceptionId: string; designerId: string },
): Promise<{ ok: true; styleName: string; designerName: string } | { ok: false; message: string }> {
  return withSystemContext(async (tx) => {
    const [card] = await tx.select().from(exceptions).where(eq(exceptions.id, input.exceptionId)).limit(1);
    if (!card || card.kind !== "new_product") return { ok: false as const, message: "That card no longer exists." };
    if (card.status !== "open") return { ok: false as const, message: "Someone already picked a designer." };
    const detail = card.detail as { styleId?: string };
    if (!detail.styleId) return { ok: false as const, message: "That card has no product on it." };
    const choices = await listDesignerChoices(tx, card.businessId);
    const chosen = choices.find((c) => c.id === input.designerId);
    if (!chosen) return { ok: false as const, message: "Pick one of this business's designers." };
    const [style] = await tx.select().from(styles).where(eq(styles.id, detail.styleId)).for("update");
    if (!style) return { ok: false as const, message: "That product is gone." };

    await tx
      .update(designerProfiles)
      .set({
        styles: sql`case when ${style.name} = any(coalesce(${designerProfiles.styles}, '{}'::text[])) then ${designerProfiles.styles} else array_append(coalesce(${designerProfiles.styles}, '{}'::text[]), ${style.name}) end`,
      })
      .where(eq(designerProfiles.userId, chosen.id));
    await tx.update(styles).set({ autoCreated: false }).where(eq(styles.id, style.id));
    await tx
      .update(exceptions)
      .set({ status: "resolved", resolvedAt: sql`now()`, resolvedBy: user.id, resolutionNote: `Designer: ${chosen.name}` })
      .where(eq(exceptions.id, card.id));
    await tx.insert(activityLog).values({
      businessId: card.businessId,
      orderId: card.orderId,
      actorId: user.id,
      action: "product.designer_picked",
      metadata: { styleId: style.id, styleName: style.name, designerId: chosen.id },
    });
    return { ok: true as const, styleName: style.name, designerName: chosen.name };
  });
}
