/**
 * Reminders sweep (lib/reminders/sweep.ts): 48h photo reminder, 3-day proof
 * reminder, day-5 customer.silent Alpha event, and the day-7 silence
 * auto-approve rule (physical orders only — digital never auto-approves).
 * Every fire is claimed exactly once via the reminder_fires ledger.
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq, inArray } from "drizzle-orm";
import ws from "ws";

import { withSystemContext } from "../lib/db";
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
import { AUTO_APPROVE_REASON, runRemindersSweep } from "../lib/reminders/sweep";

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
  // Order C: physical, proof sent 8 days ago -> reminder + silent alert + auto-approve.
  orderCId: randomUUID(),
  proofCId: randomUUID(),
  // Order D: digital, proof sent 8 days ago -> reminder + silent alert, NEVER auto-approve.
  orderDId: randomUUID(),
  proofDId: randomUUID(),
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

    // Order C: physical, proof 8 days old (past every threshold).
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

    // Order D: digital, proof 8 days old — must NOT auto-approve.
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
      "proof reminder fires for all three aged proofs (B, C, D all past 3 days)",
      first.proofReminders.candidates === 3 && first.proofReminders.fired === 3,
      JSON.stringify(first.proofReminders),
    );
    report(
      "customer.silent alert fires only for the two 8-day proofs (C, D), not the 4-day one (B)",
      first.customerSilentAlerts.candidates === 2 && first.customerSilentAlerts.fired === 2,
      JSON.stringify(first.customerSilentAlerts),
    );
    report(
      "auto-approve fires only for the physical 8-day proof (C), never the digital one (D)",
      first.autoApprovals.candidates === 1 && first.autoApprovals.fired === 1 && first.autoApprovals.failed === 0,
      JSON.stringify(first.autoApprovals),
    );

    const [orderC, orderD, orderB] = await withSystemContext((tx) =>
      tx
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(inArray(orders.id, [ids.orderCId, ids.orderDId, ids.orderBId])),
    ).then((rows) => [ids.orderCId, ids.orderDId, ids.orderBId].map((id) => rows.find((r) => r.id === id)));
    report("order C (physical, 8 days silent) is now approved", orderC?.status === "approved", JSON.stringify(orderC));
    report("order D (digital, 8 days silent) is untouched, still awaiting_approval", orderD?.status === "awaiting_approval", JSON.stringify(orderD));
    report("order B (physical, only 4 days silent) is untouched, still awaiting_approval", orderB?.status === "awaiting_approval", JSON.stringify(orderB));

    const [proofCRow] = await withSystemContext((tx) =>
      tx.select({ decision: proofs.decision }).from(proofs).where(eq(proofs.id, ids.proofCId)),
    );
    report("proof C carries the approved decision", proofCRow?.decision === "approved", JSON.stringify(proofCRow));

    const autoApproveLog = await withSystemContext((tx) =>
      tx.select({ metadata: activityLog.metadata }).from(activityLog).where(eq(activityLog.orderId, ids.orderCId)),
    );
    const hasReason = autoApproveLog.some(
      (r) => (r.metadata as { autoApproveReason?: string } | null)?.autoApproveReason === AUTO_APPROVE_REASON,
    );
    report(
      "activity_log records the exact silence auto-approve reason",
      hasReason,
      JSON.stringify(autoApproveLog.map((r) => r.metadata)),
    );

    const silentEvents = await withSystemContext((tx) =>
      tx.select({ orderId: alphaEvents.orderId, type: alphaEvents.type }).from(alphaEvents).where(eq(alphaEvents.businessId, ids.businessId)),
    );
    report(
      "customer.silent Alpha events queued for C and D only",
      silentEvents.length === 2 && silentEvents.every((e) => e.type === "customer.silent"),
      JSON.stringify(silentEvents),
    );

    // Idempotency: re-running with the same `now` must not re-fire anything —
    // order C already left awaiting_approval, and B/D's claims already exist.
    const second = await runRemindersSweep({ businessIds: [ids.businessId], now });
    report(
      "re-running the sweep at the same instant fires nothing new",
      second.photoReminders.fired === 0 &&
        second.proofReminders.fired === 0 &&
        second.customerSilentAlerts.fired === 0 &&
        second.autoApprovals.fired === 0,
      JSON.stringify(second),
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
