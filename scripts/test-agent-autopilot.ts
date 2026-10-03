// Agent autopilot tick against the DEMO database (Northlight Portraits).
// Creates its own synthetic orders (platform ids "agenttest-*"), archives the
// ones a previous run left behind, and always switches the agent flags back
// off at the end. Never run against staging or production.
import "./load-env";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, like, sql } from "drizzle-orm";

import { autoSendRepliesOn } from "../lib/agent/outbox";
import { runAgentTick, type AgentBusinessReport } from "../lib/agent/autopilot";
import { withSystemContext } from "../lib/db";
import {
  activityLog,
  assets,
  assignments,
  businesses,
  customers,
  exceptions,
  messages,
  orderItems,
  orders,
  shops,
} from "../lib/db/schema";

const BUSINESS_NAME = "Northlight Portraits";
const PREFIX = "agenttest-";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

type Snapshot = { messages: number; exceptions: number; assignments: number; activity: number; statuses: string };

async function snapshot(businessId: string): Promise<Snapshot> {
  return withSystemContext(async (tx) => {
    const n = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
    const count = sql<number>`count(*)::int`;
    const st = await tx
      .select({ status: orders.status, n: count })
      .from(orders)
      .where(eq(orders.businessId, businessId))
      .groupBy(orders.status)
      .orderBy(orders.status);
    return {
      messages: await n(tx.select({ n: count }).from(messages).where(eq(messages.businessId, businessId))),
      exceptions: await n(tx.select({ n: count }).from(exceptions).where(eq(exceptions.businessId, businessId))),
      assignments: await n(tx.select({ n: count }).from(assignments).where(eq(assignments.businessId, businessId))),
      activity: await n(tx.select({ n: count }).from(activityLog).where(eq(activityLog.businessId, businessId))),
      statuses: st.map((s) => `${s.status}:${s.n}`).join(","),
    };
  });
}

const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b);

async function setFlags(businessId: string, on: boolean) {
  await withSystemContext((tx) =>
    tx
      .update(businesses)
      .set({ agentIntakeEnabled: on, agentAssignEnabled: on })
      .where(eq(businesses.id, businessId)),
  );
}

