import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { getBusinessPrintCredentials } from "@/lib/db/credentials";
import { activityLog, businesses, orderItems, orders, printJobs } from "@/lib/db/schema";
import { sendAlphaEvent } from "@/lib/alpha/client";
import { GelatoClient, type GelatoCredentials } from "@/lib/integrations/gelato";
import { LumaPrintsClient, type LumaPrintsCredentials } from "@/lib/integrations/lumaprints";
import { runTransition, type OrderStatus } from "@/lib/orders/transitions";
import { defaultPrintProvider, type PrintProvider } from "@/lib/print/mapping";
import { emailedTrackingNumbers, loadPrintParts, planShipmentNotice, type ShipmentNotice } from "@/lib/print/parts";
import { claimReconcileEvent, type ReconcileSource } from "@/lib/print/reconcile-ledger";
import { recordPartShipment, settleOrderShipment } from "@/lib/print/tracking";
import type { NormalizedProviderOrder, PrintProviderClient } from "@/lib/print/provider-types";

const SYSTEM_ACTOR = { id: "system", role: "system" as const };

export type BusinessPrintCredentials = {
  gelato?: GelatoCredentials;
  lumaprints?: LumaPrintsCredentials;
};

const MISSING_AFTER_MS = 12 * 60 * 60 * 1000; // printing, no matching provider order
const APPROVED_STALE_MS = 24 * 60 * 60 * 1000; // approved physical, never even logged as sent
const SEARCH_WINDOW_MS = 45 * 24 * 60 * 60 * 1000; // how far back we ask providers to look

export type ReconcileOutcome =
  | "matched"
  | "shipped"
  | "missing"
  | "problem"
  | "not_configured"
  | "no_change";

export type ReconcileOrderResult = {
  orderId: string;
  outcome: ReconcileOutcome;
  provider: PrintProvider | null;
  /** Each part of a split print (lib/print/parts.ts); absent for an order with one print. */
  parts?: Array<{ printJobId: string | null; providerOrderId: string | null; outcome: ReconcileOutcome }>;
};

export type ReconcileSummary = {
  businessId: string;
  checked: number;
  byOutcome: Record<ReconcileOutcome, number>;
  results: ReconcileOrderResult[];
  errors: Array<{ orderId: string; error: string }>;
};

function emptyTally(): Record<ReconcileOutcome, number> {
  return { matched: 0, shipped: 0, missing: 0, problem: 0, not_configured: 0, no_change: 0 };
}

export function buildPrintProviderClient(
  provider: PrintProvider,
  credentials: BusinessPrintCredentials,
): PrintProviderClient | null {
  if (provider === "gelato") {
    return credentials.gelato?.apiKey ? new GelatoClient(credentials.gelato) : null;
  }
  const luma = credentials.lumaprints;
  return luma?.username && luma?.password && luma?.storeId ? new LumaPrintsClient(luma) : null;
}

type CandidateOrder = {
  id: string;
  businessId: string;
  status: OrderStatus;
  platformOrderName: string | null;
  platformOrderId: string;
  updatedAt: Date;
};

type CandidateJob = {
  id: string;
  provider: PrintProvider;
  providerOrderId: string | null;
  reconcileState: string;
  submittedAt: Date | null;
  createdAt: Date;
  trackingNumber?: string | null;
};

async function loadCandidates(tx: Tx, businessId: string): Promise<CandidateOrder[]> {
  const approvedCutoff = new Date(Date.now() - APPROVED_STALE_MS);
  const rows = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      status: orders.status,
      platformOrderName: orders.platformOrderName,
      platformOrderId: orders.platformOrderId,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.businessId, businessId),
        isNull(orders.archivedAt),
        or(
          eq(orders.status, "printing"),
          and(eq(orders.status, "approved"), lt(orders.updatedAt, approvedCutoff)),
          // A paid add-on (an invoiced framed print) the agent's print road sent to print.
          and(
            eq(orders.status, "fulfillment_only"),
            sql`exists (select 1 from ${printJobs} pj where pj.order_id = ${orders.id} and pj.provider_order_id is not null)`,
          ),
        ),
      ),
    );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const physicalOrderIds = new Set(
    (
      await tx
        .select({ orderId: orderItems.orderId })
        .from(orderItems)
        .where(and(inArray(orderItems.orderId, ids), eq(orderItems.productType, "physical")))
    ).map((r) => r.orderId),
  );
  // A part already at the printer is followed whatever the items say: a legacy stub's only item can be digital
  // (Lori PC32062, canvas + frame at Gelato).
  const atPrinterOrderIds = new Set(
    (
      await tx
        .select({ orderId: printJobs.orderId })
        .from(printJobs)
        .where(and(inArray(printJobs.orderId, ids), isNotNull(printJobs.providerOrderId)))
    ).map((r) => r.orderId),
  );
  return rows.filter((r) => physicalOrderIds.has(r.id) || atPrinterOrderIds.has(r.id)) as CandidateOrder[];
}

