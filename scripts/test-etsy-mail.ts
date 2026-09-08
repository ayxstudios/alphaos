/**
 * Etsy has no messaging API (CLAUDE.md) — every buyer message and sale
 * notification arrives as an email FROM Etsy to the shop's Gmail mailbox.
 * Proves, against three realistic fixtures in scripts/fixtures/etsy-mail/:
 *  - a "New message from" email with a receipt id attaches to the matching
 *    order, channel `etsy`, cleaned body (no Etsy chrome/footer);
 *  - a "New message from" email with no receipt id and an unknown buyer name
 *    lands unmatched (orderId null) rather than being dropped;
 *  - a "You made a sale" email for a receipt AlphaOS has never seen creates a
 *    `manual:` stub order in `awaiting_details` (the same shape a real Etsy
 *    sync would reconcile onto later).
 */
import "./load-env";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";
import ws from "ws";

import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import { activityLog, businesses, customers, messages, notifications, orders, shops, users } from "../lib/db/schema";
import { parseEtsyEmail, isEtsyNotificationSender } from "../lib/integrations/gmail/etsy-mail";
import { processHistoryMessages } from "../lib/integrations/gmail/inbound";
import type { GmailMessage } from "../lib/integrations/gmail/types";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const FIXTURES_DIR = path.join(__dirname, "fixtures", "etsy-mail");
type Fixture = { from: string; subject: string; body: string };
function loadFixture(name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8"));
}

function gmailMessageFromFixture(id: string, f: Fixture): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX"],
    snippet: f.body.slice(0, 100),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: f.from },
        { name: "To", value: "orders@example.com" },
        { name: "Subject", value: f.subject },
        { name: "Message-ID", value: `<${id}@etsy.com>` },
      ],
      body: { data: Buffer.from(f.body).toString("base64url"), size: f.body.length },
    },
  };
}

const ids = {
  businessId: randomUUID(),
  vaId: randomUUID(),
  shopId: randomUUID(),
  matchedOrderId: randomUUID(),
  customerId: randomUUID(),
};

