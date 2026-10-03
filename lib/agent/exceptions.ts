import { and, eq, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { exceptions } from "@/lib/db/schema";

export type ExceptionKind =
  | "photo_count_mismatch"
  | "intake_unparsed"
  | "no_eligible_designer"
  | "reply_unclear"
  | "buyer_question"
  | "unmatched_reply"
  | "email_send_failed"
  | "legacy_order"
  | "new_product"
  | "addon_only";

export type OpenExceptionInput = {
  businessId: string;
  orderId: string | null;
  kind: ExceptionKind | (string & {});
  summary: string;
  detail: Record<string, unknown>;
};

/**
 * Raise an exception for a human. If an open one already exists for the same
 * order and kind, nothing is written and the existing id is returned (the
 * partial unique index exceptions_open_order_kind_uq decides, so two agent
 * ticks racing cannot double up).
 */
export async function openException(input: OpenExceptionInput): Promise<string> {
  return withSystemContext(async (tx) => (await openExceptionTx(tx, input)).id);
}

/**
 * openException inside the caller's transaction, so the agent can write the
 * exception and its audit row atomically. `created` is false when an open
 * exception for this order and kind already existed.
 */
export async function openExceptionTx(
  tx: Tx,
  input: OpenExceptionInput,
): Promise<{ id: string; created: boolean }> {
  const [created] = await tx
    .insert(exceptions)
    .values({
      businessId: input.businessId,
      orderId: input.orderId,
      kind: input.kind,
      summary: input.summary,
      detail: input.detail,
    })
    .onConflictDoNothing()
    .returning({ id: exceptions.id });
  if (created) return { id: created.id, created: true };

  // Conflict: an open row for this order+kind exists. Order-less rows never
  // conflict, so orderId is non-null here.
  const [existing] = await tx
    .select({ id: exceptions.id })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.orderId, input.orderId as string),
        eq(exceptions.kind, input.kind),
        eq(exceptions.status, "open"),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error("openException: conflict but no open exception found");
  }
  return { id: existing.id, created: false };
}

/** Mark an open exception resolved. Returns false if it was not open. */
export async function resolveException(input: {
  id: string;
  userId: string;
  note?: string | null;
}): Promise<boolean> {
  return withSystemContext(async (tx) => {
    const rows = await tx
      .update(exceptions)
      .set({
        status: "resolved",
        resolvedAt: sql`now()`,
        resolvedBy: input.userId,
        resolutionNote: input.note ?? null,
      })
      .where(and(eq(exceptions.id, input.id), eq(exceptions.status, "open")))
      .returning({ id: exceptions.id });
    return rows.length > 0;
  });
}

/** Open exceptions, newest first; one business or all of them. */
export async function listOpenExceptions(businessId?: string) {
  return withSystemContext((tx) =>
    tx
      .select()
      .from(exceptions)
      .where(
        businessId
          ? and(eq(exceptions.status, "open"), eq(exceptions.businessId, businessId))
          : eq(exceptions.status, "open"),
      )
      .orderBy(sql`${exceptions.createdAt} desc`),
  );
}
