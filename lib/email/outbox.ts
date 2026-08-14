import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { customers, emailSenderIgnores, messages, orders } from "@/lib/db/schema";
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
  businessId: string;
  fromAddress: string | null;
  subject: string;
  body: string;
  createdAt: string; // ISO
  ageMs: number;
  suppressed: boolean;
  suppressedReason: string | null;
  /** A likely order, when the sender's email matches a known customer. */
  suggestion: { orderId: string; orderNumber: string; customerName: string; reason: "sender" | "subject" } | null;
};

/**
 * Inbound replies that couldn't be threaded to an order — captured, never
 * dropped. Oldest first (longest-waiting customer = most urgent). Includes a
 * suggested order when the sender's email matches a known customer, so a VA can
 * link it in one click without us auto-guessing.
 */
export async function getUnmatchedReplies(
  user: RequestUser,
  opts: { businessId: string | null; includeSuppressed?: boolean },
): Promise<UnmatchedReply[]> {
  return withUserContext(user, async (tx) => {
    const bizFilter =
      opts.businessId && opts.businessId !== "all" ? eq(messages.businessId, opts.businessId) : undefined;
    const suppressionFilter = opts.includeSuppressed ? undefined : isNull(messages.suppressedAt);

    const rows = await tx
      .select({
        id: messages.id,
        businessId: messages.businessId,
        address: messages.address,
        subject: messages.subject,
        body: messages.body,
        createdAt: messages.createdAt,
        suppressedAt: messages.suppressedAt,
        suppressedReason: messages.suppressedReason,
      })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "inbound"),
          isNull(messages.orderId),
          isNull(messages.archivedAt),
          ...(bizFilter ? [bizFilter] : []),
          ...(suppressionFilter ? [suppressionFilter] : []),
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
    const suggestionByEmail = new Map<string, { orderId: string; orderNumber: string; customerName: string; reason: "sender" }>();
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
              reason: "sender",
            });
          }
        }
      }
    }

    const subjectTokens = new Set<string>();
    for (const r of rows) {
      for (const token of extractOrderTokens(r.subject ?? "")) subjectTokens.add(token);
    }
    const suggestionBySubject = new Map<string, { orderId: string; orderNumber: string; customerName: string; reason: "subject" }>();
    if (subjectTokens.size) {
      const subjectRows = await tx
        .select({
          id: orders.id,
          businessId: orders.businessId,
          number: orders.platformOrderName,
          fallback: orders.platformOrderId,
          firstName: customers.firstName,
          lastName: customers.lastName,
          email: customers.email,
        })
        .from(orders)
        .leftJoin(customers, eq(customers.id, orders.customerId))
        .where(
          or(
            inArray(orders.platformOrderName, [...subjectTokens]),
            inArray(orders.platformOrderId, [...subjectTokens]),
          ),
        )
        .orderBy(desc(orders.createdAt));
      for (const o of subjectRows) {
        const orderNumber = o.number ?? o.fallback ?? null;
        if (!orderNumber) continue;
        const key = `${o.businessId}:${orderNumber.toLowerCase()}`;
        if (!suggestionBySubject.has(key)) {
          suggestionBySubject.set(key, {
            orderId: o.id,
            orderNumber,
            customerName: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || "Customer",
            reason: "subject",
          });
        }
      }
    }

    const now = Date.now();
    return rows.map((r) => {
      const email = byEmail.get(r.id);
      const subjectSuggestion = extractOrderTokens(r.subject ?? "")
        .map((token) => suggestionBySubject.get(`${r.businessId}:${token.toLowerCase()}`))
        .find(Boolean) ?? null;
      return {
        messageId: r.id,
        businessId: r.businessId,
        fromAddress: r.address,
        subject: r.subject ?? "",
        body: r.body ?? "",
        createdAt: r.createdAt.toISOString(),
        ageMs: now - r.createdAt.getTime(),
        suppressed: !!r.suppressedAt,
        suppressedReason: r.suppressedReason,
        suggestion: subjectSuggestion ?? (email ? suggestionByEmail.get(email) ?? null : null),
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
          isNull(messages.suppressedAt),
          ...(bizFilter ? [bizFilter] : []),
        ),
      );
    return rows.length;
  });
}

export type EmailNeedsActionCounts = {
  unmatched: number;
  failed: number;
  suppressed: number;
};

export async function getEmailNeedsActionCounts(
  user: RequestUser,
  opts: { businessId: string | null },
): Promise<EmailNeedsActionCounts> {
  return withUserContext(user, async (tx) => {
    const bizFilter =
      opts.businessId && opts.businessId !== "all" ? eq(messages.businessId, opts.businessId) : undefined;
    const [row] = await tx
      .select({
        unmatched: sql<number>`count(*) filter (where ${messages.direction} = 'inbound' and ${messages.orderId} is null and ${messages.suppressedAt} is null)::int`,
        failed: sql<number>`count(*) filter (where ${messages.direction} = 'outbound' and ${messages.status} = 'failed')::int`,
        suppressed: sql<number>`count(*) filter (where ${messages.direction} = 'inbound' and ${messages.suppressedAt} is not null)::int`,
      })
      .from(messages)
      .where(and(isNull(messages.archivedAt), ...(bizFilter ? [bizFilter] : [])));
    return {
      unmatched: row?.unmatched ?? 0,
      failed: row?.failed ?? 0,
      suppressed: row?.suppressed ?? 0,
    };
  });
}