// The least advanced part speaks for a split order: it is only shipped once every part is.
const PART_OUTCOME_ORDER: ReconcileOutcome[] = ["problem", "missing", "not_configured", "no_change", "matched", "shipped"];

/**
 * Reconcile every part of one order at the printer (lib/print/parts.ts; one print = one part, exactly as before),
 * then settle it once: writeback, shipped and the buyer's email when every part has tracking.
 */
async function reconcileOrderParts(
  tx: Tx,
  ctx: { businessId: string; order: CandidateOrder; credentials: BusinessPrintCredentials; source: ReconcileSource },
): Promise<ReconcileOrderResult> {
  const parts = await loadPrintParts(tx, ctx.order.id);
  const results: ReconcileOrderResult[] = [];
  for (const job of parts.length ? parts : [null]) {
    results.push(await reconcileOneOrder(tx, { ...ctx, job }));
  }
  await settleOrderShipment(tx, { businessId: ctx.businessId, orderId: ctx.order.id, source: ctx.source });
  if (results.length === 1) return results[0];
  const outcome = PART_OUTCOME_ORDER.find((o) => results.some((r) => r.outcome === o)) ?? "no_change";
  return {
    orderId: ctx.order.id,
    outcome,
    provider: results[0].provider,
    parts: results.map((r, i) => ({ printJobId: parts[i].id, providerOrderId: parts[i].providerOrderId, outcome: r.outcome })),
  };
}

function classify(result: NormalizedProviderOrder): "matched" | "shipped" | "problem" {
  if (result.status === "failed" || result.status === "canceled") return "problem";
  if (result.status === "shipped" || result.status === "delivered" || result.shipments.length) return "shipped";
  return "matched";
}

/**
 * Reconcile every printing/stale-approved physical order (or one with a part at the printer) for one business.
 * Runs inside withSystemContext (background job, no signed-in user). Every
 * side effect (order transition, Alpha event) is gated by
 * claimReconcileEvent so a concurrent webhook and cron tick, or two cron
 * overlaps, never double-fire.
 */
export async function reconcileBusinessPrintJobs(
  tx: Tx,
  businessId: string,
  source: ReconcileSource = "cron",
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { businessId, checked: 0, byOutcome: emptyTally(), results: [], errors: [] };
  const credentials = ((await getBusinessPrintCredentials(tx, businessId)) as BusinessPrintCredentials | null) ?? {};
  const candidates = await loadCandidates(tx, businessId);

  for (const order of candidates) {
    summary.checked += 1;
    try {
      const outcome = await reconcileOrderParts(tx, { businessId, order, credentials, source });
      summary.byOutcome[outcome.outcome] += 1;
      summary.results.push(outcome);
    } catch (error) {
      summary.errors.push({ orderId: order.id, error: error instanceof Error ? error.message : String(error) });
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          component: "print_reconcile",
          event: "order_reconcile_failed",
          businessId,
          orderId: order.id,
          error: String(error),
        }),
      );
    }
  }
  return summary;
}

/**
 * Reconcile ONE order (same rules as the business sweep). Used right after a
 * one-tap submit check and by scripts/test-print-submit.ts so a test never
 * sweeps every printing order of a business. Null when the order is not a
 * reconcile candidate (not printing / stale-approved, or no physical items).
 */
export async function reconcileOrderPrintJob(
  tx: Tx,
  businessId: string,
  orderId: string,
  source: ReconcileSource = "cron",
): Promise<ReconcileOrderResult | null> {
  const order = (await loadCandidates(tx, businessId)).find((candidate) => candidate.id === orderId);
  if (!order) return null;
  const credentials = ((await getBusinessPrintCredentials(tx, businessId)) as BusinessPrintCredentials | null) ?? {};
  return reconcileOrderParts(tx, { businessId, order, credentials, source });
}

