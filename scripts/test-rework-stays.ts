// Revisions and failed QC stay with their designer (Yousif 2026-10-16: "From
// now on don't move revisions or failed QC to another designer unless I
// approve it. It can confuse designers and often they need the source file").
// lib/orders/rework.ts in the app paths (createAssignment, reassignOrder,
// runAutoAssign, the AI hand-over, the autopilot) and migration 0063's trigger
// for every other writer. Runs against a throwaway business of its own
// ("Rework Test <stamp>", assign switch on), deleted at the end with its
// people. Never run against production.
import "./load-env";

process.env.ANTHROPIC_API_KEY = "";
process.env.ALPHA_HOOK_URL = "";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { NextRequest } from "next/server";
import ws from "ws";

import { POST as moveApprovedPOST } from "../app/api/alpha/move-approved/route";
import { reassignOrder } from "../lib/agent/ai-designer";
import { runAgentTick } from "../lib/agent/autopilot";
import { handFailedAiOrder } from "../lib/agent/limbo";
import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import {
  activityLog,
  alphaEvents,
  assets,
  assignments,
  businesses,
  customers,
  designerBusinesses,
  designerProfiles,
  exceptions,
  orderItems,
  orders,
  shops,
  users,
} from "../lib/db/schema";
import { createAssignment, runAutoAssign } from "../lib/orders/assign";
import { moveApproved } from "../lib/orders/move-approved";
import { isReworkStaysDbError, loadReworkHold, ReworkStaysError } from "../lib/orders/rework";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const HOUR = 3_600_000;
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
const STYLE = `Oil ${Date.now()}`;

const stamp = Date.now();
const ids = {
  biz: randomUUID(),
  shop: randomUUID(),
  cust: randomUUID(),
  owner: randomUUID(),
  va: randomUUID(),
  // Abdul draws the work; Jo is ranked first, so the ranking alone would pick
  // Jo; Pat is a third designer; Lee drew one order and has since left.
  abdul: randomUUID(),
  jo: randomUUID(),
  pat: randomUUID(),
  lee: randomUUID(),
  ai: randomUUID(),
};
const people = [ids.owner, ids.va, ids.abdul, ids.jo, ids.pat, ids.lee, ids.ai];

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.biz, name: `Rework Test ${stamp}`, slug: `rework-test-${stamp}`, agentAssignEnabled: true });
    await tx.insert(users).values([
      { id: ids.owner, email: `rwtest-owner-${stamp}@example.test`, name: "RW Owner", role: "admin" },
      { id: ids.va, email: `rwtest-va-${stamp}@example.test`, name: "RW VA", role: "va" },
      { id: ids.abdul, email: `rwtest-abdul-${stamp}@example.test`, name: "Abdul", role: "designer" },
      { id: ids.jo, email: `rwtest-jo-${stamp}@example.test`, name: "Jo", role: "designer" },
      { id: ids.pat, email: `rwtest-pat-${stamp}@example.test`, name: "Pat", role: "designer" },
      { id: ids.lee, email: `rwtest-lee-${stamp}@example.test`, name: "Lee", role: "designer", active: false },
      { id: ids.ai, email: `rwtest-ai-${stamp}@example.test`, name: "AI Studio", role: "designer" },
    ]);
    await tx.insert(designerProfiles).values([
      { userId: ids.abdul, dailyCapacity: 20, styles: [STYLE], rank: 5 },
      { userId: ids.jo, dailyCapacity: 20, styles: [STYLE], rank: 0 },
      { userId: ids.pat, dailyCapacity: 20, styles: [STYLE], rank: 3 },
      { userId: ids.lee, dailyCapacity: 20, styles: [STYLE], rank: 1 },
      { userId: ids.ai, dailyCapacity: 20, styles: [STYLE], rank: 0, isAgent: true },
    ]);
    await tx.insert(designerBusinesses).values([ids.abdul, ids.jo, ids.pat, ids.lee, ids.ai].map((userId) => ({ userId, businessId: ids.biz })));
    await tx.insert(shops).values({ id: ids.shop, businessId: ids.biz, platform: "shopify", name: "RW Shop", externalShopId: `rw-${stamp}`, credentials: {} });
    await tx.insert(customers).values({ id: ids.cust, businessId: ids.biz, email: `rw-customer-${stamp}@example.test`, firstName: "Nevaeh" });
  });
}