export type MailHistoryItem = {
  messageId: string;
  businessId: string;
  orderId: string | null;
  orderNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  direction: "inbound" | "outbound";
  status: string;
  address: string | null;
  subject: string;
  body: string;
  createdAt: string;
  sentAt: string | null;
  archived: boolean;
  suppressed: boolean;
  suppressedReason: string | null;
};

export type MailHistoryResult = {
  rows: MailHistoryItem[];
  total: number;
  suppressedCount: number;
};

export async function getMailHistory(
  user: RequestUser,
  opts: {
    businessId: string | null;
    q?: string;
    includeSuppressed?: boolean;
    page?: number;
    pageSize?: number;
  },
): Promise<MailHistoryResult> {
  return withUserContext(user, async (tx) => {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 20), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const term = opts.q?.trim() ?? "";
    const bizFilter =
      opts.businessId && opts.businessId !== "all" ? eq(messages.businessId, opts.businessId) : undefined;
    const suppressionFilter = opts.includeSuppressed ? undefined : isNull(messages.suppressedAt);
    const searchFilter =
      term.length >= 2
        ? or(
            ilike(messages.address, `%${term}%`),
            ilike(messages.subject, `%${term}%`),
            ilike(orders.platformOrderName, `%${term}%`),
            ilike(orders.platformOrderId, `%${term}%`),
            ilike(customers.firstName, `%${term}%`),
            ilike(customers.lastName, `%${term}%`),
            sql`concat_ws(' ', ${customers.firstName}, ${customers.lastName}) ilike ${`%${term}%`}`,
          )
        : undefined;
    const filters = [
      sql`true`,
      ...(bizFilter ? [bizFilter] : []),
      ...(suppressionFilter ? [suppressionFilter] : []),
      ...(searchFilter ? [searchFilter] : []),
    ];

    const totalRow = await tx
      .select({ n: count() })
      .from(messages)
      .leftJoin(orders, eq(orders.id, messages.orderId))
      .leftJoin(customers, eq(customers.id, messages.customerId))
      .where(and(...filters));
    const suppressedRow = await tx
      .select({ n: count() })
      .from(messages)
      .where(and(sql`${messages.suppressedAt} is not null`, ...(bizFilter ? [bizFilter] : [])));

    const rows = await tx
      .select({
        id: messages.id,
        businessId: messages.businessId,
        orderId: messages.orderId,
        orderNumber: orders.platformOrderName,
        fallbackOrderNumber: orders.platformOrderId,
        customerId: messages.customerId,
        firstName: customers.firstName,
        lastName: customers.lastName,
        customerEmail: customers.email,
        direction: messages.direction,
        status: messages.status,
        address: messages.address,
        subject: messages.subject,
        body: messages.body,
        createdAt: messages.createdAt,
        sentAt: messages.sentAt,
        archivedAt: messages.archivedAt,
        suppressedAt: messages.suppressedAt,
        suppressedReason: messages.suppressedReason,
      })
      .from(messages)
      .leftJoin(orders, eq(orders.id, messages.orderId))
      .leftJoin(customers, eq(customers.id, messages.customerId))
      .where(and(...filters))
      .orderBy(desc(messages.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      total: totalRow[0]?.n ?? 0,
      suppressedCount: suppressedRow[0]?.n ?? 0,
      rows: rows.map((r) => ({
        messageId: r.id,
        businessId: r.businessId,
        orderId: r.orderId,
        orderNumber: r.orderNumber ?? r.fallbackOrderNumber ?? null,
        customerId: r.customerId,
        customerName: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.customerEmail || null,
        direction: r.direction,
        status: r.status,
        address: r.address,
        subject: r.subject ?? "",
        body: r.body ?? "",
        createdAt: r.createdAt.toISOString(),
        sentAt: r.sentAt?.toISOString() ?? null,
        archived: !!r.archivedAt,
        suppressed: !!r.suppressedAt,
        suppressedReason: r.suppressedReason,
      })),
    };
  });
}

export type IgnoredSender = {
  id: string;
  value: string;
  matchType: string;
  note: string | null;
  active: boolean;
};

export async function getIgnoredSenders(
  user: RequestUser,
  opts: { businessId: string },
): Promise<IgnoredSender[]> {
  return withUserContext(user, async (tx) => {
    const rows = await tx
      .select({
        id: emailSenderIgnores.id,
        value: emailSenderIgnores.value,
        matchType: emailSenderIgnores.matchType,
        note: emailSenderIgnores.note,
        active: emailSenderIgnores.active,
      })
      .from(emailSenderIgnores)
      .where(eq(emailSenderIgnores.businessId, opts.businessId))
      .orderBy(asc(emailSenderIgnores.value));
    return rows;
  });
}

export function extractOrderTokens(subject: string): string[] {
  const tokens = new Set<string>();
  for (const m of subject.matchAll(/\bPC\d{3,}\b/gi)) tokens.add(m[0].toUpperCase());
  for (const m of subject.matchAll(/\b\d{8,12}\b/g)) tokens.add(m[0]);
  return [...tokens];
}