async function reconcileOneOrder(
  tx: Tx,
  ctx: {
    businessId: string;
    order: CandidateOrder;
    job: CandidateJob | null;
    credentials: BusinessPrintCredentials;
    source: ReconcileSource;
  },
): Promise<ReconcileOrderResult> {
  const { businessId, order, job, credentials, source } = ctx;
  const reference = order.platformOrderName ?? order.platformOrderId;
  const since = new Date(Date.now() - SEARCH_WINDOW_MS);

  const providersToTry: PrintProvider[] = job ? [job.provider] : (["gelato", "lumaprints"] as PrintProvider[]);
  let result: NormalizedProviderOrder | null = null;
  let usedProvider: PrintProvider | null = null;
  let anyConfigured = false;

  for (const provider of providersToTry) {
    const client = buildPrintProviderClient(provider, credentials);
    if (!client) continue;
    anyConfigured = true;
    const found = job?.providerOrderId
      ? await client.getOrder(job.providerOrderId)
      : await client.findByReference(reference, { since });
    if (found) {
      result = found;
      usedProvider = provider;
      break;
    }
  }

  if (!anyConfigured) {
    if (job) {
      await tx.update(printJobs).set({ reconcileState: "not_configured", providerCheckedAt: new Date() }).where(eq(printJobs.id, job.id));
    }
    return { orderId: order.id, outcome: "not_configured", provider: job?.provider ?? null };
  }

  if (result && usedProvider) {
    return handleMatch(tx, { businessId, order, job, provider: usedProvider, result, source });
  }
  return handleNotFound(tx, { businessId, order, job, source });
}

async function ensureJobRow(
  tx: Tx,
  businessId: string,
  orderId: string,
  provider: PrintProvider,
): Promise<CandidateJob> {
  const [row] = await tx
    .insert(printJobs)
    .values({
      businessId,
      orderId,
      provider,
      method: "manual",
      providerPayload: { source: "print_reconcile_placeholder" },
      reconcileState: "unchecked",
    })
    .returning({
      id: printJobs.id,
      provider: printJobs.provider,
      providerOrderId: printJobs.providerOrderId,
      reconcileState: printJobs.reconcileState,
      submittedAt: printJobs.submittedAt,
      createdAt: printJobs.createdAt,
    });
  return row as CandidateJob;
}

async function handleMatch(
  tx: Tx,
  ctx: {
    businessId: string;
    order: CandidateOrder;
    job: CandidateJob | null;
    provider: PrintProvider;
    result: NormalizedProviderOrder;
    source: ReconcileSource;
  },
): Promise<ReconcileOrderResult> {
  const { businessId, order, provider, result, source } = ctx;
  // An approved order matched to a real provider order is in print, whatever its job row looks like (none, a
  // placeholder with no provider order id, or an id written by the agent's print road, 2026-10-14).
  // A paid add-on (fulfillment_only) at the printer moves the same way (invoiced add-ons, 2026-10-17).
  const wasApprovedSelfHeal = order.status === "approved" || (order.status === "fulfillment_only" && !!result.providerOrderId);
  const job = ctx.job ?? (await ensureJobRow(tx, businessId, order.id, provider));
  const newState = classify(result);
  const prevState = job.reconcileState || "unchecked";
  const now = new Date();

  await tx
    .update(printJobs)
    .set({
      providerOrderId: result.providerOrderId,
      // Keep what submit stored when the provider answer carries no reference.
      ...(result.referenceId ? { providerOrderNumber: result.referenceId } : {}),
      providerResponse: result.raw as object,
      providerStatus: result.rawStatus,
      providerStatusReason: result.reason,
      providerCheckedAt: now,
      ...(job.providerOrderId ? {} : { providerMatchedAt: now }),
    })
    .where(eq(printJobs.id, job.id));

  if (wasApprovedSelfHeal) {
    await runTransition(tx, SYSTEM_ACTOR, {
      orderId: order.id,
      to: "printing",
      expectedFrom: order.status,
      metadata: { via: "print_reconcile_self_heal", provider, providerOrderId: result.providerOrderId },
    });
    // The next part of the same order sees it printing, not approved again.
    order.status = "printing";
  }

  if (newState === prevState && !(wasApprovedSelfHeal && newState === "shipped")) {
    // A part already seen shipped whose number only shows up now (still on its way, not delivered).
    const late = result.shipments[0];
    if (newState === "shipped" && result.status === "shipped" && late && !job.trackingNumber) {
      const lateClaimed = await claimReconcileEvent(tx, {
        businessId,
        orderId: order.id,
        printJobId: job.id,
        provider,
        eventKey: `${job.id}:tracking:${late.trackingNumber}`,
        outcome: newState,
        source,
        payload: { rawStatus: result.rawStatus, providerOrderId: result.providerOrderId },
      });
      if (lateClaimed) {
        await recordPartShipment(tx, { businessId, orderId: order.id, printJobId: job.id, provider, providerOrderId: result.providerOrderId, shipment: late });
      }
    }
    return { orderId: order.id, outcome: newState, provider };
  }

  const eventKey = `${job.id}:${prevState}->${newState}:${result.rawStatus}`;
  const claimed = await claimReconcileEvent(tx, {
    businessId,
    orderId: order.id,
    printJobId: job.id,
    provider,
    eventKey,
    outcome: newState,
    source,
    payload: { rawStatus: result.rawStatus, providerOrderId: result.providerOrderId },
  });
  if (!claimed) return { orderId: order.id, outcome: newState, provider };

  await tx
    .update(printJobs)
    .set({ reconcileState: newState, missingFlaggedAt: null, reconcileNote: null })
    .where(eq(printJobs.id, job.id));

  await tx.insert(activityLog).values({
    businessId,
    orderId: order.id,
    actorId: null,
    action: `print.reconcile_${newState}`,
    metadata: { provider, providerOrderId: result.providerOrderId, rawStatus: result.rawStatus, via: "print_reconcile" },
  });

  if (newState === "shipped" && result.shipments[0]) {
    await recordPartShipment(tx, {
      businessId,
      orderId: order.id,
      printJobId: job.id,
      provider,
      providerOrderId: result.providerOrderId,
      shipment: result.shipments[0],
    });
  }

  if (newState === "problem") {
    await sendAlphaEvent(tx, {
      type: "va.attention",
      businessId,
      orderId: order.id,
      toRole: "va",
      text: `${provider === "gelato" ? "Gelato" : "Luma Prints"} could not fulfil order ${order.platformOrderName ?? order.platformOrderId}: ${result.reason ?? result.rawStatus}.`,
      payload: { orderUrl: `/orders/${order.id}`, provider, rawStatus: result.rawStatus },
    });
  }

  return { orderId: order.id, outcome: newState, provider };
}

