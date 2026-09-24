/**
 * Inbound replies link themselves by order number, and an order without a
 * customer adopts the sender:
 * - a reply whose subject names an order of this business lands on that order
 *   even though we never sent on its thread (mail from before AlphaOS);
 * - an Etsy-style order with no customer takes the sender's email + name;
 * - an order that already has a customer keeps it;
 * - a subject naming another business's order does not link.
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq, inArray } from "drizzle-orm";
import ws from "ws";

import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import { activityLog, businesses, customers, messages, notifications, orders, shops, users } from "../lib/db/schema";
import { processHistoryMessages } from "../lib/integrations/gmail/inbound";
import type { GmailMessage } from "../lib/integrations/gmail/types";

let failures = 0;
const ids = {
  businessId: randomUUID(),
  otherBusinessId: randomUUID(),
  shopId: randomUUID(),
  otherShopId: randomUUID(),
  vaId: randomUUID(),
  etsyOrderId: randomUUID(),
  shopifyOrderId: randomUUID(),
  otherOrderId: randomUUID(),
  existingCustomerId: randomUUID(),
};

function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

function gmailMessage(id: string, from: string, subject: string): GmailMessage {
  const body = "Here are the photos you asked for.";
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: "orders@example.com" },
        { name: "Subject", value: subject },
        { name: "Message-ID", value: `<${id}@example.com>` },
      ],
      body: { data: Buffer.from(body).toString("base64url"), size: body.length },
    },
  };
}

async function setup() {
  const suffix = Date.now();
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values([
      { id: ids.businessId, name: "Link Reply", slug: `link-reply-${suffix}` },
      { id: ids.otherBusinessId, name: "Link Reply Other", slug: `link-reply-other-${suffix}` },
    ]);
    await tx.insert(users).values({ id: ids.vaId, email: `link-reply-va-${suffix}@example.com`, name: "Link VA", role: "va" });
    await tx.insert(shops).values([
      { id: ids.shopId, businessId: ids.businessId, platform: "etsy", name: "Link Etsy", externalShopId: `link-${suffix}`, credentials: {} },
      { id: ids.otherShopId, businessId: ids.otherBusinessId, platform: "shopify", name: "Other Shop", externalShopId: `other-${suffix}`, credentials: {} },
    ]);
    await tx.insert(customers).values({ id: ids.existingCustomerId, businessId: ids.businessId, email: "already@example.com", firstName: "Already" });
    await tx.insert(orders).values([
      { id: ids.etsyOrderId, businessId: ids.businessId, shopId: ids.shopId, platformOrderId: "4170595372", platformOrderName: "4170595372", status: "awaiting_details", source: "etsy" },
      { id: ids.shopifyOrderId, businessId: ids.businessId, shopId: ids.shopId, platformOrderId: "PC32164", platformOrderName: "PC32164", status: "in_design", source: "shopify", customerId: ids.existingCustomerId },
      { id: ids.otherOrderId, businessId: ids.otherBusinessId, shopId: ids.otherShopId, platformOrderId: "PC70001", platformOrderName: "PC70001", status: "in_design", source: "shopify" },
    ]);
  });
}

async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  const biz = [ids.businessId, ids.otherBusinessId];
  try {
    await ownerDb.transaction(async (tx) => {
      await tx.delete(notifications).where(inArray(notifications.businessId, biz));
      await tx.delete(activityLog).where(inArray(activityLog.businessId, biz));
      await tx.delete(messages).where(inArray(messages.businessId, biz));
      await tx.delete(orders).where(inArray(orders.businessId, biz));
      await tx.delete(customers).where(inArray(customers.businessId, biz));
      await tx.delete(shops).where(inArray(shops.businessId, biz));
      await tx.delete(users).where(eq(users.id, ids.vaId));
      await tx.delete(businesses).where(inArray(businesses.id, biz));
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  await setup();
  try {
    const mail: Record<string, GmailMessage> = {
      etsy: gmailMessage("etsy", "Kate Keenan <katey@example.com>", "Re: ACTION REQUIRED - #4170595372- Portrait Is Ready!"),
      shopify: gmailMessage("shopify", "Amy Farrell <amy@example.com>", "Re: PC32164 - Portrait Is Ready!"),
      foreign: gmailMessage("foreign", "Someone <someone@example.com>", "Re: PC70001"),
      none: gmailMessage("none", "Nobody <nobody@example.com>", "Hello there"),
    };
    const client = { async getMessage(id: string) { return mail[id]; } };
    await processHistoryMessages({
      client,
      businessId: ids.businessId,
      selfAddress: "orders@example.com",
      historyMessages: Object.keys(mail).map((id) => ({ id, threadId: `thread-${id}`, labelIds: ["INBOX"] })),
    });

    const rows = await withSystemContext((tx) =>
      tx
        .select({ gmailMessageId: messages.gmailMessageId, orderId: messages.orderId, customerId: messages.customerId })
        .from(messages)
        .where(eq(messages.businessId, ids.businessId)),
    );
    const byId = new Map(rows.map((r) => [r.gmailMessageId, r]));
    const [etsyOrder] = await withSystemContext((tx) =>
      tx
        .select({ customerId: orders.customerId, email: customers.email, firstName: customers.firstName, lastName: customers.lastName })
        .from(orders)
        .leftJoin(customers, eq(customers.id, orders.customerId))
        .where(eq(orders.id, ids.etsyOrderId)),
    );
    const [shopifyOrder] = await withSystemContext((tx) =>
      tx.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, ids.shopifyOrderId)),
    );
    const log = await withSystemContext((tx) =>
      tx.select({ orderId: activityLog.orderId, metadata: activityLog.metadata }).from(activityLog).where(eq(activityLog.businessId, ids.businessId)),
    );

    report(
      "subject with an Etsy receipt number links the reply to that order",
      byId.get("etsy")?.orderId === ids.etsyOrderId,
      JSON.stringify(byId.get("etsy")),
    );
    report(
      "an order without a customer adopts the sender (email + name)",
      etsyOrder?.email === "katey@example.com" && etsyOrder.firstName === "Kate" && etsyOrder.lastName === "Keenan" && byId.get("etsy")?.customerId === etsyOrder.customerId,
      JSON.stringify(etsyOrder),
    );
    report(
      "subject with a Shopify order name links, and the existing customer is kept",
      byId.get("shopify")?.orderId === ids.shopifyOrderId && shopifyOrder?.customerId === ids.existingCustomerId && byId.get("shopify")?.customerId === ids.existingCustomerId,
      JSON.stringify({ msg: byId.get("shopify"), shopifyOrder }),
    );
    report(
      "another business's order number does not link",
      byId.get("foreign")?.orderId === null,
      JSON.stringify(byId.get("foreign")),
    );
    report(
      "a subject with no order number stays unmatched",
      byId.get("none")?.orderId === null,
      JSON.stringify(byId.get("none")),
    );
    report(
      "the timeline entry says the link came from the subject",
      log.some((l) => l.orderId === ids.etsyOrderId && (l.metadata as { linkedBy?: string })?.linkedBy === "subject"),
      JSON.stringify(log.map((l) => l.metadata)),
    );
  } finally {
    await cleanup();
  }
  if (failures) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
