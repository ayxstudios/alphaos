/**
 * Notification SLA sweep invariants: first fire, duplicate suppression,
 * repeat escalation windows, stale-shop refire, the in-app-only presence gap,
 * and unmatched replies older than 24h (people only: notifications and
 * marketing mail never alert, and never count in the daily health report).
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import {
  alphaEvents,
  assignments,
  businesses,
  designerBusinesses,
  designerProfiles,
  messages,
  notificationFires,
  notifications,
  orders,
  shops,
  users,
} from "../lib/db/schema";
import { loadHealthMetricsForSystem } from "../lib/health/daily-report";
import { runNotificationSweep } from "../lib/notifications/sla-sweep";
import { ALERT_TYPES } from "../lib/notifications/types";

let failures = 0;
const ids = {
  businessId: randomUUID(),
  shopId: randomUUID(),
  adminId: randomUUID(),
  vaId: randomUUID(),
  designerId: randomUUID(),
  orderId: randomUUID(),
  personMailId: randomUUID(),
  noiseMailIds: [randomUUID(), randomUUID(), randomUUID()],
};

function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

async function counts() {
  return withSystemContext(async (tx) => {
    const fireRows = await tx
      .select({ type: notificationFires.alertType, count: sql<number>`count(*)::int` })
      .from(notificationFires)
      .where(eq(notificationFires.businessId, ids.businessId))
      .groupBy(notificationFires.alertType);
    const notificationRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(eq(notifications.businessId, ids.businessId));
    return {
      fires: Object.fromEntries(fireRows.map((row) => [row.type, row.count])),
      notifications: notificationRows[0]?.count ?? 0,
    };
  });
}

async function setup(now: Date) {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.businessId, name: "Sweep Test", slug: `sweep-${Date.now()}` });
    await tx.insert(users).values([
      { id: ids.adminId, email: `admin-${Date.now()}@example.com`, name: "Sweep Admin", role: "admin" },
      { id: ids.vaId, email: `va-${Date.now()}@example.com`, name: "Sweep VA", role: "va" },
      { id: ids.designerId, email: `designer-${Date.now()}@example.com`, name: "Sweep Designer", role: "designer" },
    ]);
    await tx.insert(designerProfiles).values({ userId: ids.designerId, dailyCapacity: 10 });
    await tx.insert(designerBusinesses).values({ userId: ids.designerId, businessId: ids.businessId });
    await tx.insert(shops).values({
      id: ids.shopId,
      businessId: ids.businessId,
      platform: "shopify",
      name: "Sweep Shop",
      externalShopId: `sweep-${Date.now()}`,
      credentials: {},
      integrationConfig: { lastSyncAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() },
    });
    await tx.insert(orders).values({
      id: ids.orderId,
      businessId: ids.businessId,
      shopId: ids.shopId,
      platformOrderId: `SWEEP-${Date.now()}`,
      platformOrderName: "SWEEP-1",
      status: "in_design",
      source: "manual",
      dueAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      uploadToken: randomUUID(),
    });
    // Unmatched inbound mail, two days old: one person, three notifications / marketing.
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const inbound = { businessId: ids.businessId, direction: "inbound" as const, status: "received" as const, createdAt: old };
    await tx.insert(messages).values([
      { ...inbound, id: ids.personMailId, channel: "email", address: "Jane Doe <jane.doe@gmail.com>", subject: "Re: my portrait" },
      { ...inbound, id: ids.noiseMailIds[0]!, channel: "email", address: "Shopify <mailer@shopify.com>", subject: "[Shopify] Order #1001 placed" },
      { ...inbound, id: ids.noiseMailIds[1]!, channel: "email", address: "newsletter@supplier.com", subject: "September news" },
      { ...inbound, id: ids.noiseMailIds[2]!, channel: "etsy", address: "Etsy", subject: "You made a sale on Etsy", metadata: { kind: "sale" } },
    ]);
    await tx.insert(assignments).values({
      businessId: ids.businessId,
      orderId: ids.orderId,
      designerId: ids.designerId,
      active: true,
      dueAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
  });
}

async function cleanup() {
  await withSystemContext(async (tx) => {
    await tx.delete(alphaEvents).where(eq(alphaEvents.businessId, ids.businessId));
    await tx.delete(notifications).where(eq(notifications.businessId, ids.businessId));
    await tx.delete(notificationFires).where(eq(notificationFires.businessId, ids.businessId));
    await tx.delete(messages).where(eq(messages.businessId, ids.businessId));
    await tx.delete(orders).where(eq(orders.id, ids.orderId));
    await tx.delete(shops).where(eq(shops.id, ids.shopId));
    await tx.delete(designerBusinesses).where(eq(designerBusinesses.businessId, ids.businessId));
    await tx.delete(designerProfiles).where(eq(designerProfiles.userId, ids.designerId));
    await tx.delete(users).where(inArray(users.id, [ids.adminId, ids.vaId, ids.designerId]));
    await tx.delete(businesses).where(eq(businesses.id, ids.businessId));
  });
}

async function main() {
  const now = new Date();
  try {
    await setup(now);

    const first = await runNotificationSweep(now, { businessIds: [ids.businessId] });
    let byType = await counts();
    report(
      "first sweep fires overdue, escalation, stale shop and one unmatched reply alert",
      first.fired === 4 &&
        byType.fires[ALERT_TYPES.orderOverdue] === 1 &&
        byType.fires[ALERT_TYPES.orderOverdueEscalated] === 1 &&
        byType.fires[ALERT_TYPES.shopSyncStale] === 1 &&
        byType.fires[ALERT_TYPES.mailUnmatchedReplyStale] === 1,
      JSON.stringify({ first, byType }),
    );

    const mailFires = await withSystemContext((tx) =>
      tx
        .select({ subjectId: notificationFires.subjectId })
        .from(notificationFires)
        .where(eq(notificationFires.alertType, ALERT_TYPES.mailUnmatchedReplyStale)),
    );
    const firedFor = new Set(mailFires.map((r) => r.subjectId));
    report(
      "notification and marketing mail never raises an unmatched reply alert",
      firedFor.has(ids.personMailId) && ids.noiseMailIds.every((id) => !firedFor.has(id)),
      JSON.stringify({ person: firedFor.has(ids.personMailId), noise: ids.noiseMailIds.map((id) => firedFor.has(id)) }),
    );

    const health = await loadHealthMetricsForSystem({ kind: "business", businessId: ids.businessId, businessName: "Sweep Test" });
    report(
      "daily health counts only the person's mail as a stale unmatched reply",
      health.pipeline.staleUnmatchedReplies === 1,
      JSON.stringify({ staleUnmatchedReplies: health.pipeline.staleUnmatchedReplies }),
    );

    const second = await runNotificationSweep(now, { businessIds: [ids.businessId] });
    byType = await counts();
    report(
      "same sweep window is idempotent",
      second.fired === 0 &&
        byType.fires[ALERT_TYPES.orderOverdue] === 1 &&
        byType.fires[ALERT_TYPES.orderOverdueEscalated] === 1 &&
        byType.fires[ALERT_TYPES.shopSyncStale] === 1 &&
        byType.fires[ALERT_TYPES.mailUnmatchedReplyStale] === 1,
      JSON.stringify({ second, byType }),
    );

    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const third = await runNotificationSweep(later, { businessIds: [ids.businessId] });
    byType = await counts();
    report(
      "escalations refire in later windows while ordinary overdue stays once",
      third.fired >= 3 &&
        byType.fires[ALERT_TYPES.orderOverdue] === 1 &&
        byType.fires[ALERT_TYPES.orderOverdueEscalated] === 2 &&
        byType.fires[ALERT_TYPES.shopSyncStale]! >= 2 &&
        byType.fires[ALERT_TYPES.notificationPresenceGap] === 1,
      JSON.stringify({ third, byType }),
    );
  } finally {
    await cleanup();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("test-notification-sweep crashed:", error);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
