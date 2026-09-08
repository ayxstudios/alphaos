import { desc, eq } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { businesses, customers, orders, proofs } from "@/lib/db/schema";
import {
  DEFAULT_TEMPLATES,
  EDITABLE_TEMPLATE_KEYS,
  resolveTemplate,
  renderTemplate,
  TEMPLATE_META,
  type TemplateKey,
} from "@/lib/email/templates";
import { proofUrl, uploadUrl } from "@/lib/urls";
import type { OrderStatus } from "./transitions";

/** A blank starting point — not one of the business's saved templates. */
export const BLANK_TEMPLATE_KEY = "blank" as const;
export type ReplyTemplateChoice = TemplateKey | typeof BLANK_TEMPLATE_KEY;

export type ReplyTemplateOption = { key: ReplyTemplateChoice; label: string };

export const REPLY_TEMPLATE_OPTIONS: ReplyTemplateOption[] = [
  { key: BLANK_TEMPLATE_KEY, label: "Blank message" },
  ...EDITABLE_TEMPLATE_KEYS.map((key) => ({ key, label: TEMPLATE_META[key].label })),
];

/** The template most likely to be right for this order's current status. */
export function defaultReplyTemplate(status: OrderStatus): ReplyTemplateChoice {
  switch (status) {
    case "awaiting_photos":
      return "photo_request";
    case "awaiting_approval":
    case "approved":
      return "proof_ready_digital_single";
    case "in_design":
      return "revision_received";
    default:
      return BLANK_TEMPLATE_KEY;
  }
}

export type ReplyDraftContext = {
  orderId: string;
  businessId: string;
  businessName: string;
  orderNumber: string;
  customerFirst: string;
  customerEmail: string | null;
  status: OrderStatus;
  /** Real links when we have them; blank when the order has none yet. */
  uploadLink: string | null;
  proofLink: string | null;
};

/** Everything a reply draft needs to render — real order facts, never fabricated links. */
export async function getReplyDraftContext(user: RequestUser, orderId: string): Promise<ReplyDraftContext | null> {
  return withUserContext(user, async (tx) => {
    const [order] = await tx
      .select({
        businessId: orders.businessId,
        number: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
        status: orders.status,
        uploadToken: orders.uploadToken,
        customerEmail: customers.email,
        customerFirst: customers.firstName,
        businessName: businesses.name,
      })
      .from(orders)
      .innerJoin(businesses, eq(businesses.id, orders.businessId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(eq(orders.id, orderId));
    if (!order) return null;

    const [proof] = await tx
      .select({ token: proofs.token })
      .from(proofs)
      .where(eq(proofs.orderId, orderId))
      .orderBy(desc(proofs.createdAt))
      .limit(1);

    return {
      orderId,
      businessId: order.businessId,
      businessName: order.businessName,
      orderNumber: order.number ?? order.fallbackNumber,
      customerFirst: order.customerFirst?.trim().split(/\s+/)[0] || "there",
      customerEmail: order.customerEmail,
      status: order.status as OrderStatus,
      uploadLink: order.uploadToken ? uploadUrl(order.uploadToken) : null,
      proofLink: proof ? proofUrl(proof.token) : null,
    };
  });
}

const BLANK_BODY = (ctx: ReplyDraftContext) =>
  `Hi ${ctx.customerFirst},\n\n\n\nWarmly,\nThe ${ctx.businessName} team`;

/** Render a template (or the blank starting point) with this order's real facts. */
export async function renderReplyDraft(
  user: RequestUser,
  orderId: string,
  key: ReplyTemplateChoice,
): Promise<{ subject: string; body: string } | null> {
  const ctx = await getReplyDraftContext(user, orderId);
  if (!ctx) return null;
  if (key === BLANK_TEMPLATE_KEY) {
    return { subject: `Re: ${ctx.orderNumber}`, body: BLANK_BODY(ctx) };
  }
  return withUserContext(user, async (tx) => {
    const template = (await resolveTemplate(tx, ctx.businessId, key).catch(() => null)) ?? DEFAULT_TEMPLATES[key];
    return renderTemplate(template, {
      first_name: ctx.customerFirst,
      order_number: ctx.orderNumber,
      business_name: ctx.businessName,
      proof_link: ctx.proofLink ?? undefined,
      upload_link: ctx.uploadLink ?? undefined,
    });
  });
}
