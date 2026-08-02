import { and, desc, eq, inArray } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { customers, messages, orders } from "@/lib/db/schema";
import { TEMPLATE_META } from "./templates";

export type OutboxItem = {
  messageId: string;
  orderId: string | null;
  platformOrderId: string | null;
  status: "draft" | "failed";
  templateKey: string | null;
  templateLabel: string | null;
  toAddress: string | null;
  customerName: string | null;
  subject: string;
  body: string;
  error: string | null;
  createdAt: string; // ISO
};

/**
 * The VA outbox: outbound customer emails awaiting approval (`draft`) plus any
 * that failed to send (`failed`) and need attention. Staff-scoped by RLS. When a
 * business is selected, scoped to it; otherwise across all visible businesses.
 */
export async function getOutbox(
  user: RequestUser,
  opts: { businessId: string | null },
): Promise<OutboxItem[]> {
  return withUserContext(user, async (tx) => {
    const bizFilter =
      opts.businessId && opts.businessId !== "all"
        ? eq(messages.businessId, opts.businessId)
        : undefined;

    const rows = await tx
      .select({
        id: messages.id,
        orderId: messages.orderId,
        status: messages.status,
        templateKey: messages.templateKey,
        address: messages.address,
        subject: messages.subject,
        body: messages.body,
        error: messages.error,
        createdAt: messages.createdAt,
        customerId: messages.customerId,
        platformOrderId: orders.platformOrderId,
      })
      .from(messages)
      .leftJoin(orders, eq(orders.id, messages.orderId))
      .where(
        bizFilter
          ? and(eq(messages.direction, "outbound"), inArray(messages.status, ["draft", "failed"]), bizFilter)
          : and(eq(messages.direction, "outbound"), inArray(messages.status, ["draft", "failed"])),
      )
      .orderBy(desc(messages.createdAt))
      .limit(200);

    // Names (staff read the full customers table).
    const custIds = rows.map((r) => r.customerId).filter((x): x is string => !!x);
    const nameById = new Map<string, string>();
    if (custIds.length) {
      for (const c of await tx
        .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName })
        .from(customers)
        .where(inArray(customers.id, custIds))) {
        nameById.set(c.id, [c.firstName, c.lastName].filter(Boolean).join(" ") || "—");
      }
    }

    return rows.map((r) => ({
      messageId: r.id,
      orderId: r.orderId,
      platformOrderId: r.platformOrderId ?? null,
      status: r.status as "draft" | "failed",
      templateKey: r.templateKey,
      templateLabel: r.templateKey ? TEMPLATE_META[r.templateKey as keyof typeof TEMPLATE_META]?.label ?? null : null,
      toAddress: r.address,
      customerName: r.customerId ? nameById.get(r.customerId) ?? null : null,
      subject: r.subject ?? "",
      body: r.body ?? "",
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

/** Count of pending drafts, for the queue tab badge. */
export async function getOutboxCount(
  user: RequestUser,
  opts: { businessId: string | null },
): Promise<number> {
  return withUserContext(user, async (tx) => {
    const bizFilter =
      opts.businessId && opts.businessId !== "all"
        ? eq(messages.businessId, opts.businessId)
        : undefined;
    const base = and(eq(messages.direction, "outbound"), eq(messages.status, "draft"));
    const rows = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(bizFilter ? and(base, bizFilter) : base);
    return rows.length;
  });
}