async function main() {
  const [biz] = await withSystemContext((tx) =>
    tx.select({ id: businesses.id, agentConfig: businesses.agentConfig }).from(businesses).where(eq(businesses.name, BUSINESS_NAME)),
  );
  if (!biz) throw new Error(`demo business ${BUSINESS_NAME} not found: is .env.local the DEMO database?`);
  const businessId = biz.id;
  const [etsyShop] = await withSystemContext((tx) =>
    tx
      .select({ id: shops.id })
      .from(shops)
      .where(and(eq(shops.businessId, businessId), eq(shops.platform, "etsy"))),
  );
  if (!etsyShop) throw new Error("demo business has no Etsy shop");
  const [shopBefore] = await withSystemContext((tx) =>
    tx.select({ cfg: shops.integrationConfig }).from(shops).where(eq(shops.id, etsyShop.id)),
  );

  try {
    // ---- setup -------------------------------------------------------------
    const stamp = Date.now().toString(36);
    const ids = await withSystemContext(async (tx) => {
      // Leftovers from an earlier run leave the live set (archived, not deleted).
      await tx
        .update(orders)
        .set({ archivedAt: new Date(), archiveReason: "agent autopilot test leftover" })
        .where(and(eq(orders.businessId, businessId), like(orders.platformOrderId, `${PREFIX}%`), sql`${orders.archivedAt} is null`));

      const [cust] = await tx
        .insert(customers)
        .values({ businessId, email: `${PREFIX}${stamp}@example.test`, firstName: "Agent", lastName: "Test" })
        .returning({ id: customers.id });

      // Synthetic mismatch: 3 figures set by hand, 1 reference photo.
      const [mismatch] = await tx
        .insert(orders)
        .values({
          businessId,
          shopId: etsyShop.id,
          customerId: cust.id,
          platformOrderId: `${PREFIX}mm-${stamp}`,
          platformOrderName: `${PREFIX}mm-${stamp}`,
          status: "awaiting_photos",
          source: "manual",
          uploadToken: randomUUID(),
        })
        .returning({ id: orders.id });
      await tx.insert(orderItems).values({
        businessId,
        orderId: mismatch.id,
        title: "Custom family portrait",
        figureCount: 3,
        figureCountSource: "manual",
        style: "Cartoon",
        productType: "digital",
      });
      await tx.insert(assets).values({
        businessId,
        orderId: mismatch.id,
        type: "reference",
        storage: "cdn",
        url: "https://example.test/agenttest-photo-1.jpg",
      });

      // Etsy order whose variations resolve to nothing.
      const [etsy] = await tx
        .insert(orders)
        .values({
          businessId,
          shopId: etsyShop.id,
          customerId: cust.id,
          platformOrderId: `${PREFIX}etsy-${stamp}`,
          platformOrderName: `${PREFIX}etsy-${stamp}`,
          status: "awaiting_details",
          source: "etsy",
          uploadToken: randomUUID(),
          rawImport: {
            receipt_id: 0,
            transactions: [
              {
                transaction_id: 1,
                title: "Mystery listing nobody configured",
                sku: null,
                quantity: 1,
                is_digital: true,
                listing_id: null,
                variations: [
                  { formatted_name: "Vibe", formatted_value: "Zzz Unknown Flavour" },
                  { formatted_name: "Personalization", formatted_value: "surprise me" },
                ],
              },
            ],
          },
        })
        .returning({ id: orders.id });
      await tx.insert(orderItems).values({
        businessId,
        orderId: etsy.id,
        title: "Mystery listing nobody configured",
        figureCount: null,
        figureCountSource: "unresolved",
        productType: "digital",
      });
      // Add-on-only order (PixArt's "Print & Ship") that reached the design queue:
      // the shop lists it as non-portrait, so no designer may get it.
      await tx
        .update(shops)
        .set({ integrationConfig: { ...((shopBefore?.cfg ?? {}) as Record<string, unknown>), nonPortraitTitles: ["Print & Ship"] } })
        .where(eq(shops.id, etsyShop.id));
      const [addon] = await tx
        .insert(orders)
        .values({
          businessId,
          shopId: etsyShop.id,
          customerId: cust.id,
          platformOrderId: `${PREFIX}addon-${stamp}`,
          platformOrderName: `${PREFIX}addon-${stamp}`,
          status: "ready_to_assign",
          source: "manual",
          uploadToken: randomUUID(),
        })
        .returning({ id: orders.id });
      await tx.insert(orderItems).values({
        businessId,
        orderId: addon.id,
        title: "Print & Ship - Get Your Portrait Printed & Shipped",
        figureCount: 1,
        figureCountSource: "manual",
        productType: "physical",
      });
      return { mismatch: mismatch.id, etsy: etsy.id, addon: addon.id };
    });

    await setFlags(businessId, true);

    const unassignedBefore = await withSystemContext(async (tx) =>
      (
        await tx
          .select({ id: orders.id })
          .from(orders)
          .where(
            and(
              eq(orders.businessId, businessId),
              eq(orders.status, "ready_to_assign"),
              sql`${orders.archivedAt} is null`,
              sql`not exists (select 1 from ${assignments} where ${assignments.orderId} = ${orders.id} and ${assignments.active})`,
            ),
          )
      ).map((r) => r.id),
    );
    console.log(`setup: ${unassignedBefore.length} unassigned ready_to_assign orders, synthetic orders created`);

    // ---- dry run -----------------------------------------------------------
    const before = await snapshot(businessId);
    const dry = await runAgentTick({ dryRun: true, businessId });
    const afterDry = await snapshot(businessId);
    const dryBiz = dry.businesses[0];
    check("dry run: report has the business", dry.dryRun && dryBiz?.businessId === businessId);
    check("dry run: nothing written", same(before, afterDry), JSON.stringify({ before, afterDry }));
    check("dry run: would draft the shortfall", (dryBiz?.photoShortfallDrafted ?? 0) >= 1);
    check("dry run: no errors", (dryBiz?.errors.length ?? 1) === 0, JSON.stringify(dryBiz?.errors));

    // ---- real tick ---------------------------------------------------------
    const real = await runAgentTick({ businessId });
    const r = real.businesses[0] as AgentBusinessReport;
    console.log("tick 1:", JSON.stringify({ ...r, businessName: undefined }));
    check("tick 1: no errors", r.errors.length === 0, JSON.stringify(r.errors));
    check("tick 1: dry-run counts match the real tick",
      dryBiz.assigned === r.assigned && dryBiz.photoShortfallDrafted === r.photoShortfallDrafted && dryBiz.exceptionsOpened === r.exceptionsOpened,
      JSON.stringify({ dry: [dryBiz.assigned, dryBiz.photoShortfallDrafted, dryBiz.exceptionsOpened], real: [r.assigned, r.photoShortfallDrafted, r.exceptionsOpened] }));

    const afterReal = await withSystemContext(async (tx) => {
      const unassigned = unassignedBefore.length
        ? await tx
            .select({ id: orders.id, status: orders.status, needsReview: orders.needsReview })
            .from(orders)
            .where(
              and(
                inArray(orders.id, unassignedBefore),
                sql`not exists (select 1 from ${assignments} where ${assignments.orderId} = ${orders.id} and ${assignments.active})`,
              ),
            )
        : [];
      const shortfall = await tx
        .select({ id: messages.id, status: messages.status, body: messages.body })
        .from(messages)
        .where(and(eq(messages.orderId, ids.mismatch), eq(messages.templateKey, "photo_shortfall")));
      const drafted = await tx
        .select({ metadata: activityLog.metadata, actorId: activityLog.actorId })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, ids.mismatch), eq(activityLog.action, "agent.photo_shortfall_drafted")));
      const mmExc = await tx.select({ id: exceptions.id }).from(exceptions).where(eq(exceptions.orderId, ids.mismatch));
      const etsyExc = await tx
        .select({ id: exceptions.id, kind: exceptions.kind, summary: exceptions.summary, detail: exceptions.detail })
        .from(exceptions)
        .where(eq(exceptions.orderId, ids.etsy));
      const etsyOpenedLog = await tx
        .select({ metadata: activityLog.metadata })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, ids.etsy), eq(activityLog.action, "agent.exception_opened")));
      const [etsyOrder] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, ids.etsy));
      return { unassigned, shortfall, drafted, mmExc, etsyExc, etsyOpenedLog, etsyOrder };
    });

    // Every order that was unassigned either got a designer, or took the
    // no-eligible path (counted; an exception only once it waited 4h), or is
    // an importer-flagged needs_review order the agent leaves to a human.
    const leftover = afterReal.unassigned;
    const explained = r.noEligibleDesigner + r.skippedNeedsReview + r.addonOnly;
    check("tick 1: unassigned ready_to_assign orders assigned or explained",
      r.assigned + leftover.length === unassignedBefore.length && leftover.length === explained,
      JSON.stringify({ before: unassignedBefore.length, assigned: r.assigned, leftover: leftover.length, noEligible: r.noEligibleDesigner, needsReview: r.skippedNeedsReview }));

    const addonState = await withSystemContext(async (tx) => ({
      active: await tx.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.orderId, ids.addon), eq(assignments.active, true))),
      exc: await tx.select({ kind: exceptions.kind, status: exceptions.status }).from(exceptions).where(eq(exceptions.orderId, ids.addon)),
    }));
    check("add-on only: no designer assigned", addonState.active.length === 0 && r.addonOnly >= 1, JSON.stringify({ addonOnly: r.addonOnly }));
    check("add-on only: one open addon_only exception for a person",
      addonState.exc.length === 1 && addonState.exc[0].kind === "addon_only" && addonState.exc[0].status === "open",
      JSON.stringify(addonState.exc));

    // Replies auto-send by default (agentConfig.autoSendReplies), so the one
    // photo_shortfall email is 'sent'; with auto-send off it stays a 'draft'.
    const expectShortfall = autoSendRepliesOn(biz.agentConfig) ? "sent" : "draft";
    check(`mismatch: exactly one photo_shortfall email (${expectShortfall})`, afterReal.shortfall.length === 1 && afterReal.shortfall[0].status === expectShortfall,
      JSON.stringify(afterReal.shortfall.map((m) => m.status)));
    check("mismatch: draft names the counts", !!afterReal.shortfall[0]?.body?.includes("3") && !!afterReal.shortfall[0]?.body?.includes("1"));
    const meta = afterReal.drafted[0]?.metadata as { have?: number; need?: number; messageId?: string } | undefined;
    check("mismatch: exactly one agent.photo_shortfall_drafted activity",
      afterReal.drafted.length === 1 && afterReal.drafted[0].actorId === null && meta?.have === 1 && meta?.need === 3 && meta?.messageId === afterReal.shortfall[0]?.id,
      JSON.stringify(afterReal.drafted));
    check("mismatch: no exception yet (customer has 72h)", afterReal.mmExc.length === 0);

    const exc = afterReal.etsyExc[0];
    const detail = (exc?.detail ?? {}) as { variations?: unknown[]; suggested?: object; missing?: string[] };
    check("etsy: exactly one intake_unparsed exception", afterReal.etsyExc.length === 1 && exc.kind === "intake_unparsed", JSON.stringify(afterReal.etsyExc.map((e) => e.kind)));
    check("etsy: summary and detail shape",
      !!exc?.summary.startsWith(`Etsy order #${PREFIX}etsy-`) && Array.isArray(detail.variations) && !!detail.suggested && Array.isArray(detail.missing) && detail.missing.length > 0,
      exc?.summary);
    check("etsy: agent.exception_opened logged", afterReal.etsyOpenedLog.length === 1 &&
      (afterReal.etsyOpenedLog[0].metadata as { exceptionId?: string }).exceptionId === exc?.id);
    check("etsy: order stays awaiting_details", afterReal.etsyOrder?.status === "awaiting_details");

    // ---- second tick is a no-op -------------------------------------------
    const beforeSecond = await snapshot(businessId);
    const second = await runAgentTick({ businessId });
    const s = second.businesses[0];
    const afterSecond = await snapshot(businessId);
    console.log("tick 2:", JSON.stringify({ ...s, businessName: undefined }));
    check("tick 2: no-op (messages, exceptions, assignments, activity, statuses unchanged)", same(beforeSecond, afterSecond),
      JSON.stringify({ beforeSecond, afterSecond }));
    check("tick 2: reports no writes",
      s.assigned + s.photoShortfallDrafted + s.exceptionsOpened + s.etsyDetailsCompleted + s.photoRequestsQueued === 0 && s.errors.length === 0,
      JSON.stringify(s));

    // ---- 72h later: the unanswered shortfall goes to a human ---------------
    const later = new Date(Date.now() + 73 * 60 * 60 * 1000);
    const esc = await runAgentTick({ businessId, now: later });
    const mmExc = await withSystemContext((tx) =>
      tx
        .select({ kind: exceptions.kind, summary: exceptions.summary })
        .from(exceptions)
        .where(and(eq(exceptions.orderId, ids.mismatch), eq(exceptions.status, "open"))),
    );
    check("72h later: one photo_count_mismatch exception",
      mmExc.length === 1 && mmExc[0].kind === "photo_count_mismatch" && /1 photos for 3 figures, customer asked \d{4}-\d{2}-\d{2}/.test(mmExc[0].summary),
      JSON.stringify(mmExc));
    check("72h later: no errors", esc.businesses[0].errors.length === 0, JSON.stringify(esc.businesses[0].errors));
    const beforeThird = await snapshot(businessId);
    const third = await runAgentTick({ businessId, now: later });
    const afterThird = await snapshot(businessId);
    check("72h later: repeat tick is a no-op", same(beforeThird, afterThird) && third.businesses[0].exceptionsOpened === 0,
      JSON.stringify({ beforeThird, afterThird }));

    console.log(
      `\nsummary: business=${BUSINESS_NAME} unassignedBefore=${unassignedBefore.length} assigned=${r.assigned} ` +
        `noEligible=${r.noEligibleDesigner} needsReview=${r.skippedNeedsReview} shortfallDrafts=${r.photoShortfallDrafted} ` +
        `exceptionsOpened(tick1)=${r.exceptionsOpened} kinds=${[...new Set([...r.exceptionKinds, ...esc.businesses[0].exceptionKinds])].join("|")}`,
    );
  } finally {
    await setFlags(businessId, false);
    await withSystemContext((tx) => tx.update(shops).set({ integrationConfig: shopBefore?.cfg ?? {} }).where(eq(shops.id, etsyShop.id)));
    const [flags] = await withSystemContext((tx) =>
      tx
        .select({ intake: businesses.agentIntakeEnabled, assign: businesses.agentAssignEnabled })
        .from(businesses)
        .where(eq(businesses.id, businessId)),
    );
    check("flags reset to false", !flags.intake && !flags.assign);
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall agent autopilot checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
