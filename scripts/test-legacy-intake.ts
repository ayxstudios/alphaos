// Legacy/Trello intake + unindexed products against the DEMO database
// (Northlight Portraits). Creates its own synthetic rows (marker "legacytest-"),
// archives/deletes them at the end and restores the business switches.
// Never run against staging or production.
import "./load-env";

import { randomUUID } from "node:crypto";

if (!process.env.ANTHROPIC_API_KEY?.startsWith("mock_")) process.env.ANTHROPIC_API_KEY = "mock_sk-ant-legacytest";

import { and, eq, like, sql } from "drizzle-orm";

import { runAgentTick } from "../lib/agent/autopilot";
import { confirmLegacyOrder, listDesignerChoices, pickDesignerForProduct } from "../lib/agent/legacy-intake";
import { withSystemContext } from "../lib/db";
import {
  assignments,
  businesses,
  customers,
  designerProfiles,
  exceptions,
  messages,
  orderItems,
  orders,
  shops,
  styles,
  users,
} from "../lib/db/schema";
import { runAutoAssign } from "../lib/orders/assign";
import { planImport, runImport, type TrelloBoard } from "./import-trello";

const BUSINESS_NAME = "Northlight Portraits";
const MARK = "legacytest-";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

async function main() {
  const [biz] = await withSystemContext((tx) =>
    tx
      .select({
        id: businesses.id,
        intake: businesses.agentIntakeEnabled,
        assign: businesses.agentAssignEnabled,
        inbox: businesses.agentInboxEnabled,
        autoSend: businesses.stageEmailAutoSend,
        config: businesses.agentConfig,
      })
      .from(businesses)
      .where(eq(businesses.name, BUSINESS_NAME)),
  );
  if (!biz) throw new Error(`demo business ${BUSINESS_NAME} not found: is .env.local the DEMO database?`);
  const businessId = biz.id;
  const [shop] = await withSystemContext((tx) =>
    tx.select({ id: shops.id }).from(shops).where(and(eq(shops.businessId, businessId), eq(shops.platform, "etsy"))),
  );
  if (!shop) throw new Error("demo business has no Etsy shop");
  const [admin] = await withSystemContext((tx) =>
    tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.active, true))).limit(1),
  );
  if (!admin) throw new Error("no admin user in the demo db");
  const staff = { id: admin.id, role: "admin" as const };

  const designers = await withSystemContext((tx) => listDesignerChoices(tx, businessId));
  if (!designers.length) throw new Error("demo business has no human designer");
  const designer = designers[0];
  const designerBefore = await withSystemContext(async (tx) =>
    (await tx.select({ styles: designerProfiles.styles }).from(designerProfiles).where(eq(designerProfiles.userId, designer.id)))[0]?.styles ?? [],
  );
  // Capacity is restored at the end: repeated runs on the same day would
  // otherwise exhaust the demo designer's daily cap and the routing check
  // would test capacity instead of the style mapping.
  const [capBefore] = await withSystemContext((tx) =>
    tx
      .select({ daily: designerProfiles.dailyCapacity, maxActive: designerProfiles.maxActiveOrders })
      .from(designerProfiles)
      .where(eq(designerProfiles.userId, designer.id)),
  );

  const [shopBefore] = await withSystemContext((tx) =>
    tx.select({ config: shops.integrationConfig }).from(shops).where(eq(shops.id, shop.id)),
  );
  const stamp = Date.now().toString(36);
  const productTitle = `${MARK}Marble Bust Sculpture ${stamp}`;
  const cleanupOrders: string[] = [];
  const cleanupStyles: string[] = [];

  try {
    // Leftovers from an earlier run leave the live set (Trello fixtures are deleted:
    // an archived row would still hold the card id and block the import).
    await withSystemContext(async (tx) => {
      await tx.delete(orders).where(and(eq(orders.businessId, businessId), like(orders.trelloCardId, "trellotest-%")));
      await tx
        .update(orders)
        .set({ archivedAt: new Date(), archiveReason: "legacy intake test leftover" })
        .where(and(eq(orders.businessId, businessId), like(orders.platformOrderId, `%${MARK}%`), sql`${orders.archivedAt} is null`));
      await tx.update(exceptions).set({ status: "resolved", resolvedAt: new Date(), resolutionNote: "test leftover" }).where(
        and(eq(exceptions.businessId, businessId), eq(exceptions.status, "open"), sql`${exceptions.detail}::text like ${"%" + MARK + "%"}`),
      );
    });

    await withSystemContext((tx) =>
      tx
        .update(businesses)
        .set({
          agentIntakeEnabled: true,
          agentAssignEnabled: false,
          agentInboxEnabled: true,
          stageEmailAutoSend: false,
          agentConfig: { ...(biz.config ?? {}), autoSendReplies: false, inboxEnabledAt: new Date(Date.now() - 60_000).toISOString() },
        })
        .where(eq(businesses.id, businessId)),
    );

    // ======================================================================
    // Flow 1: unmatched email -> legacy stub + card -> confirm -> normal order
    // ======================================================================
    console.log("\n-- flow 1: legacy order --");
    const orderNo = `88${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
    const buyer = `${MARK}${stamp}@example.test`;
    const thread = `${MARK}thread-${randomUUID()}`;
    const mkMsg = (subject: string, body: string) =>
      withSystemContext(async (tx) => {
        const [m] = await tx
          .insert(messages)
          .values({
            businessId,
            orderId: null,
            direction: "inbound",
            channel: "email",
            status: "received",
            subject,
            address: `Dana Buyer <${buyer}>`,
            body,
            gmailThreadId: thread,
          })
          .returning({ id: messages.id });
        return m.id;
      });
    const m1 = await mkMsg(`Order #${orderNo} - where is my portrait?`, `Hi, I ordered a family portrait (order #${orderNo}) a month ago and have not heard anything. Can you check on it?`);

    const t1 = await runAgentTick({ businessId });
    check("tick 1: no errors", (t1.businesses[0]?.errors.length ?? 1) === 0, JSON.stringify(t1.businesses[0]?.errors));

    const stub1 = await withSystemContext(async (tx) => {
      const o = await tx.select().from(orders).where(and(eq(orders.businessId, businessId), eq(orders.platformOrderName, orderNo)));
      const [msg] = await tx.select({ orderId: messages.orderId }).from(messages).where(eq(messages.id, m1));
      const cards = await tx
        .select()
        .from(exceptions)
        .where(and(eq(exceptions.businessId, businessId), eq(exceptions.kind, "legacy_order"), eq(exceptions.status, "open"), sql`${exceptions.detail}->>'orderNumber' = ${orderNo}`));
      return { o, msg, cards };
    });
    cleanupOrders.push(...stub1.o.map((o) => o.id));
    const stub = stub1.o[0];
    check("stub: exactly one legacy order created", stub1.o.length === 1 && stub?.source === "legacy" && stub.status === "awaiting_details");
    check("stub: number and buyer parsed", stub?.platformOrderName === orderNo && JSON.stringify(stub.rawImport).includes(buyer));
    check("stub: thread attached to the stub", stub1.msg?.orderId === stub?.id);
    check(
      "stub: one card with the exact wording",
      stub1.cards.length === 1 && stub1.cards[0].summary === "Order not in AlphaOS yet. Check it on Trello, then confirm the details here.",
    );

    // Idempotent: a second email (same thread, then a new thread) joins the same stub.
    const m2 = await mkMsg(`Re: Order #${orderNo}`, "Following up, any news?");
    await runAgentTick({ businessId });
    const after2 = await withSystemContext(async (tx) => ({
      o: await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.businessId, businessId), eq(orders.platformOrderName, orderNo))),
      msg: (await tx.select({ orderId: messages.orderId }).from(messages).where(eq(messages.id, m2)))[0],
      cards: await tx
        .select({ id: exceptions.id })
        .from(exceptions)
        .where(and(eq(exceptions.businessId, businessId), eq(exceptions.kind, "legacy_order"), eq(exceptions.status, "open"), sql`${exceptions.detail}->>'orderNumber' = ${orderNo}`)),
    }));
    check("idempotent: second email attaches to the same stub", after2.o.length === 1 && after2.msg?.orderId === stub?.id, JSON.stringify({ n: after2.o.length, msg: after2.msg?.orderId, stub: stub?.id }));
    check("idempotent: still one open card", after2.cards.length === 1);

    // Confirm.
    const bad = await confirmLegacyOrder(staff, { exceptionId: stub1.cards[0].id, style: "", figureCount: 2, productType: "digital", dueAt: "2026-11-01" });
    check("confirm: refuses a missing style", !bad.ok);
    const styleName = (
      await withSystemContext((tx) => tx.select({ name: styles.name }).from(styles).where(and(eq(styles.businessId, businessId), eq(styles.autoCreated, false))).limit(1))
    )[0]?.name;
    if (!styleName) throw new Error("demo business has no catalog style");
    const done = await confirmLegacyOrder(staff, {
      exceptionId: stub1.cards[0].id,
      style: styleName,
      figureCount: 2,
      productType: "digital",
      dueAt: "2026-11-01",
      customerName: "Dana Buyer",
      customerEmail: buyer,
    });
    check("confirm: ok", done.ok, JSON.stringify(done));
    const confirmed = await withSystemContext(async (tx) => ({
      o: (await tx.select().from(orders).where(eq(orders.id, stub.id)))[0],
      items: await tx.select({ style: orderItems.style, figureCount: orderItems.figureCount }).from(orderItems).where(eq(orderItems.orderId, stub.id)),
      card: (await tx.select({ status: exceptions.status }).from(exceptions).where(eq(exceptions.id, stub1.cards[0].id)))[0],
    }));
    check(
      "confirm: now a normal order (leaves awaiting_details, review flag cleared, item saved)",
      !!confirmed.o && ["awaiting_photos", "ready_to_assign", "in_design"].includes(confirmed.o.status) && !confirmed.o.needsReview && confirmed.items[0]?.style === styleName && confirmed.items[0]?.figureCount === 2,
      JSON.stringify({ status: confirmed.o?.status, items: confirmed.items }),
    );
    check("confirm: card resolved and due date saved", confirmed.card?.status === "resolved" && !!confirmed.o?.dueAt);
    const again = await confirmLegacyOrder(staff, { exceptionId: stub1.cards[0].id, style: styleName, figureCount: 2, productType: "digital", dueAt: "2026-11-01" });
    check("confirm: a second confirm is refused", !again.ok);

    // The demo shop may name a default style or title rules, which would make
    // every listing "known". Flow 2 needs a shop with none (restored at the end).
    await withSystemContext((tx) => {
      const c = { ...((shopBefore.config ?? {}) as Record<string, unknown>) };
      delete c.defaultStyle;
      delete c.styleRules;
      delete c.titleStyleRules;
      return tx.update(shops).set({ integrationConfig: c }).where(eq(shops.id, shop.id));
    });

    // ======================================================================
    // Flow 2: unknown product -> auto style + pick-designer card -> pick -> route
    // ======================================================================
    console.log("\n-- flow 2: unindexed product --");
    const mkEtsy = (label: string, title: string) =>
      withSystemContext(async (tx) => {
        const [cust] = await tx
          .insert(customers)
          .values({ businessId, email: `${MARK}${label}-${stamp}@example.test`, firstName: "Legacy", lastName: "Test" })
          .returning({ id: customers.id });
        const [o] = await tx
          .insert(orders)
          .values({
            businessId,
            shopId: shop.id,
            customerId: cust.id,
            platformOrderId: `${MARK}etsy-${label}-${stamp}`,
            platformOrderName: `${MARK}${label}-${stamp}`,
            status: "awaiting_details",
            source: "etsy",
            uploadToken: randomUUID(),
            rawImport: {
              receipt_id: 0,
              transactions: [
                {
                  transaction_id: 1,
                  title,
                  sku: null,
                  quantity: 1,
                  is_digital: true,
                  listing_id: null,
                  variations: [{ formatted_name: "Number of Pets", formatted_value: "1" }],
                },
              ],
            },
          })
          .returning({ id: orders.id });
        cleanupOrders.push(o.id);
        return o.id;
      });
    const before = await withSystemContext((tx) => tx.select({ id: styles.id }).from(styles).where(eq(styles.businessId, businessId)));
    const oA = await mkEtsy("a", productTitle);
    const oB = await mkEtsy("b", productTitle);
    const t2 = await runAgentTick({ businessId });
    check("tick 2: no errors", (t2.businesses[0]?.errors.length ?? 1) === 0, JSON.stringify(t2.businesses[0]?.errors));
    const f2 = await withSystemContext(async (tx) => {
      const created = await tx.select().from(styles).where(and(eq(styles.businessId, businessId), eq(styles.listingTitle, productTitle)));
      const cards = await tx
        .select()
        .from(exceptions)
        .where(and(eq(exceptions.businessId, businessId), eq(exceptions.kind, "new_product"), eq(exceptions.status, "open"), sql`${exceptions.detail}->>'title' = ${productTitle}`));
      const os = await tx.select({ id: orders.id, status: orders.status }).from(orders).where(sql`${orders.id} in (${oA}, ${oB})`);
      const intakeCards = await tx
        .select({ id: exceptions.id })
        .from(exceptions)
        .where(and(eq(exceptions.status, "open"), eq(exceptions.kind, "intake_unparsed"), sql`${exceptions.orderId} in (${oA}, ${oB})`));
      return { created, cards, os, intakeCards };
    });
    cleanupStyles.push(...f2.created.map((s) => s.id));
    const sty = f2.created[0];
    check("product: one catalog row auto-created", f2.created.length === 1 && sty.autoCreated && sty.aiDesignerEnabled === false && before.length + 1 > 0);
    check("product: matched by the exact listing title, no designer yet", !!sty && sty.titleMatches.includes(productTitle));
    check("product: one card for both orders, exact wording", f2.cards.length === 1 && f2.cards[0].summary === `New product: ${productTitle}. Pick who draws it.`, JSON.stringify(f2.cards.map((c) => c.summary)));
    check("product: card lists both waiting orders", ((f2.cards[0]?.detail as { orderIds?: string[] })?.orderIds ?? []).length === 2);
    check("product: orders held, not dropped, no intake_unparsed noise", f2.os.every((o) => o.status === "awaiting_details") && f2.intakeCards.length === 0);
    const opts = await withSystemContext((tx) => listDesignerChoices(tx, businessId));
    check("picker: lists this business's designers with open counts", opts.length >= 1 && opts.every((d) => typeof d.openCount === "number"));

    const pickBad = await pickDesignerForProduct(staff, { exceptionId: f2.cards[0].id, designerId: "not-a-designer" });
    check("pick: refuses a non-designer", !pickBad.ok);
    const pick = await pickDesignerForProduct(staff, { exceptionId: f2.cards[0].id, designerId: designer.id });
    check("pick: ok", pick.ok, JSON.stringify(pick));
    const afterPick = await withSystemContext(async (tx) => ({
      s: (await tx.select().from(styles).where(eq(styles.id, sty.id)))[0],
      p: (await tx.select({ styles: designerProfiles.styles }).from(designerProfiles).where(eq(designerProfiles.userId, designer.id)))[0],
      c: (await tx.select({ status: exceptions.status }).from(exceptions).where(eq(exceptions.id, f2.cards[0].id)))[0],
    }));
    check("pick: mapping saved (designer has the style, row no longer unmapped, card resolved)", afterPick.p?.styles?.includes(sty.name) === true && afterPick.s.autoCreated === false && afterPick.c?.status === "resolved");

    const t3 = await runAgentTick({ businessId });
    check("tick 3: no errors", (t3.businesses[0]?.errors.length ?? 1) === 0, JSON.stringify(t3.businesses[0]?.errors));
    const f3 = await withSystemContext(async (tx) => ({
      os: await tx.select({ id: orders.id, status: orders.status }).from(orders).where(sql`${orders.id} in (${oA}, ${oB})`),
      items: await tx.select({ style: orderItems.style }).from(orderItems).where(sql`${orderItems.orderId} in (${oA}, ${oB})`),
    }));
    check("waiting orders complete on the next tick with the new style", f3.os.every((o) => o.status !== "awaiting_details") && f3.items.length === 2 && f3.items.every((i) => i.style === sty.name), JSON.stringify(f3));

    // A brand-new order of the same product routes with no card at all.
    const oC = await mkEtsy("c", productTitle);
    await runAgentTick({ businessId });
    const routed = await withSystemContext(async (tx) => {
      await tx.update(designerProfiles).set({ dailyCapacity: 100000, maxActiveOrders: 0 }).where(eq(designerProfiles.userId, designer.id));
      await tx.update(orders).set({ status: "ready_to_assign" }).where(eq(orders.id, oC));
      const r = await runAutoAssign(tx, { orderId: oC, businessId, assignedBy: null });
      const [a] = await tx.select({ designerId: assignments.designerId }).from(assignments).where(and(eq(assignments.orderId, oC), eq(assignments.active, true)));
      const cards = await tx
        .select({ id: exceptions.id })
        .from(exceptions)
        .where(and(eq(exceptions.status, "open"), sql`${exceptions.orderId} = ${oC}`));
      return { r, a, cards };
    });
    check("future order: no new card, auto-assigned to the picked designer", routed.cards.length === 0 && routed.a?.designerId === designer.id, JSON.stringify(routed));

    // ======================================================================
    // Flow 3: importer dry-run on a small fixture
    // ======================================================================
    console.log("\n-- flow 3: trello importer --");
    const { readFile } = await import("node:fs/promises");
    const board = JSON.parse(await readFile(new URL("./fixtures/trello-board.sample.json", import.meta.url), "utf8")) as TrelloBoard;
    const { plan, skipped } = planImport(board);
    check("plan: 3 cards mapped, archive list and closed card skipped", plan.length === 3 && skipped.length === 2, JSON.stringify({ plan: plan.length, skipped }));
    check("plan: list -> stage mapping", plan.find((p) => p.cardId === "trellotest-c2")?.stage === "in_design" && plan.find((p) => p.cardId === "trellotest-c3")?.stage === "complete");
    const c1 = plan.find((p) => p.cardId === "trellotest-c1");
    check("plan: due date, labels and attachment link carried", !!c1?.dueAt && c1.notes.includes("Rush") && c1.notes.includes("dogs.jpg"));

    const countTrello = () =>
      withSystemContext(async (tx) => Number((await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.businessId, businessId), like(orders.trelloCardId, "trellotest-%"))))[0].n));
    const n0 = await countTrello();
    const dry = await runImport({ business: BUSINESS_NAME, board, dryRun: true });
    check("dry-run: reports 3 would-create and writes nothing", dry.created === 3 && (await countTrello()) === n0 && dry.lines.some((l) => l.startsWith("would create")), dry.lines.join(" | "));

    const real = await runImport({ business: BUSINESS_NAME, board, dryRun: false });
    const created = await withSystemContext((tx) => tx.select({ id: orders.id, source: orders.source, status: orders.status, card: orders.trelloCardId }).from(orders).where(and(eq(orders.businessId, businessId), like(orders.trelloCardId, "trellotest-%"))));
    check("real run: 3 trello orders with the right source", real.created === 3 && created.length === n0 + 3 && created.every((o) => o.source === "trello"));
    const rerun = await runImport({ business: BUSINESS_NAME, board, dryRun: false });
    check("re-run: every card skipped as already imported", rerun.created === 0 && rerun.alreadyImported === 3 && (await countTrello()) === n0 + 3);
  } finally {
    await withSystemContext(async (tx) => {
      await tx.delete(orders).where(and(eq(orders.businessId, businessId), like(orders.trelloCardId, "trellotest-%")));
      const ids = cleanupOrders;
      if (ids.length) {
        await tx.update(assignments).set({ active: false }).where(sql`${assignments.orderId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
        await tx
          .update(orders)
          .set({ archivedAt: new Date(), archiveReason: "legacy intake test cleanup" })
          .where(sql`${orders.id} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and ${orders.archivedAt} is null`);
        await tx.update(exceptions).set({ status: "resolved", resolvedAt: new Date(), resolutionNote: "test cleanup" }).where(
          sql`${exceptions.status} = 'open' and ${exceptions.orderId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
        );
      }
      await tx.update(exceptions).set({ status: "resolved", resolvedAt: new Date(), resolutionNote: "test cleanup" }).where(
        and(eq(exceptions.businessId, businessId), eq(exceptions.status, "open"), sql`${exceptions.detail}::text like ${"%" + MARK + "%"}`),
      );
      await tx.update(shops).set({ integrationConfig: shopBefore.config }).where(eq(shops.id, shop.id));
      await tx
        .update(designerProfiles)
        .set({ styles: designerBefore, dailyCapacity: capBefore.daily, maxActiveOrders: capBefore.maxActive })
        .where(eq(designerProfiles.userId, designer.id));
      await tx
        .update(businesses)
        .set({ agentIntakeEnabled: biz.intake, agentAssignEnabled: biz.assign, agentInboxEnabled: biz.inbox, stageEmailAutoSend: biz.autoSend, agentConfig: biz.config })
        .where(eq(businesses.id, businessId));
    });
    for (const id of cleanupStyles) {
      await withSystemContext((tx) => tx.delete(styles).where(eq(styles.id, id))).catch(() => {
        console.log(`note: style ${id} is still referenced and was left in place`);
      });
    }
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL PASS: legacy intake checks");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
