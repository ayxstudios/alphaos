import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { getBusinessPrintCredentials } from "@/lib/db/credentials";
import { businesses } from "@/lib/db/schema";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";
import { normalizeGelatoWebhookEvent, verifyGelatoWebhook, type GelatoCredentials, type GelatoWebhookEvent } from "@/lib/integrations/gelato";
import { reconcileFromProviderEvent } from "@/lib/print/reconcile";

export const runtime = "nodejs";

/**
 * Gelato order_status_updated / order_item_track_and_trace webhook
 * (dashboard.gelato.com/docs/webhooks/). One Gelato account per business, so
 * the webhook URL registered in that business's Gelato dashboard is
 * `.../api/webhooks/gelato?business=<businessId>&secret=<their configured
 * secret>` - see lib/integrations/gelato/webhook.ts for why a query secret
 * rather than a signature header (Gelato does not document one).
 *
 * Always 200s once the signature check passes, and processes off the
 * response path exactly like the Shopify webhook, so Gelato's 3-retry/5s
 * policy never piles up work on our side.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const businessId = req.nextUrl.searchParams.get("business");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const signatureHeader = req.headers.get("x-gelato-signature");

  if (!businessId) return new NextResponse("missing business", { status: 400 });

  const credentials = await withSystemContext(async (tx) => {
    const [business] = await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!business) return null;
    return ((await getBusinessPrintCredentials(tx, businessId)) as { gelato?: GelatoCredentials } | null)?.gelato ?? null;
  });
  if (!credentials?.webhookSecret) return new NextResponse("unknown business", { status: 401 });

  const verified = verifyGelatoWebhook({
    rawBody: raw,
    secret: credentials.webhookSecret,
    querySecret,
    signatureHeader,
  });
  if (!verified) return new NextResponse("invalid signature", { status: 401 });

  let payload: GelatoWebhookEvent;
  try {
    payload = JSON.parse(raw) as GelatoWebhookEvent;
  } catch {
    return new NextResponse("bad json", { status: 400 });
  }

  const runId = await startJobRun({
    jobName: JOB_NAMES.gelatoWebhook,
    scope: { businessId },
    metadata: { orderId: payload.orderId, orderReferenceId: payload.orderReferenceId, event: payload.event },
  });
  try {
    const normalized = normalizeGelatoWebhookEvent(payload);
    const result = await withSystemContext((tx) =>
      reconcileFromProviderEvent(tx, { businessId, provider: "gelato", result: normalized, source: "webhook:gelato" }),
    );
    await finishJobRun(runId, {
      status: "ok",
      itemsProcessed: result ? 1 : 0,
      itemsFailed: result ? 0 : 1,
      metadata: { matched: Boolean(result), outcome: result?.outcome ?? "no_matching_order" },
    });
  } catch (error) {
    await failJobRun(runId, error, { orderReferenceId: payload.orderReferenceId });
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        integration: "gelato",
        event: "webhook_processing_failed",
        businessId,
        orderReferenceId: payload.orderReferenceId,
        error: String(error),
      }),
    );
  }

  return new NextResponse("ok", { status: 200 });
}
