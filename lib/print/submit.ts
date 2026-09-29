import { and, desc, eq } from "drizzle-orm";

import { withUserContext, type RequestUser, type Tx } from "@/lib/db";
import { getBusinessPrintCredentials } from "@/lib/db/credentials";
import { activityLog, messages, orders, printJobs } from "@/lib/db/schema";
import { queueStageEmail } from "@/lib/email/dispatch";
import { GelatoClient, type GelatoCreateOrderPayload } from "@/lib/integrations/gelato";
import { LumaPrintsClient, type LumaCreateOrderPayload } from "@/lib/integrations/lumaprints";
import { isMockMode as isGelatoMock } from "@/lib/integrations/gelato/client";
import { isMockMode as isLumaMock } from "@/lib/integrations/lumaprints/client";
import { runTransition } from "@/lib/orders/transitions";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import type { PrintProvider } from "./mapping";
import { preparePrintOrder, PROVIDER_LABEL, type PrintPlan } from "./prepare";
import type { BusinessPrintCredentials } from "./reconcile";

/**
 * One-tap print submit (docs/AGENT_FIRST.md 3.2). The agent prepared the order
 * (lib/print/prepare.ts); a staff member taps Submit and this:
 *   1. locks the order, refuses if it already has an active print job
 *   2. re-runs prepare and refuses on any blocker
 *   3. records a printJobs row (method "api") BEFORE calling the provider
 *   4. calls createOrder (mock / sandbox / live per the stored credentials)
 *   5. stores the provider order id/number/response, moves approved->printing
 *      as the human actor (that transition drafts the "printing" stage email),
 *      and logs print.submitted.
 * From there the existing reconcile cron (lib/print/reconcile.ts) polls the
 * job by providerOrderId and moves the order to shipped when tracking lands.
 */

export type SubmitPrintResult =
  | {
      ok: true;
      message: string;
      printJobId: string;
      provider: PrintProvider;
      providerOrderId: string;
      providerOrderNumber: string | null;
      cost: number | null;
      currency: string | null;
      printingEmailId: string | null;
    }
  | { ok: false; message: string; blockers?: string[] };

// Job statuses that no longer hold the order (a new submit may follow).
const INACTIVE_JOB_STATUSES = ["submit_failed", "rejected", "failed", "canceled", "cancelled"];