async function handleNotFound(
  tx: Tx,
  ctx: { businessId: string; order: CandidateOrder; job: CandidateJob | null; source: ReconcileSource },
): Promise<ReconcileOrderResult> {
  const { businessId, order, source } = ctx;
  const now = new Date();

  if (ctx.job) {
    const age = ctx.job.submittedAt ? now.getTime() - ctx.job.submittedAt.getTime() : now.getTime() - ctx.job.createdAt.getTime();
    await tx.update(printJobs).set({ providerCheckedAt: now }).where(eq(printJobs.id, ctx.job.id));
    if (age < MISSING_AFTER_MS) {
      return { orderId: order.id, outcome: "no_change", provider: ctx.job.provider };
    }
  }

  const provider = ctx.job?.provider ?? defaultPrintProvider(null);
  const job = ctx.job ?? (await ensureJobRow(tx, businessId, order.id, provider));
  const prevState = job.reconcileState || "unchecked";
  if (prevState === "missing") {
    return { orderId: order.id, outcome: "missing", provider };
  }

  const eventKey = `${job.id}:missing`;
  const claimed = await claimReconcileEvent(tx, {
    businessId,
    orderId: order.id,
    printJobId: job.id,
    provider,
    eventKey,
    outcome: "missing",
    source,
  });
  if (!claimed) return { orderId: order.id, outcome: "missing", provider };

  await tx
    .update(printJobs)
    .set({
      reconcileState: "missing",
      missingFlaggedAt: now,
      providerCheckedAt: now,
      reconcileNote: `No matching order found at ${provider === "gelato" ? "Gelato" : "Luma Prints"} for reference ${order.platformOrderName ?? order.platformOrderId}.`,
    })
    .where(eq(printJobs.id, job.id));

  await tx.insert(activityLog).values({
    businessId,
    orderId: order.id,
    actorId: null,
    action: "print.reconcile_missing",
    metadata: { provider, via: "print_reconcile" },
  });

  const text = `Order ${order.platformOrderName ?? order.platformOrderId} is ${order.status === "approved" ? "approved and overdue to be sent to print" : "marked as printing"} but no matching order was found at ${provider === "gelato" ? "Gelato" : "Luma Prints"}. Check it was actually sent.`;
  await sendAlphaEvent(tx, {
    type: "order.missed_print",
    businessId,
    orderId: order.id,
    toRole: "va",
    text,
    payload: { orderUrl: `/orders/${order.id}`, provider },
  });
  await sendAlphaEvent(tx, {
    type: "order.missed_print",
    businessId,
    orderId: order.id,
    toRole: "admin",
    text,
    payload: { orderUrl: `/orders/${order.id}`, provider },
  });

  return { orderId: order.id, outcome: "missing", provider };
}