type Row = { designer: string; active: boolean; hoursAgo: number };
let n = 0;
/**
 * An order with its assignment history (oldest first), then its submissions,
 * then its revision count: the same order things happen in real life, so the
 * fixture never needs the owner's approval to be written.
 */
async function order(o: {
  status?: typeof orders.$inferInsert.status;
  rows?: Row[];
  drawnBy?: (string | null)[];
  revisionCount?: number;
  aiState?: string | null;
}) {
  n++;
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        customerId: ids.cust,
        platformOrderId: `rw-${stamp}-${n}`,
        platformOrderName: `RW${n}`,
        status: o.status ?? "in_design",
        source: "manual",
        uploadToken: randomUUID(),
        dueAt: new Date(now.getTime() + 72 * HOUR),
        createdAt: ago(100),
      })
      .returning({ id: orders.id });
    await tx.insert(orderItems).values({
      businessId: ids.biz,
      orderId: row.id,
      title: "Custom portrait",
      style: STYLE,
      figureCount: 1,
      figureCountSource: "manual",
      productType: "digital",
    });
    for (const r of o.rows ?? []) {
      await tx.insert(assignments).values({
        businessId: ids.biz,
        orderId: row.id,
        designerId: r.designer,
        assignedBy: ids.va,
        assignedAt: ago(r.hoursAgo),
        dueAt: ago(r.hoursAgo - 24),
        active: r.active,
      });
    }
    let i = 0;
    for (const by of o.drawnBy ?? []) {
      i++;
      await tx.insert(assets).values({
        businessId: ids.biz,
        orderId: row.id,
        type: "submission",
        storage: "r2",
        r2Key: `rw/${stamp}/${n}-${i}.png`,
        uploadedBy: by,
        createdAt: ago(10 - i),
      });
    }
    if (o.revisionCount || o.aiState) {
      await tx
        .update(orders)
        .set({ revisionCount: o.revisionCount ?? 0, ...(o.aiState ? { aiState: o.aiState as typeof orders.$inferInsert.aiState } : {}) })
        .where(eq(orders.id, row.id));
    }
    return row.id;
  });
}

const holder = async (orderId: string) => {
  const [a] = await withSystemContext((tx) =>
    tx.select({ designerId: assignments.designerId }).from(assignments).where(and(eq(assignments.orderId, orderId), eq(assignments.active, true))),
  );
  return a?.designerId ?? null;
};
const nameOf = (id: string | null) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? String(id);