async function setup() {
  const suffix = Date.now();
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({
      id: ids.businessId,
      name: "Etsy Mail Test Business",
      slug: `etsy-mail-test-${suffix}`,
    });
    await tx.insert(users).values({
      id: ids.vaId,
      email: `etsy-mail-va-${suffix}@example.com`,
      name: "Etsy Mail VA",
      role: "va",
    });
    // The shop the "You made a sale" fixture's body names ("PixelPortraitCo"),
    // also used as the matched-message fixture's order's shop.
    await tx.insert(shops).values({
      id: ids.shopId,
      businessId: ids.businessId,
      platform: "etsy",
      name: "PixelPortraitCo",
      externalShopId: `ext-${suffix}`,
      credentials: {},
      active: true,
    });
    await tx.insert(customers).values({
      id: ids.customerId,
      businessId: ids.businessId,
      email: `harriet-${suffix}@example.com`,
      firstName: "Harriet",
      lastName: "Buyer",
    });
    // An order already in the pipeline whose receipt id matches the
    // new-message-matched fixture ("Order #1780234561").
    await tx.insert(orders).values({
      id: ids.matchedOrderId,
      businessId: ids.businessId,
      shopId: ids.shopId,
      customerId: ids.customerId,
      platformOrderId: "1780234561",
      platformOrderName: "1780234561",
      status: "in_design",
      source: "etsy",
      uploadToken: randomUUID(),
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
      await tx.delete(notifications).where(eq(notifications.businessId, ids.businessId));
      await tx.delete(messages).where(eq(messages.businessId, ids.businessId));
      await tx.delete(orders).where(eq(orders.businessId, ids.businessId));
      await tx.delete(customers).where(eq(customers.businessId, ids.businessId));
      await tx.delete(shops).where(eq(shops.businessId, ids.businessId));
      await tx.delete(users).where(eq(users.id, ids.vaId));
      await tx.delete(businesses).where(eq(businesses.id, ids.businessId));
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  // --- pure parser assertions (no DB) -------------------------------------
  report(
    "recognises Etsy notification senders",
    isEtsyNotificationSender("Etsy <transaction@etsy.com>") &&
      isEtsyNotificationSender("Etsy <no-reply@messages.etsy.com>") &&
      !isEtsyNotificationSender("Customer <buyer@gmail.com>"),
    "transaction.etsy.com and messages.etsy.com match; a real buyer address does not",
  );
  const shippedParsed = parseEtsyEmail({
    subject: "Your order has shipped",
    body: "Order #1780999111 has shipped.\n\n--\nThis email was sent by Etsy, Inc.",
  });
  report(
    "classifies a shipping notice",
    shippedParsed?.kind === "shipped" && shippedParsed?.receiptId === "1780999111",
    JSON.stringify(shippedParsed),
  );
  const marketingParsed = parseEtsyEmail({ subject: "Your weekly shop stats", body: "Views are up 12% this week!" });
  report("ignores non-actionable Etsy mail (no kind match)", marketingParsed === null, JSON.stringify(marketingParsed));

  // --- DB-backed attach/match/unmatched/create-order ----------------------
  await setup();
  try {
    const fixtures = {
      matched: loadFixture("new-message-matched"),
      unmatched: loadFixture("new-message-unmatched"),
      sale: loadFixture("sale-new-order"),
    };
    const client = {
      async getMessage(id: string): Promise<GmailMessage> {
        const f = (fixtures as Record<string, Fixture>)[id];
        if (!f) throw new Error(`no fixture for ${id}`);
        return gmailMessageFromFixture(id, f);
      },
    };

    const summary = await processHistoryMessages({
      client,
      businessId: ids.businessId,
      selfAddress: "orders@example.com",
      historyMessages: [
        { id: "matched", threadId: "thread-matched", labelIds: ["INBOX"] },
        { id: "unmatched", threadId: "thread-unmatched", labelIds: ["INBOX"] },
        { id: "sale", threadId: "thread-sale", labelIds: ["INBOX"] },
      ],
    });
    report(
      "all three Etsy emails attach as new rows (none dropped)",
      summary.attached === 3,
      JSON.stringify(summary),
    );

    const rows = await withSystemContext((tx) =>
      tx
        .select({
          gmailMessageId: messages.gmailMessageId,
          orderId: messages.orderId,
          channel: messages.channel,
          address: messages.address,
          body: messages.body,
          metadata: messages.metadata,
        })
        .from(messages)
        .where(eq(messages.businessId, ids.businessId)),
    );
    const byId = new Map(rows.map((r) => [r.gmailMessageId, r]));
    const matchedRow = byId.get("matched");
    const unmatchedRow = byId.get("unmatched");
    const saleRow = byId.get("sale");

    report(
      "receipt-id match attaches to the existing order, channel etsy, body cleaned of Etsy chrome",
      matchedRow?.channel === "etsy" &&
        matchedRow?.orderId === ids.matchedOrderId &&
        !!matchedRow?.body?.includes("Biscuit") &&
        !matchedRow?.body?.includes("This email was sent by Etsy"),
      JSON.stringify(matchedRow),
    );

    report(
      "no receipt id + unknown buyer lands unmatched (orderId null), never dropped",
      unmatchedRow?.channel === "etsy" && unmatchedRow?.orderId === null && !!unmatchedRow?.body?.includes("multi-pet"),
      JSON.stringify(unmatchedRow),
    );

    const meta = saleRow?.metadata as { createdOrder?: boolean; receiptId?: string } | null;
    report(
      "'You made a sale' for an unseen receipt creates the order and attaches to it",
      saleRow?.channel === "etsy" && !!saleRow?.orderId && meta?.createdOrder === true && meta?.receiptId === "1780555999",
      JSON.stringify({ saleRow, meta }),
    );

    if (saleRow?.orderId) {
      const saleOrderId = saleRow.orderId;
      const [newOrder] = await withSystemContext((tx) =>
        tx
          .select({
            platformOrderId: orders.platformOrderId,
            platformOrderName: orders.platformOrderName,
            status: orders.status,
            source: orders.source,
            shopId: orders.shopId,
            rawImport: orders.rawImport,
          })
          .from(orders)
          .where(eq(orders.id, saleOrderId)),
      );
      report(
        "the created order is a manual: stub in awaiting_details, shopped correctly, raw fields kept",
        newOrder?.platformOrderId === "manual:1780555999" &&
          newOrder?.platformOrderName === "1780555999" &&
          newOrder?.status === "awaiting_details" &&
          newOrder?.source === "manual" &&
          newOrder?.shopId === ids.shopId &&
          (newOrder?.rawImport as { receiptId?: string } | null)?.receiptId === "1780555999",
        JSON.stringify(newOrder),
      );
    } else {
      report("the created order is a manual: stub in awaiting_details, shopped correctly, raw fields kept", false, "no order created");
    }

    // Idempotency: re-running the same history must not double-insert or
    // double-create the order stub.
    const summary2 = await processHistoryMessages({
      client,
      businessId: ids.businessId,
      selfAddress: "orders@example.com",
      historyMessages: [
        { id: "matched", threadId: "thread-matched", labelIds: ["INBOX"] },
        { id: "sale", threadId: "thread-sale", labelIds: ["INBOX"] },
      ],
    });
    const rowsAfter = await withSystemContext((tx) =>
      tx.select({ id: messages.id }).from(messages).where(eq(messages.businessId, ids.businessId)),
    );
    const ordersAfter = await withSystemContext((tx) =>
      tx.select({ id: orders.id }).from(orders).where(eq(orders.businessId, ids.businessId)),
    );
    report(
      "re-polling the same Gmail history is idempotent (no duplicate messages or orders)",
      summary2.attached === 0 && rowsAfter.length === 3 && ordersAfter.length === 2,
      JSON.stringify({ summary2, messageRows: rowsAfter.length, orderRows: ordersAfter.length }),
    );
  } finally {
    await cleanup();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("test-etsy-mail crashed:", error);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