/** Top-level entry for the cron route: every business in turn. */
export async function reconcileAllBusinesses(source: ReconcileSource = "cron"): Promise<ReconcileSummary[]> {
  const businessIds = await withSystemContext((tx) =>
    tx.select({ id: businesses.id }).from(businesses).orderBy(businesses.id),
  );
  const summaries: ReconcileSummary[] = [];
  for (const { id } of businessIds) {
    const summary = await withSystemContext((tx) => reconcileBusinessPrintJobs(tx, id, source));
    summaries.push(summary);
  }
  return summaries;
}

/** Apply one already-fetched provider result directly (webhook path). */
export async function reconcileFromProviderEvent(
  tx: Tx,
  input: { businessId: string; provider: PrintProvider; result: NormalizedProviderOrder; source: ReconcileSource },
): Promise<ReconcileOrderResult | null> {
  const referenceId = input.result.referenceId;
  if (!referenceId) return null;
  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      status: orders.status,
      platformOrderName: orders.platformOrderName,
      platformOrderId: orders.platformOrderId,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.businessId, input.businessId),
        or(eq(orders.platformOrderName, referenceId), eq(orders.platformOrderId, referenceId)),
      ),
    )
    .limit(1);
  if (!order) return null;

  // The part this event is about; an id no part has yet goes to the newest, as before.
  const parts = await loadPrintParts(tx, order.id);
  const newest = parts.reduce<(typeof parts)[number] | null>((a, b) => (!a || b.createdAt >= a.createdAt ? b : a), null);
  const job = parts.find((p) => p.providerOrderId === input.result.providerOrderId) ?? newest;
  const outcome = await handleMatch(tx, {
    businessId: input.businessId,
    order: order as CandidateOrder,
    job,
    provider: input.provider,
    result: input.result,
    source: input.source,
  });
  await settleOrderShipment(tx, { businessId: input.businessId, orderId: order.id, source: input.source });
  return outcome;
}

/**
 * Read only: what reconcile sees for one order now. Every part with a fresh look at its printer, which parts would
 * have a new tracking number recorded, and what the buyer would then hear (ShipmentNotice). Writes nothing and sends
 * nothing, so it is safe against a live order before its parcels ship.
 */
export async function inspectOrderPrintParts(
  tx: Tx,
  businessId: string,
  orderId: string,
  now = new Date(),
): Promise<{
  orderId: string;
  parts: Array<{
    printJobId: string;
    providerOrderId: string | null;
    rowState: string;
    providerStatus: string | null;
    state: ReturnType<typeof classify> | null;
    trackingNumber: string | null;
    newTracking: boolean;
  }>;
  notice: ShipmentNotice["kind"];
  untold: string[];
}> {
  const credentials = ((await getBusinessPrintCredentials(tx, businessId)) as BusinessPrintCredentials | null) ?? {};
  const parts = await loadPrintParts(tx, orderId);
  const seen = [];
  const projected = [];
  for (const part of parts) {
    const client = buildPrintProviderClient(part.provider, credentials);
    const result = client && part.providerOrderId ? await client.getOrder(part.providerOrderId) : null;
    const state = result ? classify(result) : null;
    const shipment = result?.shipments[0] ?? null;
    // Mirrors handleMatch: a state change to shipped records its parcel; an unchanged shipped part only while in transit.
    const newTracking =
      !!result && !!shipment && state === "shipped" && !part.trackingNumber &&
      (part.reconcileState !== "shipped" || result.status === "shipped");
    const trackingNumber = part.trackingNumber ?? (newTracking ? shipment!.trackingNumber : null);
    seen.push({
      printJobId: part.id,
      providerOrderId: part.providerOrderId,
      rowState: part.reconcileState,
      providerStatus: result?.rawStatus ?? part.providerStatus,
      state,
      trackingNumber,
      newTracking,
    });
    const said = newTracking && shipment!.shippedAt ? new Date(shipment!.shippedAt) : null;
    projected.push({
      ...part,
      reconcileState: state ?? part.reconcileState,
      providerStatus: result?.rawStatus ?? part.providerStatus,
      trackingNumber,
      shippedAt: part.shippedAt ?? (newTracking ? (said && !Number.isNaN(said.getTime()) ? said : now) : null),
    });
  }
  const notice = planShipmentNotice(projected, await emailedTrackingNumbers(tx, orderId), now);
  return {
    orderId,
    parts: seen,
    notice: notice.kind,
    untold: notice.kind === "all" || notice.kind === "early" ? notice.untold.map((p) => p.trackingNumber!) : [],
  };
}
