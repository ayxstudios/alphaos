import type { Tx } from "@/lib/db";
import { printReconcileLedger } from "@/lib/db/schema";
import type { PrintProvider } from "@/lib/print/mapping";

export type ReconcileSource = "cron" | "webhook:gelato" | "webhook:lumaprints" | "manual";

/**
 * Idempotency gate for a reconcile SIDE EFFECT (sending an Alpha event,
 * advancing the order). `eventKey` names the exact transition (e.g.
 * `${printJobId}:matched->shipped:shipped`) so a re-run that recomputes the
 * same outcome does nothing, but a genuinely new transition (status changes
 * again later) gets a fresh key and fires again. The unique index on
 * event_key is the actual guard - this just makes "did I win the race"
 * available as a boolean, safe under the cron and a webhook landing at the
 * same moment.
 */
export async function claimReconcileEvent(
  tx: Tx,
  input: {
    businessId: string;
    orderId: string | null;
    printJobId: string | null;
    provider: PrintProvider;
    eventKey: string;
    outcome: string;
    source: ReconcileSource;
    payload?: Record<string, unknown>;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(printReconcileLedger)
    .values({
      businessId: input.businessId,
      orderId: input.orderId,
      printJobId: input.printJobId,
      provider: input.provider,
      eventKey: input.eventKey,
      outcome: input.outcome,
      source: input.source,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing({ target: printReconcileLedger.eventKey })
    .returning({ id: printReconcileLedger.id });
  return rows.length > 0;
}