// A presigned R2 link must outlive the provider's download; 7 days is the S3 max.
const PRINT_FILE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return value != null && value !== "" && Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** "8x10", "8 x 10 in", "12×16" -> {width: 8, height: 10}. */
export function parseSize(size: string | null): { width: number; height: number } | null {
  const m = String(size ?? "").match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function splitName(address: NonNullable<PrintPlan["address"]>): { firstName: string; lastName: string } {
  if (address.firstName || address.lastName) {
    return { firstName: address.firstName ?? "", lastName: address.lastName ?? "" };
  }
  const parts = (address.name ?? "").trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

async function printFileUrl(plan: PrintPlan): Promise<string> {
  const file = plan.file!;
  if (file.storage === "cdn" && file.url) return file.url;
  if (file.r2Key) {
    if (!isR2Configured()) throw new Error("The print file is in R2 but R2 is not configured here.");
    return presignGet(file.r2Key, PRINT_FILE_URL_TTL_SECONDS);
  }
  throw new Error("The final print file has no downloadable location.");
}

function buildLumaPayload(plan: PrintPlan, storeId: string, imageUrl: string): LumaCreateOrderPayload {
  const address = plan.address!;
  const { firstName, lastName } = splitName(address);
  return {
    externalId: plan.orderNumber,
    storeId,
    shippingMethod: String(plan.items[0]?.providerConfig.shippingMethod ?? "default"),
    productionTime: "regular",
    recipient: {
      firstName,
      lastName,
      company: address.company ?? null,
      addressLine1: address.addressLine1 ?? "",
      addressLine2: address.addressLine2 ?? null,
      city: address.city ?? "",
      state: address.state ?? "",
      zipCode: address.postalCode ?? "",
      country: address.countryCode ?? "",
      phone: address.phone ?? null,
    },
    orderItems: plan.items.map((item) => {
      const config = item.providerConfig;
      const size = parseSize(item.size);
      const options = Array.isArray(config.orderItemOptions) ? (config.orderItemOptions as Array<{ optionId: number }>) : undefined;
      return {
        externalItemId: item.itemId,
        subcategoryId: num(config.subcategoryId) ?? num(item.providerSku) ?? 0,
        quantity: item.quantity,
        width: num(config.width) ?? size?.width ?? 0,
        height: num(config.height) ?? size?.height ?? 0,
        file: { imageUrl },
        ...(options ? { orderItemOptions: options } : {}),
      };
    }),
  };
}

function buildGelatoPayload(plan: PrintPlan, customerRef: string, imageUrl: string): GelatoCreateOrderPayload {
  const address = plan.address!;
  const { firstName, lastName } = splitName(address);
  const shipmentMethodUid = plan.items[0]?.providerConfig.shipmentMethodUid;
  return {
    orderType: "order",
    orderReferenceId: plan.orderNumber,
    customerReferenceId: customerRef,
    currency: plan.currency ?? "USD",
    ...(typeof shipmentMethodUid === "string" ? { shipmentMethodUid } : {}),
    items: plan.items.map((item) => ({
      itemReferenceId: item.itemId,
      productUid: item.providerSku ?? "",
      quantity: item.quantity,
      files: [{ type: "default" as const, url: imageUrl }],
    })),
    shippingAddress: {
      firstName,
      lastName,
      companyName: address.company ?? null,
      addressLine1: address.addressLine1 ?? "",
      addressLine2: address.addressLine2 ?? null,
      city: address.city ?? "",
      state: address.state ?? null,
      postCode: address.postalCode ?? "",
      country: address.countryCode ?? "",
      email: address.email ?? null,
      phone: address.phone ?? null,
    },
  };
}

/** The active (non-rejected) print job holding this order, if any. */
export async function activePrintJob(tx: Tx, orderId: string) {
  const rows = await tx
    .select({
      id: printJobs.id,
      provider: printJobs.provider,
      method: printJobs.method,
      status: printJobs.status,
      providerOrderId: printJobs.providerOrderId,
      rejectedAt: printJobs.rejectedAt,
      reconcileState: printJobs.reconcileState,
    })
    .from(printJobs)
    .where(eq(printJobs.orderId, orderId))
    .orderBy(desc(printJobs.createdAt));
  return (
    rows.find(
      (job) => !job.rejectedAt && !INACTIVE_JOB_STATUSES.includes(job.status ?? "") && job.reconcileState !== "problem",
    ) ?? null
  );
}

export async function submitPrintOrder(
  input: { orderId: string; actorUserId: string; actorRole?: RequestUser["role"]; provider?: PrintProvider | null },
  tx?: Tx,
): Promise<SubmitPrintResult> {
  if (!tx) {
    const user: RequestUser = { id: input.actorUserId, role: input.actorRole ?? "va" };
    return withUserContext(user, (t) => submitPrintOrder(input, t));
  }
  const actor = { id: input.actorUserId, role: input.actorRole ?? "va" } as const;
  if (actor.role === "designer") return { ok: false, message: "Only admin and VAs can submit print orders." };

  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      customerId: orders.customerId,
      status: orders.status,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for("update")
    .limit(1);
  if (!order) return { ok: false, message: "Order not found." };

  const existing = await activePrintJob(tx, order.id);
  if (existing) {
    const where = existing.providerOrderId ? ` (${PROVIDER_LABEL[existing.provider]} order ${existing.providerOrderId})` : "";
    return {
      ok: false,
      message: `Already sent to print${where}. A second submit would print it twice.`,
    };
  }

  const plan = await preparePrintOrder(order.id, { tx, provider: input.provider ?? null });
  if (!plan) return { ok: false, message: "Order not found." };
  if (plan.blockers.length) {
    return {
      ok: false,
      message: `Not ready to print: ${plan.blockers.map((b) => b.message).join(" ")}`,
      blockers: plan.blockers.map((b) => b.message),
    };
  }

  const credentials = ((await getBusinessPrintCredentials(tx, order.businessId)) as BusinessPrintCredentials | null) ?? {};
  const provider = plan.provider;
  const luma = credentials.lumaprints;
  const gelato = credentials.gelato;
  if (provider === "lumaprints" && !(luma?.username && luma?.password && luma?.storeId)) {
    return { ok: false, message: "Lumaprints is not connected. Add its API keys in Settings." };
  }
  if (provider === "gelato" && !gelato?.apiKey) {
    return { ok: false, message: "Gelato is not connected. Add its API key in Settings." };
  }
  const mode =
    provider === "lumaprints"
      ? isLumaMock(luma) ? "mock" : luma?.sandbox ? "sandbox" : "live"
      : isGelatoMock(gelato) ? "mock" : gelato?.sandbox ? "sandbox" : "live";

  let imageUrl: string;
  try {
    imageUrl = await printFileUrl(plan);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const payload =
    provider === "lumaprints"
      ? buildLumaPayload(plan, luma!.storeId, imageUrl)
      : buildGelatoPayload(plan, order.customerId ?? order.id, imageUrl);

  const now = new Date();
  // Recorded before the provider call so a crash between the two leaves a
  // visible job (and blocks a blind double submit) instead of nothing.
  const [job] = await tx
    .insert(printJobs)
    .values({
      businessId: order.businessId,
      orderId: order.id,
      provider,
      method: "api",
      externalId: plan.orderNumber,
      status: "submitting",
      submittedAt: now,
      providerPayload: {
        source: "agent_one_tap_submit",
        mode,
        routingReason: plan.routingReason,
        requestedProvider: plan.requestedProvider,
        printFileAssetId: plan.file?.assetId ?? null,
        triggeredBy: actor.id,
        request: payload,
      },
    })
    .returning({ id: printJobs.id });

  let providerOrderId: string;
  let providerOrderNumber: string | null;
  let providerStatus: string;
  let providerResponse: object;
  let providerCost: number | null = null;
  try {
    if (provider === "lumaprints") {
      const response = await new LumaPrintsClient(luma!).createOrder(payload as LumaCreateOrderPayload);
      providerOrderId = String(response.orderNumber);
      providerOrderNumber = String(response.orderNumber);
      providerStatus = response.orderStatus ?? "Awaiting Fulfillment";
      providerCost = num(response.orderTotal);
      providerResponse = response;
    } else {
      const response = await new GelatoClient(gelato!).createOrder(payload as GelatoCreateOrderPayload);
      providerOrderId = response.id;
      providerOrderNumber = response.id;
      providerStatus = response.fulfillmentStatus;
      providerCost = num(asRecord(response.receipts?.[0]).totalInclVat);
      providerResponse = response;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await tx
      .update(printJobs)
      .set({ status: "submit_failed", error: message.slice(0, 500), rejectedAt: new Date() })
      .where(eq(printJobs.id, job!.id));
    await tx.insert(activityLog).values({
      businessId: order.businessId,
      orderId: order.id,
      actorId: actor.id,
      action: "print.submit_failed",
      metadata: { provider, mode, error: message.slice(0, 300) },
    });
    return { ok: false, message: `${PROVIDER_LABEL[provider]} did not accept the order: ${message}` };
  }

  const accepted = new Date();
  await tx
    .update(printJobs)
    .set({
      providerOrderId,
      providerOrderNumber,
      providerResponse,
      providerStatus,
      status: "sent_to_print",
      acceptedAt: accepted,
      providerMatchedAt: accepted,
      providerCheckedAt: accepted,
      // Already known to the provider: reconcile starts from "matched" so its
      // next tick only fires on real progress (shipped/problem).
      reconcileState: "matched",
    })
    .where(eq(printJobs.id, job!.id));

  const printingEmails = () =>
    tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.orderId, order.id), eq(messages.templateKey, "printing")));
  const emailsBefore = new Set((await printingEmails()).map((m) => m.id));

  await runTransition(tx, actor, {
    orderId: order.id,
    to: "printing",
    expectedFrom: "approved",
    metadata: { via: "print_submit", provider, providerOrderId, printJobId: job!.id },
  });

  const cost = providerCost ?? plan.totalCost;
  const currency = providerCost != null ? (plan.currency ?? "USD") : plan.currency;
  await tx.insert(activityLog).values({
    businessId: order.businessId,
    orderId: order.id,
    actorId: actor.id,
    action: "print.submitted",
    metadata: {
      provider,
      providerOrderId,
      providerOrderNumber,
      cost,
      currency,
      costSource: providerCost != null ? "provider_response" : plan.totalCost != null ? "mapping" : null,
      routingReason: plan.routingReason,
      mode,
      printJobId: job!.id,
    },
  });

  // approved->printing already drafts the "printing" stage email in
  // runTransition. Only queue it here if that did not happen (so the
  // customer never gets two).
  const drafted = (await printingEmails()).find((m) => !emailsBefore.has(m.id));
  const printingEmailId = drafted?.id ?? (await queueStageEmail(tx, order, "printing"));

  return {
    ok: true,
    message: `Sent to ${PROVIDER_LABEL[provider]}${mode === "live" ? "" : ` (${mode})`}: order ${providerOrderNumber ?? providerOrderId}.`,
    printJobId: job!.id,
    provider,
    providerOrderId,
    providerOrderNumber,
    cost,
    currency,
    printingEmailId,
  };
}
