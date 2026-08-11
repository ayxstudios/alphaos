/**
 * Notification SLA sweep invariants: first fire, duplicate suppression,
 * repeat escalation windows, stale-shop refire, and the in-app-only presence gap.
 */
import "./load-env";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import {
  assignments,
  businesses,
  designerBusinesses,
  designerProfiles,
  notificationFires,
  notifications,
  orders,
  shops,
  users,
} from "../lib/db/schema";
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
    await tx.delete(notifications).where(eq(notifications.businessId, ids.businessId));
    await tx.delete(notificationFires).where(eq(notificationFires.businessId, ids.businessId));
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
      "first sweep fires overdue, escalation, and stale shop alerts",
      first.fired === 3 &&
        byType.fires[ALERT_TYPES.orderOverdue] === 1 &&
        byType.fires[ALERT_TYPES.orderOverdueEscalated] === 1 &&
        byType.fires[ALERT_TYPES.shopSyncStale] === 1,
      JSON.stringify({ first, byType }),
    );

    const second = await runNotificationSweep(now, { businessIds: [ids.businessId] });
    byType = await counts();
    report(
      "same sweep window is idempotent",
      second.fired === 0 &&
        byType.fires[ALERT_TYPES.orderOverdue] === 1 &&
        byType.fires[ALERT_TYPES.orderOverdueEscalated] === 1 &&
        byType.fires[ALERT_TYPES.shopSyncStale] === 1,
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