async function appTests() {
  // ---- a first draft moves freely, as before --------------------------------
  const first = await order({ rows: [{ designer: ids.abdul, active: true, hoursAgo: 30 }] });
  const r1 = await reassignOrder(first, ids.jo, ids.va);
  check("first draft: a VA moves it", r1.ok && (await holder(first)) === ids.jo, JSON.stringify(r1));

  // ---- a revision stays ------------------------------------------------------
  const rev = await order({ rows: [{ designer: ids.abdul, active: true, hoursAgo: 30 }], drawnBy: [ids.abdul], revisionCount: 1 });
  const r2 = await reassignOrder(rev, ids.jo, ids.va);
  check(
    "revision: a VA cannot move it (rework_stays, names who drew it)",
    !r2.ok && r2.code === "rework_stays" && /Abdul/.test(r2.message) && /owner/.test(r2.message),
    JSON.stringify(r2),
  );
  check("revision: still with Abdul", (await holder(rev)) === ids.abdul);
  const r2b = await reassignOrder(rev, ids.jo, null);
  check("revision: the system cannot move it either", !r2b.ok && r2b.code === "rework_stays");

  // ---- drawn, never failed: a submission on file is enough -------------------
  const drawn = await order({ status: "awaiting_qc", rows: [{ designer: ids.abdul, active: true, hoursAgo: 30 }], drawnBy: [ids.abdul] });
  const r3 = await reassignOrder(drawn, ids.jo, ids.va);
  check("drawn, waiting for QC: stays too", !r3.ok && r3.code === "rework_stays" && (await holder(drawn)) === ids.abdul, JSON.stringify(r3));

  // ---- createAssignment holds the line for every caller ----------------------
  let threw: unknown = null;
  try {
    await withSystemContext((tx) => createAssignment(tx, { orderId: rev, businessId: ids.biz, designerId: ids.jo, assignedBy: ids.va }));
  } catch (e) {
    threw = e;
  }
  check("createAssignment refuses with ReworkStaysError", threw instanceof ReworkStaysError && (threw as ReworkStaysError).code === "rework_stays", String(threw));

  // ---- an owner's yes ---------------------------------------------------------
  const r4 = await reassignOrder(rev, ids.jo, ids.owner);
  check("an admin moving it is the approval", r4.ok && (await holder(rev)) === ids.jo, JSON.stringify(r4));
  const [log4] = await withSystemContext((tx) =>
    tx
      .select({ metadata: activityLog.metadata })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, rev), eq(activityLog.action, "order.reassigned")))
      .orderBy(desc(activityLog.createdAt))
      .limit(1),
  );
  check("the timeline names who approved", /RW Owner/.test(String((log4?.metadata as Record<string, unknown>)?.reworkMoveApprovedBy ?? "")), JSON.stringify(log4?.metadata));
  const r5 = await reassignOrder(rev, ids.abdul, ids.va);
  check("back to the designer who drew it needs no approval", r5.ok && (await holder(rev)) === ids.abdul, JSON.stringify(r5));
  const r6 = await reassignOrder(rev, ids.jo, ids.va);
  check("a past approved holder has no standing right to it", !r6.ok && r6.code === "rework_stays", JSON.stringify(r6));
  const r7 = await reassignOrder(drawn, ids.pat, ids.va, { ownerApproved: "Yousif in chat: give it to Pat" });
  check("ownerApproved (an owner's words) moves it", r7.ok && (await holder(drawn)) === ids.pat, JSON.stringify(r7));
  const left = await withSystemContext(async (tx) => {
    await createAssignment(tx, { orderId: drawn, businessId: ids.biz, designerId: ids.jo, assignedBy: ids.va, ownerApproved: "Ayser: Jo has the file" });
    const res = await tx.execute(sql`select coalesce(current_setting('alphaos.rework_move_ok', true), '') as v`);
    return String((res.rows[0] as { v: string }).v);
  });
  check("the approval closes again right after the move", left === "", JSON.stringify(left));

  // ---- auto-assign: back to its own designer, never the ranking --------------
  const back = await order({ status: "ready_to_assign", rows: [{ designer: ids.abdul, active: false, hoursAgo: 30 }], drawnBy: [ids.abdul], revisionCount: 1 });
  const a1 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: back, businessId: ids.biz, assignedBy: null }));
  check("auto-assign gives a revision back to Abdul (Jo ranks first)", a1.assigned === ids.abdul && (await holder(back)) === ids.abdul, JSON.stringify(a1));
  const brief = await withSystemContext((tx) =>
    tx.select({ id: alphaEvents.id }).from(alphaEvents).where(and(eq(alphaEvents.orderId, back), eq(alphaEvents.toUserId, ids.abdul), eq(alphaEvents.type, "designer.brief"))),
  );
  check("Abdul gets the brief", brief.length >= 1);

  const gone = await order({ status: "ready_to_assign", rows: [{ designer: ids.lee, active: false, hoursAgo: 30 }], drawnBy: [ids.lee], revisionCount: 1 });
  const a2 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: gone, businessId: ids.biz, assignedBy: null }));
  check("whoever drew it has left: held for the owner, nobody new", a2.assigned === null && !!a2.reworkHeld && (await holder(gone)) === null, JSON.stringify(a2));

  // ---- a VA's upload is not "who drew it" ------------------------------------
  const vaUp = await order({ status: "ready_to_assign", drawnBy: [ids.va], revisionCount: 1 });
  const hold = await withSystemContext((tx) => loadReworkHold(tx, vaUp));
  check("a VA's upload does not count as who drew it", hold.rework && hold.drewId === null, JSON.stringify(hold));

  // ---- AI Studio gave up: only the human who drew it, else the owner ---------
  const aiAfterAbdul = await order({
    rows: [
      { designer: ids.abdul, active: false, hoursAgo: 40 },
      { designer: ids.ai, active: true, hoursAgo: 20 },
    ],
    drawnBy: [ids.abdul],
    revisionCount: 1,
    aiState: "failed",
  });
  const h1 = await handFailedAiOrder(aiAfterAbdul, { now });
  check(
    "AI gave up on Abdul's revision: back to Abdul, not the ranking",
    !!h1?.handed && (await holder(aiAfterAbdul)) === ids.abdul,
    JSON.stringify(h1 && { handed: h1.handed, to: "designerId" in h1 ? nameOf(h1.designerId as string) : null }),
  );
  const aiOwn = await order({ rows: [{ designer: ids.ai, active: true, hoursAgo: 20 }], drawnBy: [ids.ai], revisionCount: 1, aiState: "failed" });
  const h2 = await handFailedAiOrder(aiOwn, { now });
  const rec = h2 && "recommendation" in h2 ? String(h2.recommendation ?? "") : "";
  check("AI's own revision: nobody new without the owner's yes", !!h2 && !h2.handed && (await holder(aiOwn)) === ids.ai, JSON.stringify(h2));
  check("the owner is told it moves only with their yes", /only with your yes/.test(rec), rec);

  // ---- an owner's yes given in chat: the move-approved road -------------------
  const chat = await order({ rows: [{ designer: ids.abdul, active: true, hoursAgo: 30 }], drawnBy: [ids.abdul], revisionCount: 1 });
  const chatNo = `RW${n}`;
  const m1 = await moveApproved({ order: chatNo, to: "Jo" });
  check("move-approved, dry run: needs a yes, changes nothing", m1.ok && !m1.applied && m1.needsYes && (await holder(chat)) === ids.abdul, JSON.stringify(m1));
  const m2 = await moveApproved({ order: chatNo, to: "Jo", apply: true });
  check("move-approved without the owner's words is refused", !m2.ok && m2.code === "needs_yes" && (await holder(chat)) === ids.abdul, JSON.stringify(m2));
  const m3 = await moveApproved({ order: chatNo.toLowerCase(), to: "jo", apply: true, approved: "Yousif in chat: give it to Jo", by: "RW VA" });
  check("move-approved with the owner's words moves it", m3.ok && m3.applied && (await holder(chat)) === ids.jo, JSON.stringify(m3));
  const [log3] = await withSystemContext((tx) =>
    tx
      .select({ metadata: activityLog.metadata, actorId: activityLog.actorId })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, chat), eq(activityLog.action, "order.reassigned")))
      .orderBy(desc(activityLog.createdAt))
      .limit(1),
  );
  const meta3 = (log3?.metadata ?? {}) as Record<string, unknown>;
  check("the yes is on the timeline, carried out by the VA login", meta3.reworkMoveApprovedBy === "Yousif in chat: give it to Jo" && log3?.actorId === ids.va, JSON.stringify(log3));
  const heard = await withSystemContext((tx) =>
    tx.select({ to: alphaEvents.toUserId, type: alphaEvents.type }).from(alphaEvents).where(eq(alphaEvents.orderId, chat)),
  );
  const told = (who: string, type: string) => heard.some((e) => e.to === who && e.type === type);
  check(
    "Abdul hears it moved, Jo gets the notice and the brief",
    told(ids.abdul, "designer.reassigned") && told(ids.jo, "designer.reassigned") && told(ids.jo, "designer.brief"),
    JSON.stringify(heard.map((e) => [nameOf(e.to), e.type])),
  );
  const m4 = await moveApproved({ order: chat, to: "Abdul", apply: true });
  check("handing it back to the designer who drew it needs no yes", m4.ok && m4.applied && !m4.needsYes && (await holder(chat)) === ids.abdul, JSON.stringify(m4));
  const m5 = await moveApproved({ order: chatNo, to: "Lee", apply: true, approved: "Yousif: Lee" });
  check("a designer who has left cannot be picked", !m5.ok && m5.code === "designer", JSON.stringify(m5));

  // ---- the same road over HTTP, for the agent (POST /api/alpha/move-approved)
  process.env.ALPHA_HOOK_SECRET = "rework-stays-test-secret";
  process.env.ALPHA_HOOK_URL = ""; // nothing leaves the test
  const post = (body: unknown, secret = true) =>
    moveApprovedPOST(
      new NextRequest("http://localhost/api/alpha/move-approved", {
        method: "POST",
        headers: { "content-type": "application/json", ...(secret ? { "x-alpha-secret": process.env.ALPHA_HOOK_SECRET! } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const http0 = await post({ order: chatNo, to: "Jo", apply: true, approved: "x" }, false);
  check("POST move-approved: 401 without the secret", http0.status === 401 && (await holder(chat)) === ids.abdul);
  const http1 = await post({ order: chatNo, to: "Jo", apply: true });
  const http1b = (await http1.json()) as { code?: string };
  check(
    "POST move-approved: a revision without the owner's words is refused",
    http1.status === 409 && http1b.code === "needs_yes" && (await holder(chat)) === ids.abdul,
    JSON.stringify(http1b),
  );
  const http2 = await post({ order: chatNo, to: "Jo", apply: true, approved: "Ayser in chat: Jo takes it" });
  const http2b = (await http2.json()) as { applied?: boolean; approvedBy?: string };
  check(
    "POST move-approved: with the owner's words it moves",
    http2.status === 200 && !!http2b.applied && http2b.approvedBy === "Ayser in chat: Jo takes it" && (await holder(chat)) === ids.jo,
    JSON.stringify(http2b),
  );

  return { gone };
}

async function triggerTests(ownerDb: ReturnType<typeof drizzle<typeof schema>>) {
  // Ad-hoc SQL on the owner connection: no app code in the way, only migration 0063.
  const rev = await order({ rows: [{ designer: ids.abdul, active: true, hoursAgo: 30 }], drawnBy: [ids.abdul], revisionCount: 1 });
  const moveTo = (designerId: string, approval?: string) =>
    ownerDb.transaction(async (tx) => {
      if (approval) await tx.execute(sql`select set_config('alphaos.rework_move_ok', ${approval}, true)`);
      await tx.update(assignments).set({ active: false }).where(and(eq(assignments.orderId, rev), eq(assignments.active, true)));
      await tx.insert(assignments).values({ businessId: ids.biz, orderId: rev, designerId, assignedBy: null, dueAt: new Date(now.getTime() + 24 * HOUR), active: true });
    });
  const attempt = async (f: () => Promise<unknown>) => {
    try {
      await f();
      return null;
    } catch (e) {
      return e;
    }
  };

  const why = (e: unknown) => String(((e as { cause?: Error })?.cause ?? (e as Error))?.message ?? e).slice(0, 160);
  const e1 = await attempt(() => moveTo(ids.jo));
  check("raw SQL: a revision cannot be moved", isReworkStaysDbError(e1), why(e1));
  check("raw SQL: the refused move rolled back whole (Abdul still has it)", (await holder(rev)) === ids.abdul);
  const e2 = await attempt(() => moveTo(ids.jo, "test: an owner said yes"));
  check("raw SQL: with the approval setting it moves", e2 === null && (await holder(rev)) === ids.jo, String(e2 ?? ""));
  const e3 = await attempt(() => moveTo(ids.pat));
  check("raw SQL: the approval does not outlive its transaction", isReworkStaysDbError(e3) && (await holder(rev)) === ids.jo, why(e3));
  const e4 = await attempt(() =>
    ownerDb.update(assignments).set({ designerId: ids.pat }).where(and(eq(assignments.orderId, rev), eq(assignments.active, true))),
  );
  check("raw SQL: re-pointing the active row at someone new is refused", isReworkStaysDbError(e4) && (await holder(rev)) === ids.jo, why(e4));
  const e5 = await attempt(() => moveTo(ids.abdul));
  check("raw SQL: back to the designer who drew it is fine", e5 === null && (await holder(rev)) === ids.abdul, String(e5 ?? ""));
  const e6 = await attempt(() =>
    ownerDb.update(assignments).set({ dueAt: new Date(now.getTime() + 5 * HOUR) }).where(and(eq(assignments.orderId, rev), eq(assignments.active, true))),
  );
  check("raw SQL: a deadline change is never touched", e6 === null, String(e6 ?? ""));

  const fresh = await order({ rows: [{ designer: ids.abdul, active: true, hoursAgo: 30 }] });
  const e7 = await attempt(() =>
    ownerDb.transaction(async (tx) => {
      await tx.update(assignments).set({ active: false }).where(and(eq(assignments.orderId, fresh), eq(assignments.active, true)));
      await tx.insert(assignments).values({ businessId: ids.biz, orderId: fresh, designerId: ids.jo, assignedBy: null, active: true });
    }),
  );
  check("raw SQL: a first draft moves freely", e7 === null && (await holder(fresh)) === ids.jo, String(e7 ?? ""));
  const vaUp = await order({ status: "ready_to_assign", drawnBy: [ids.va], revisionCount: 1 });
  const e8 = await attempt(() => ownerDb.insert(assignments).values({ businessId: ids.biz, orderId: vaUp, designerId: ids.jo, assignedBy: null, active: true }));
  check("raw SQL: never assigned and no designer drew it: the first assignment is free", e8 === null, String(e8 ?? ""));
}

async function tickTest(gone: string) {
  // The autopilot meets the order whose designer left: an owner question, never the overflow pick.
  const tick = await runAgentTick({ businessId: ids.biz, now });
  const b = tick.businesses.find((x) => x.businessId === ids.biz);
  check("the tick does not hand it to anyone", (await holder(gone)) === null, JSON.stringify({ errors: b?.errors }));
  const [ex] = await withSystemContext((tx) =>
    tx
      .select({ summary: exceptions.summary, detail: exceptions.detail, status: exceptions.status })
      .from(exceptions)
      .where(and(eq(exceptions.orderId, gone), eq(exceptions.kind, "no_eligible_designer"))),
  );
  const detail = (ex?.detail ?? {}) as Record<string, unknown>;
  check(
    "the owner gets one question: a revision, who drew it, who could take it",
    ex?.status === "open" && detail.rework === true && detail.drewBy === "Lee" && /revision/.test(ex.summary) && /only with your yes/.test(String(detail.recommendation)),
    JSON.stringify(ex),
  );
}

async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    const res = await ownerDb.execute(sql`
      select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'business_id' and c.table_name <> 'businesses'`);
    let left = (res.rows as { table_name: string }[]).map((r) => r.table_name);
    for (let pass = 0; pass < 8 && left.length; pass++) {
      const blocked: string[] = [];
      for (const t of left) {
        try {
          await ownerDb.execute(sql`delete from ${sql.identifier(t)} where business_id = ${ids.biz}`);
        } catch {
          blocked.push(t);
        }
      }
      left = blocked;
    }
    if (left.length) console.log(`cleanup: could not clear ${left.join(", ")}`);
    await ownerDb.transaction(async (tx) => {
      await tx.delete(alphaEvents).where(inArray(alphaEvents.toUserId, people));
      await tx.delete(designerProfiles).where(inArray(designerProfiles.userId, people));
      await tx.delete(users).where(inArray(users.id, people));
      await tx.delete(businesses).where(eq(businesses.id, ids.biz));
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  await setup();
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  try {
    const { gone } = await appTests();
    await triggerTests(drizzle(pool, { schema }));
    await tickTest(gone);
  } finally {
    await pool.end();
    await cleanup();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall rework-stays checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await cleanup();
  } catch {}
  process.exit(1);
});
