import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { customers, messages, orders } from "@/lib/db/schema";
import { TEMPLATE_META } from "./templates";

/** Pull the bare email out of a "Name <email>" From header. */
function parseEmail(address: string | null): string | null {
  if (!address) return null;
  const m = address.match(/<([^>]+)>/);
  const raw = (m ? m[1] : address).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

export type OutboxItem = {
  messageId: string;
  orderId: string | null;
  orderNumber: string | null;
  status: "draft" | "queued" | "failed";
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
 * The VA outbox: outbound customer emails awaiting approval (`draft`), system-
 * queued auto-send messages (`queued`), plus any that failed to send (`failed`)
 * and need attention. Staff-scoped by RLS. When a business is selected, scoped
 * to it; otherwise across all visible businesses.
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
        platformOrderName: orders.platformOrderName,
      })
      .from(messages)
      .leftJoin(orders, eq(orders.id, messages.orderId))
      .where(
        and(
          eq(messages.direction, "outbound"),
          inArray(messages.status, ["draft", "queued", "failed"]),
          isNull(messages.archivedAt),
          ...(bizFilter ? [bizFilter] : []),
        ),
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
      orderNumber: r.platformOrderName ?? r.platformOrderId ?? null,
      status: r.status as "draft" | "queued" | "failed",
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
    const base = and(
      eq(messages.direction, "outbound"),
      eq(messages.status, "draft"),
      isNull(messages.archivedAt),
    );
    const rows = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(bizFilter ? and(base, bizFilter) : base);
    return rows.length;
  });
}

/** Count of system-queued outbound emails — for pipeline health visibility. */
export async function getQueuedEmailCount(
  user: RequestUser,
  opts: { businessId: string | null },
): Promise<number> {
  return withUserContext(user, async (tx) => {
    const bizFilter =
      opts.businessId && opts.businessId !== "all"
        ? eq(messages.businessId, opts.businessId)
        : undefined;
    const rows = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "outbound"),
          eq(messages.status, "queued"),
          isNull(messages.archivedAt),
          ...(bizFilter ? [bizFilter] : []),
        ),
      );
    return rows.length;
  });
}

export type UnmatchedReply = {
  messageId: string;
  fromAddress: string | null;
  subject: string;
  body: string;
  createdAt: string; // ISO
  ageMs: number;
  /** A likely order, when the sender's email matches a known customer. */
  suggestion: { orderId: string; orderNumber: string; customerName: string } | null;
};

/**
 * Inbound replies that couldn't be threaded to an order — captured, never
 * dropped. Oldest first (longest-waiting customer = most urgent). Includes a
 * suggested order when the sender's email matches a known customer, so a VA can
 * link it in one click without us auto-guessing.
 */
export async function getUnmatchedReplies(
  user: RequestUser,
  opts: { businessId: string | null },
): Promise<UnmatchedReply[]> {
  return withUserContext(user, async (tx) => {
    const bizFilter =
      opts.businessId && opts.businessId !== "all" ? eq(messages.businessId, opts.businessId) : undefined;

    const rows = await tx
      .select({
        id: messages.id,
        businessId: messages.businessId,
        address: messages.address,
        subject: messages.subject,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "inbound"),
          isNull(messages.orderId),
          isNull(messages.archivedAt),
          ...(bizFilter ? [bizFilter] : []),
        ),
      )
      .orderBy(asc(messages.createdAt)) // oldest first — the longest wait is most urgent
      .limit(200);

    // Suggestions: sender email -> known customer -> their most recent order.
    const byEmail = new Map<string, string>(); // email -> messageId's From email key
    const emails = new Set<string>();
    for (const r of rows) {
      const e = parseEmail(r.address);
      if (e) {
        emails.add(e);
        byEmail.set(r.id, e);
      }
    }
    const suggestionByEmail = new Map<string, { orderId: string; orderNumber: string; customerName: string }>();
    if (emails.size) {
      const custs = await tx
        .select({ id: customers.id, email: customers.email, firstName: customers.firstName, lastName: customers.lastName })
        .from(customers)
        .where(inArray(customers.email, [...emails]));
      const custByEmail = new Map(custs.map((c) => [(c.email ?? "").toLowerCase(), c]));
      const custIds = custs.map((c) => c.id);
      if (custIds.length) {
        const recent = await tx
          .select({
            customerId: orders.customerId,
            orderId: orders.id,
            number: orders.platformOrderName,
            fallback: orders.platformOrderId,
            createdAt: orders.createdAt,
          })
          .from(orders)
          .where(inArray(orders.customerId, custIds))
          .orderBy(desc(orders.createdAt));
        const latestByCust = new Map<string, { orderId: string; orderNumber: string }>();
        for (const o of recent) {
          if (o.customerId && !latestByCust.has(o.customerId)) {
            latestByCust.set(o.customerId, { orderId: o.orderId, orderNumber: o.number ?? o.fallback ?? "—" });
          }
        }
        for (const [email, c] of custByEmail) {
          const latest = latestByCust.get(c.id);
          if (latest) {
            suggestionByEmail.set(email, {
              ...latest,
              customerName: [c.firstName, c.lastName].filter(Boolean).join(" ") || email,
            });
          }
        }
      }
    }

    const now = Date.now();
    return rows.map((r) => {
      const email = byEmail.get(r.id);
      return {
        messageId: r.id,
        fromAddress: r.address,
        subject: r.subject ?? "",
        body: r.body ?? "",
        createdAt: r.createdAt.toISOString(),
        ageMs: now - r.createdAt.getTime(),
        suggestion: email ? suggestionByEmail.get(email) ?? null : null,
      };
    });
  });
}

/** Count of unmatched inbound replies — for the dashboard pipeline-health signal. */
export async function getUnmatchedCount(
  user: RequestUser,
  opts: { businessId: string | null },
): Promise<number> {
  return withUserContext(user, async (tx) => {
    const bizFilter =
      opts.businessId && opts.businessId !== "all" ? eq(messages.businessId, opts.businessId) : undefined;
    const rows = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "inbound"),
          isNull(messages.orderId),
          isNull(messages.archivedAt),
          ...(bizFilter ? [bizFilter] : []),
        ),
      );
    return rows.length;
  });
}
