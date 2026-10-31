/**
 * Reminders sweep (lib/reminders/sweep.ts): 48h photo reminder, and for PRINT
 * AND SHIP proofs only a 3-day proof reminder and a day-5 customer.silent Alpha
 * event. Nothing is ever approved on silence and a digital proof gets no
 * follow-up at all (Yousif 2026-10-31: "We also shouldn't be following up on
 * email for digital items ... Just leave it in their court. Even print and ship
 * orders shouldn't go out without final approval from the customer.").
 * Every fire is claimed exactly once via the reminder_fires ledger.
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq, inArray } from "drizzle-orm";
import ws from "ws";

import { withSystemContext } from "../lib/db";
import { sendMessage } from "../lib/email/dispatch";
import * as schema from "../lib/db/schema";
import {
  activityLog,
  alphaEvents,
  businesses,
  customers,
  messages,
  orderItems,
  orders,
  proofs,
  reminderFires,
  shops,
  users,
} from "../lib/db/schema";
import { runRemindersSweep } from "../lib/reminders/sweep";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const suffix = Date.now();

const ids = {
  businessId: randomUUID(),
  shopId: randomUUID(),
  customerId: randomUUID(),
  vaId: randomUUID(),
  // Order A: awaiting_photos, 50h old -> fires the photo reminder.
  orderAId: randomUUID(),
  // Order A2: awaiting_photos, only 10h old -> too soon, no fire.
  orderA2Id: randomUUID(),
  // Order B: physical, proof sent 4 days ago -> 3-day reminder only.
  orderBId: randomUUID(),
  proofBId: randomUUID(),
  // Order C: physical, proof sent 8 days ago -> reminder + silent alert, NEVER approved.
  orderCId: randomUUID(),
  proofCId: randomUUID(),
  // Order D: digital, proof sent 8 days ago -> nothing at all, it is in her court.
  orderDId: randomUUID(),
  proofDId: randomUUID(),
  // Order E: its line says digital but the Etsy receipt has the Print & Ship add-on -> reminded.
  orderEId: randomUUID(),
  proofEId: randomUUID(),
  // Order F: digital, a listing title that only OFFERS print & ship -> left alone.
  orderFId: randomUUID(),
  proofFId: randomUUID(),
};

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.businessId, name: "Reminders Test", slug: `reminders-test-${suffix}` });
    await tx.insert(users).values({ id: ids.vaId, email: `reminders-va-${suffix}@example.com`, name: "Reminders VA", role: "va" });
    await tx.insert(shops).values({
      id: ids.shopId,
      businessId: ids.businessId,
      platform: "shopify",
      name: "Reminders Shop",
      externalShopId: `reminders-${suffix}`,
      credentials: {},
    });
    await tx.insert(customers).values({
      id: ids.customerId,
      businessId: ids.businessId,
      email: `reminders-customer-${suffix}@example.com`,
      firstName: "Riley",
    });

    // Order A: awaiting_photos, past the 48h cutoff.
    await tx.insert(orders).values({
      id: ids.orderAId,
      businessId: ids.businessId,
      shopId: ids.shopId,
      customerId: ids.customerId,
      platformOrderId: `RMA-${suffix}`,
      platformOrderName: "RMA-1",
      status: "awaiting_photos",
      source: "manual",
      uploadToken: randomUUID(),
      createdAt: new Date(now.getTime() - 50 * 60 * 60 * 1000),
    });
    // Order A2: awaiting_photos, well within the 48h window.
    await tx.insert(orders).values({
      id: ids.orderA2Id,
      businessId: ids.businessId,
      shopId: ids.shopId,
      customerId: ids.customerId,
      platformOrderId: `RMA2-${suffix}`,
      platformOrderName: "RMA2-1",
      status: "awaiting_photos",
      source: "manual",
      uploadToken: randomUUID(),
      createdAt: new Date(now.getTime() - 10 * 60 * 60 * 1000),
    });

    // Order B: physical, proof 4 days old.
    await tx.insert(orders).values({
      id: ids.orderBId,
      businessId: ids.businessId,
      shopId: ids.shopId,
      customerId: ids.customerId,
      platformOrderId: `RMB-${suffix}`,
      platformOrderName: "RMB-1",
      status: "awaiting_approval",
      source: "manual",
      uploadToken: randomUUID(),
    });
    await tx.insert(orderItems).values({ businessId: ids.businessId, orderId: ids.orderBId, title: "Portrait", productType: "physical" });
    await tx.insert(proofs).values({
      id: ids.proofBId,
      businessId: ids.businessId,
      orderId: ids.orderBId,
      token: `proof-b-${suffix}`,
      sentAt: new Date(now.getTime() - 4 * DAY),
    });

    // Order C: physical, proof 8 days old (past every threshold, still never approved).
    await tx.insert(orders).values({
      id: ids.orderCId,
      businessId: ids.businessId,
      shopId: ids.shopId,
      customerId: ids.customerId,
      platformOrderId: `RMC-${suffix}`,
      platformOrderName: "RMC-1",
      status: "awaiting_approval",
      source: "manual",
      uploadToken: randomUUID(),
    });
    await tx.insert(orderItems).values({ businessId: ids.businessId, orderId: ids.orderCId, title: "Portrait", productType: "physical" });
    await tx.insert(proofs).values({
      id: ids.proofCId,
      businessId: ids.businessId,
      orderId: ids.orderCId,
      token: `proof-c-${suffix}`,
      sentAt: new Date(now.getTime() - 8 * DAY),
    });

    // Order D: digital, proof 8 days old: no reminder, no alert, no approval.
    await tx.insert(orders).values({
      id: ids.orderDId,
      businessId: ids.businessId,
      shopId: ids.shopId,
      customerId: ids.customerId,
      platformOrderId: `RMD-${suffix}`,
      platformOrderName: "RMD-1",
      status: "awaiting_approval",
      source: "manual",
      uploadToken: randomUUID(),
    });
    await tx.insert(orderItems).values({ businessId: ids.businessId, orderId: ids.orderDId, title: "Digital portrait", productType: "digital" });
    await tx.insert(proofs).values({
      id: ids.proofDId,
      businessId: ids.businessId,
      orderId: ids.orderDId,
      token: `proof-d-${suffix}`,
      sentAt: new Date(now.getTime() - 8 * DAY),
    });

    // Order E: the import missed the physical line, the receipt says Print & Ship.
    await tx.insert(orders).values({
      id: ids.orderEId,
      businessId: ids.businessId,
      shopId: ids.shopId,
      customerId: ids.customerId,
      platformOrderId: `RME-${suffix}`,
      platformOrderName: "RME-1",
      status: "awaiting_approval",
      source: "manual",
      uploadToken: randomUUID(),
      rawImport: {
        transactions: [
          { title: "Custom Pet Portrait From Photo", listing_id: 1000000001, quantity: 1 },
          { title: "Print &amp; Ship My Order - ADD-ON LISTING", listing_id: 1231801819, quantity: 1 },
        ],
      },
    });
    await tx.insert(orderItems).values({ businessId: ids.businessId, orderId: ids.orderEId, title: "Pet portrait", productType: "digital" });
    await tx.insert(proofs).values({
      id: ids.proofEId,
      businessId: ids.businessId,
      orderId: ids.orderEId,
      token: `proof-e-${suffix}`,
      sentAt: new Date(now.getTime() - 4 * DAY),
    });

    // Order F: a digital buy from a listing whose title offers both.
    await tx.insert(orders).values({
      id: ids.orderFId,
      businessId: ids.businessId,
      shopId: ids.shopId,
      customerId: ids.customerId,
      platformOrderId: `RMF-${suffix}`,
      platformOrderName: "RMF-1",
      status: "awaiting_approval",
      source: "manual",
      uploadToken: randomUUID(),
      rawImport: { transactions: [{ title: "Custom Pet Portrait | Digital Download or Print & Ship Canvas", listing_id: 1000000002, quantity: 1 }] },
    });
    await tx.insert(orderItems).values({ businessId: ids.businessId, orderId: ids.orderFId, title: "Pet portrait", productType: "digital" });
    await tx.insert(proofs).values({
      id: ids.proofFId,
      businessId: ids.businessId,
      orderId: ids.orderFId,
      token: `proof-f-${suffix}`,
      sentAt: new Date(now.getTime() - 4 * DAY),
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
      await tx.delete(alphaEvents).where(eq(alphaEvents.businessId, ids.businessId));
      await tx.delete(reminderFires).where(eq(reminderFires.businessId, ids.businessId));
      await tx.delete(messages).where(eq(messages.businessId, ids.businessId));
      await tx.delete(proofs).where(eq(proofs.businessId, ids.businessId));
      await tx.delete(orderItems).where(eq(orderItems.businessId, ids.businessId));
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

async function messageFor(orderId: string, templateKey: string) {
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .select({ status: messages.status, templateKey: messages.templateKey })
      .from(messages)
      .where(eq(messages.orderId, orderId));
    return row?.templateKey === templateKey ? row : null;
  });
}

async function main() {
  await setup();
  try {
    const first = await runRemindersSweep({ businessIds: [ids.businessId], now });

    report(
      "photo reminder candidates: only the 50h-old order, not the 10h-old one",
      first.photoReminders.candidates === 1 && first.photoReminders.fired === 1,
      JSON.stringify(first.photoReminders),
    );
    const photoMsg = await messageFor(ids.orderAId, "photo_reminder");
    report(
      "photo reminder is a queued (auto-send) message, never a draft",
      photoMsg?.status === "queued",
      JSON.stringify(photoMsg),
    );
    const noPhotoMsg = await messageFor(ids.orderA2Id, "photo_reminder");
    report("the too-recent order gets no photo reminder", noPhotoMsg === null, JSON.stringify(noPhotoMsg));

    report(
      "proof reminder fires for the print and ship proofs only (B, C, E), never the digital ones (D, F)",
      first.proofReminders.candidates === 3 && first.proofReminders.fired === 3,
      JSON.stringify(first.proofReminders),
    );
    report("the digital proofs are counted as left in the buyer's court", first.digitalLeftAlone === 2, JSON.stringify(first));
    report("no proof reminder for the digital order D", (await messageFor(ids.orderDId, "proof_reminder")) === null, "");
    report("the Print & Ship add-on on the receipt counts even when the item row says digital (E)", (await messageFor(ids.orderEId, "proof_reminder")) !== null, "");
    report("a listing title that only offers print & ship is still digital (F)", (await messageFor(ids.orderFId, "proof_reminder")) === null, "");
    report(
      "customer.silent alert fires only for the 8-day print proof (C), not the 4-day one (B) or the digital one (D)",
      first.customerSilentAlerts.candidates === 1 && first.customerSilentAlerts.fired === 1,
      JSON.stringify(first.customerSilentAlerts),
    );

    const rows = await withSystemContext((tx) =>
      tx
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(inArray(orders.id, [ids.orderBId, ids.orderCId, ids.orderDId, ids.orderEId, ids.orderFId])),
    );
    const statusOf = (id: string) => rows.find((r) => r.id === id)?.status;
    report(
      "nothing is approved on silence: B, C, D, E and F all still awaiting_approval",
      [ids.orderBId, ids.orderCId, ids.orderDId, ids.orderEId, ids.orderFId].every((id) => statusOf(id) === "awaiting_approval"),
      JSON.stringify(rows),
    );
    const decided = await withSystemContext((tx) =>
      tx.select({ id: proofs.id, decision: proofs.decision }).from(proofs).where(eq(proofs.businessId, ids.businessId)),
    );
    report("no proof carries a decision", decided.every((p) => p.decision == null), JSON.stringify(decided));
    const approvals = await withSystemContext((tx) =>
      tx.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.businessId, ids.businessId)),
    );
    report(
      "no approval written to activity_log",
      !approvals.some((r) => /approv/.test(r.action)),
      JSON.stringify(approvals.map((r) => r.action)),
    );

    const silentEvents = await withSystemContext((tx) =>
      tx.select({ orderId: alphaEvents.orderId, type: alphaEvents.type, text: alphaEvents.text }).from(alphaEvents).where(eq(alphaEvents.businessId, ids.businessId)),
    );
    report(
      "one customer.silent Alpha event, for C, saying it is not printed until approved",
      silentEvents.length === 1 &&
        silentEvents[0]!.orderId === ids.orderCId &&
        silentEvents[0]!.type === "customer.silent" &&
        /not printed until they approve/.test(silentEvents[0]!.text ?? ""),
      JSON.stringify(silentEvents),
    );

    // Idempotency: re-running with the same `now` must not re-fire anything.
    const second = await runRemindersSweep({ businessIds: [ids.businessId], now });
    report(
      "re-running the sweep at the same instant fires nothing new",
      second.photoReminders.fired === 0 && second.proofReminders.fired === 0 && second.customerSilentAlerts.fired === 0,
      JSON.stringify(second),
    );

    // A digital reminder queued before this rule (or tapped by a VA) is withdrawn at send.
    const [queued] = await withSystemContext((tx) =>
      tx
        .insert(messages)
        .values({
          businessId: ids.businessId,
          orderId: ids.orderDId,
          customerId: ids.customerId,
          direction: "outbound",
          channel: "email",
          status: "queued",
          templateKey: "proof_reminder",
          subject: "A reminder about your proof",
          address: `reminders-customer-${suffix}@example.com`,
          body: "Please approve your proof.",
          dedupeKey: `test:${randomUUID()}`,
        })
        .returning({ id: messages.id }),
    );
    const res = await sendMessage(queued!.id);
    const [after] = await withSystemContext((tx) =>
      tx.select({ status: messages.status, archivedAt: messages.archivedAt, metadata: messages.metadata }).from(messages).where(eq(messages.id, queued!.id)),
    );
    report(
      "a queued digital proof reminder is withdrawn, never sent",
      !res.ok && "withdrawn" in res && res.withdrawn === true && after?.status === "draft" && !!after.archivedAt,
      JSON.stringify({ res, after }),
    );
  } finally {
    await cleanup();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("test-reminders crashed:", error);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
