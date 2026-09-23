import { and, eq, gt, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { messages } from "@/lib/db/schema";

/** A QC-pass proof email for the same proof inside this window counts as in flight. */
export const QC_SEND_DEDUPE_MS = 10 * 60 * 1000;

/**
 * Double-submit guard for "Pass QC and send" (security QA round 2, P2): two
 * clicks, two tabs or two VAs each passed the status check and each sent the
 * customer the proof email (proven on staging: two sends, one transition).
 * The caller locks the order row first (SELECT ... FOR UPDATE), so a second
 * request waits for the first one's draft to commit, then sees it here.
 *
 * True when a QC-pass email for this proof was drafted, queued or sent in the
 * last QC_SEND_DEDUPE_MS. A failed send does not count, so a retry after a
 * Gmail error still goes through.
 */
export async function qcPassEmailInFlight(
  tx: Tx,
  input: { orderId: string; proofId: string; now?: Date },
): Promise<boolean> {
  const since = new Date((input.now ?? new Date()).getTime() - QC_SEND_DEDUPE_MS);
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.orderId, input.orderId),
        eq(messages.proofId, input.proofId),
        eq(messages.direction, "outbound"),
        inArray(messages.status, ["draft", "queued", "sent"]),
        gt(messages.createdAt, since),
        sql`${messages.metadata} ? 'qcPass'`,
      ),
    )
    .limit(1);
  return !!row;
}
