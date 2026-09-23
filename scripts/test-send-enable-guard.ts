/**
 * Backlog guard (lib/email/backlog-guard.ts): turning customer email sending ON
 * must not flush stale system emails to buyers. Stale = order finished or
 * archived, the email waited STALE_AFTER_DAYS unsent, or an intake email for an
 * order placed longer ago than that. Stale queued rows move to draft (the flush
 * never sends drafts); every stale row carries metadata.skippedOnEnable and
 * shows up in the outbox with its reason. Fresh emails are left alone.
 *
 * Runs only against a LOCAL database (prod holds real PixArt data). Point
 * .env.local at a local Postgres + NEON_LOCAL_WS_PROXY, see docs/PIXART_EMAIL_TEMPLATES.md.
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { businesses, customers, messages, orders, shops, users } from "../lib/db/schema";
import { skipStaleBacklog } from "../lib/email/backlog-guard";
import { getOutbox } from "../lib/email/outbox";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(dbUrl)) {
  console.error("test-send-enable-guard: refusing to run, DATABASE_URL is not a local database.");
  process.exit(2);
}

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const suffix = Date.now();

const ids = {
  businessId: randomUUID(),
  shopId: randomUUID(),
  customerId: randomUUID(),
  adminId: randomUUID(),
};

type Case = {
  key: string;
  orderStatus: "complete" | "awaiting_photos" | "ready_to_assign" | "awaiting_approval" | "in_design";
  orderPlacedDaysAgo: number;
  orderArchived?: boolean;
  msgStatus: "queued" | "draft" | "sent";
  template: "photo_request" | "photo_reminder" | "order_received" | "proof_reminder" | "in_design";
  msgCreatedDaysAgo: number;
  msgArchived?: boolean;
  expectSkipped: boolean;
  expectStatus: "queued" | "draft" | "sent";
};

const cases: Case[] = [
  { key: "queued photo request, order complete", orderStatus: "complete", orderPlacedDaysAgo: 20, msgStatus: "queued", template: "photo_request", msgCreatedDaysAgo: 1, expectSkipped: true, expectStatus: "draft" },
  { key: "queued photo reminder, order placed 10 days ago", orderStatus: "awaiting_photos", orderPlacedDaysAgo: 10, msgStatus: "queued", template: "photo_reminder", msgCreatedDaysAgo: 1, expectSkipped: true, expectStatus: "draft" },
  { key: "queued photo request, fresh order", orderStatus: "awaiting_photos", orderPlacedDaysAgo: 1, msgStatus: "queued", template: "photo_request", msgCreatedDaysAgo: 1, expectSkipped: false, expectStatus: "queued" },
  { key: "draft order received, order placed 12 days ago", orderStatus: "ready_to_assign", orderPlacedDaysAgo: 12, msgStatus: "draft", template: "order_received", msgCreatedDaysAgo: 3, expectSkipped: true, expectStatus: "draft" },
  { key: "draft order received, order placed 2 days ago", orderStatus: "ready_to_assign", orderPlacedDaysAgo: 2, msgStatus: "draft", template: "order_received", msgCreatedDaysAgo: 2, expectSkipped: false, expectStatus: "draft" },
  { key: "draft proof reminder on an old but live order", orderStatus: "awaiting_approval", orderPlacedDaysAgo: 20, msgStatus: "draft", template: "proof_reminder", msgCreatedDaysAgo: 1, expectSkipped: false, expectStatus: "draft" },
  { key: "queued stage email that waited 9 days", orderStatus: "in_design", orderPlacedDaysAgo: 11, msgStatus: "queued", template: "in_design", msgCreatedDaysAgo: 9, expectSkipped: true, expectStatus: "draft" },
  { key: "queued photo request on an archived order", orderStatus: "awaiting_photos", orderPlacedDaysAgo: 2, orderArchived: true, msgStatus: "queued", template: "photo_request", msgCreatedDaysAgo: 1, expectSkipped: true, expectStatus: "draft" },
  { key: "already sent email on a complete order", orderStatus: "complete", orderPlacedDaysAgo: 30, msgStatus: "sent", template: "order_received", msgCreatedDaysAgo: 30, expectSkipped: false, expectStatus: "sent" },
  { key: "discarded (archived) draft", orderStatus: "complete", orderPlacedDaysAgo: 30, msgStatus: "draft", template: "order_received", msgCreatedDaysAgo: 30, msgArchived: true, expectSkipped: false, expectStatus: "draft" },
];
const msgIds = cases.map(() => randomUUID());

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.businessId, name: "Guard Test", slug: `guard-test-${suffix}` });
    await tx.insert(users).values({ id: ids.adminId, email: `guard-admin-${suffix}@example.com`, name: "Guard Admin", role: "admin" });
    await tx.insert(shops).values({
      id: ids.shopId,
      businessId: ids.businessId,
      platform: "shopify",
      name: "Guard Shop",
      externalShopId: `guard-${suffix}`,
      credentials: {},
    });
    await tx.insert(customers).values({
      id: ids.customerId,
      businessId: ids.businessId,
      email: `guard-customer-${suffix}@example.com`,
      firstName: "Robin",
    });
    for (const [i, c] of cases.entries()) {
      const orderId = randomUUID();
      await tx.insert(orders).values({
        id: orderId,
        businessId: ids.businessId,
        shopId: ids.shopId,
        customerId: ids.customerId,
        platformOrderId: `GRD-${suffix}-${i}`,
        platformOrderName: `GRD-${i}`,
        status: c.orderStatus,
        source: "manual",
        uploadToken: randomUUID(),
        placedAt: ago(c.orderPlacedDaysAgo),
        createdAt: ago(c.orderPlacedDaysAgo),
        archivedAt: c.orderArchived ? ago(0) : null,
      });
      await tx.insert(messages).values({
        id: msgIds[i],
        businessId: ids.businessId,
        orderId,
        customerId: ids.customerId,
        direction: "outbound",
        channel: "email",
        status: c.msgStatus,
        templateKey: c.template,
        subject: `Guard ${i}`,
        address: `guard-customer-${suffix}@example.com`,
        body: "test",
        createdAt: ago(c.msgCreatedDaysAgo),
        archivedAt: c.msgArchived ? ago(0) : null,
        sentAt: c.msgStatus === "sent" ? ago(c.msgCreatedDaysAgo) : null,
      });
    }
  });
}

async function cleanup() {
  await withSystemContext(async (tx) => {
    await tx.delete(messages).where(eq(messages.businessId, ids.businessId));
    await tx.delete(orders).where(eq(orders.businessId, ids.businessId));
    await tx.delete(customers).where(eq(customers.businessId, ids.businessId));
    await tx.delete(shops).where(eq(shops.businessId, ids.businessId));
    await tx.delete(users).where(eq(users.id, ids.adminId));
    await tx.delete(businesses).where(eq(businesses.id, ids.businessId));
  });
}

async function main() {
  await setup();
  try {
    const expected = cases.filter((c) => c.expectSkipped).length;
    const expectedQueued = cases.filter((c) => c.expectSkipped && c.msgStatus === "queued").length;
    const first = await withSystemContext((tx) => skipStaleBacklog(tx, ids.businessId, now));
    report(
      `switch-on skips exactly the ${expected} stale emails (${expectedQueued} held back from the queue)`,
      first.skipped === expected && first.heldFromQueue === expectedQueued,
      JSON.stringify(first),
    );

    const rows = await withSystemContext((tx) =>
      tx
        .select({ id: messages.id, status: messages.status, metadata: messages.metadata })
        .from(messages)
        .where(eq(messages.businessId, ids.businessId)),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [i, c] of cases.entries()) {
      const r = byId.get(msgIds[i])!;
      const mark = (r.metadata as { skippedOnEnable?: { reason: string; fromStatus: string } } | null)?.skippedOnEnable;
      const ok = r.status === c.expectStatus && !!mark === c.expectSkipped && (!mark || mark.fromStatus === c.msgStatus);
      report(`${c.key}: ${c.expectSkipped ? "skipped" : "left alone"}, status ${c.expectStatus}`, ok, JSON.stringify({ status: r.status, mark }));
    }

    const stillQueued = rows.filter((r) => r.status === "queued").length;
    report("only the fresh photo request is still queued for the auto flush", stillQueued === 1, `${stillQueued} queued`);

    const outbox = await getOutbox({ id: ids.adminId, role: "admin" }, { businessId: ids.businessId });
    const withReason = outbox.filter((o) => o.skippedReason);
    report(
      "skipped emails stay visible in the outbox with their reason",
      withReason.length === expected && withReason.every((o) => o.status === "draft"),
      JSON.stringify(withReason.map((o) => o.skippedReason)),
    );

    const second = await withSystemContext((tx) => skipStaleBacklog(tx, ids.businessId, now));
    report("a second switch-on skips nothing new", second.skipped === 0, JSON.stringify(second));
  } finally {
    await cleanup();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("test-send-enable-guard crashed:", error);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
