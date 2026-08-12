/**
 * Reply classification and manual print signal invariants:
 * - quoted text is stripped before classification;
 * - a stored reply suggestion never moves an order by itself;
 * - the VA decision records agreement data and performs the transition;
 * - manual print signal creates a print job and moves approved physical work to printing.
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { and, eq, inArray } from "drizzle-orm";
import ws from "ws";

import { withSystemContext, type RequestUser } from "../lib/db";
import * as schema from "../lib/db/schema";
import {
  activityLog,
  businesses,
  messages,
  orderItems,
  orders,
  printJobs,
  shops,
  users,
} from "../lib/db/schema";
import { classifyProofReply, stripQuotedReplyText } from "../lib/email/reply-classifier";
import { applyReplyClassificationDecision } from "../lib/email/reply-decisions";
import { recordManualPrintSignal } from "../lib/print/manual";

let failures = 0;
const ids = {
  businessId: randomUUID(),
  shopId: randomUUID(),
  vaId: randomUUID(),
  approvalOrderId: randomUUID(),
  printOrderId: randomUUID(),
  messageId: randomUUID(),
};

function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

async function statusOf(orderId: string): Promise<string> {
  return withSystemContext(async (tx) => {
    const [row] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1);
    return row?.status ?? "(missing)";
  });
}

async function setup() {
  await withSystemContext(async (tx) => {
    const suffix = Date.now();
    await tx.insert(businesses).values({
      id: ids.businessId,
      name: "Reply Print Test",
      slug: `reply-print-${suffix}`,
    });
    await tx.insert(users).values({
      id: ids.vaId,
      email: `reply-print-va-${suffix}@example.com`,
      name: "Reply Print VA",
      role: "va",
    });
    await tx.insert(shops).values({
      id: ids.shopId,
      businessId: ids.businessId,
      platform: "shopify",
      name: "Reply Print Shop",
      externalShopId: `reply-print-${suffix}.myshopify.com`,
      credentials: {},
    });
    await tx.insert(orders).values([
      {
        id: ids.approvalOrderId,
        businessId: ids.businessId,
        shopId: ids.shopId,
        platformOrderId: `APPROVAL-${suffix}`,
        platformOrderName: `APPROVAL-${suffix}`,
        status: "awaiting_approval",
        source: "manual",
        uploadToken: randomUUID(),
      },
      {
        id: ids.printOrderId,
        businessId: ids.businessId,
        shopId: ids.shopId,
        platformOrderId: `PRINT-${suffix}`,
        platformOrderName: `PRINT-${suffix}`,
        status: "approved",
        source: "shopify",
        uploadToken: randomUUID(),
        placedAt: new Date(),
      },
    ]);
    await tx.insert(orderItems).values({
      businessId: ids.businessId,
      orderId: ids.printOrderId,
      title: "A3 Framed Print",
      productType: "physical",
      figureCount: 1,
      figureCountSource: "manual",
    });
    await tx.insert(messages).values({
      id: ids.messageId,
      businessId: ids.businessId,
      orderId: ids.approvalOrderId,
      direction: "inbound",
      channel: "email",
      status: "received",
      subject: "Re: Your PixArt proof",
      address: "customer@example.com",
      body: "Looks great, please ship it.",
      metadata: {
        replyClassification: {
          model: "test-model",
          intent: "approval",
          confidence: 0.96,
          rationale: "Customer clearly approved the proof.",
          strippedText: "Looks great, please ship it.",
          classifiedAt: new Date().toISOString(),
        },
      },
    });
  });
}

async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    await ownerDb.transaction(async (tx) => {
      await tx.delete(activityLog).where(eq(activityLog.businessId, ids.businessId));
      await tx.delete(printJobs).where(eq(printJobs.businessId, ids.businessId));
      await tx.delete(messages).where(eq(messages.businessId, ids.businessId));
      await tx.delete(orderItems).where(inArray(orderItems.orderId, [ids.approvalOrderId, ids.printOrderId]));
      await tx.delete(orders).where(inArray(orders.id, [ids.approvalOrderId, ids.printOrderId]));
      await tx.delete(shops).where(eq(shops.id, ids.shopId));
      await tx.delete(users).where(eq(users.id, ids.vaId));
      await tx.delete(businesses).where(eq(businesses.id, ids.businessId));
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  try {
    const stripped = stripQuotedReplyText([
      "Looks great, please ship it.",
      "",
      "On Wed, Aug 12, 2026 at 10:05 AM AlphaOS wrote:",
      "> Your proof is ready.",
    ].join("\n"));
    report("quoted prior email is stripped", stripped === "Looks great, please ship it.", JSON.stringify({ stripped }));

    const quotedOnly = await classifyProofReply({ subject: "Re: proof", body: "> Your proof is ready." });
    report(
      "quote-only replies become unclear without a model call",
      quotedOnly?.intent === "unclear" && quotedOnly.model === "quote-stripper",
      JSON.stringify(quotedOnly),
    );

    await setup();
    report(
      "stored model suggestion alone does not approve the order",
      (await statusOf(ids.approvalOrderId)) === "awaiting_approval",
      `status ${await statusOf(ids.approvalOrderId)}`,
    );

    const va: RequestUser = { id: ids.vaId, role: "va" };
    const approvalResult = await withSystemContext((tx) =>
      applyReplyClassificationDecision(tx, va, ids.messageId, "approved"),
    );
    const [messageAfter, decisionLogs] = await withSystemContext(async (tx) => {
      const [messageRow] = await tx
        .select({ metadata: messages.metadata })
        .from(messages)
        .where(eq(messages.id, ids.messageId))
        .limit(1);
      const logs = await tx
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(eq(activityLog.businessId, ids.businessId), eq(activityLog.action, "message.reply_classification_decided")));
      return [messageRow, logs] as const;
    });
    const decision = ((messageAfter?.metadata as Record<string, unknown>)?.replyClassification as Record<string, unknown>)?.vaDecision as
      | Record<string, unknown>
      | undefined;
    report(
      "VA approval decision transitions and logs agreement",
      approvalResult.ok &&
        (await statusOf(ids.approvalOrderId)) === "approved" &&
        decision?.decision === "approved" &&
        decision?.agreedWithModel === true &&
        decisionLogs.length === 1,
      JSON.stringify({ approvalResult, status: await statusOf(ids.approvalOrderId), decision, decisionLogs: decisionLogs.length }),
    );

    const printResult = await withSystemContext((tx) =>
      recordManualPrintSignal(tx, va, { orderId: ids.printOrderId, provider: "gelato" }),
    );
    const printRows = await withSystemContext((tx) =>
      tx
        .select({ provider: printJobs.provider, method: printJobs.method, status: printJobs.status })
        .from(printJobs)
        .where(eq(printJobs.orderId, ids.printOrderId)),
    );
    report(
      "manual print signal creates job and moves order to printing",
      printResult.ok &&
        (await statusOf(ids.printOrderId)) === "printing" &&
        printRows.length === 1 &&
        printRows[0].provider === "gelato" &&
        printRows[0].method === "manual" &&
        printRows[0].status === "sent_to_print",
      JSON.stringify({ printResult, status: await statusOf(ids.printOrderId), printRows }),
    );
  } finally {
    await cleanup();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("test-reply-print-flow crashed:", error);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
