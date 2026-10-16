// Not started on time (clean slating audit 2026-10-16, deck item 2): orders sat
// with Abdul (103 open), Jerome (89) and Mar (57) for days with nobody drawing
// them. lib/agent/not-started.ts moves an order nobody started
// notStartedMoveHours after assignment to a designer with room, by the
// assigner's own ranking. Runs against a throwaway business of its own ("Not
// Started Test <stamp>", assign switch on), deleted at the end with its people.
// Never run against production.
import "./load-env";

process.env.ANTHROPIC_API_KEY = "";
process.env.ALPHA_HOOK_URL = "";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { recordAlphaPushes } from "./alpha-hook-recorder";
import { runAgentTick } from "../lib/agent/autopilot";
import { MAX_NOT_STARTED_MOVES, runNotStartedPass } from "../lib/agent/not-started";
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
  orderItems,
  orders,
  shops,
  users,
} from "../lib/db/schema";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const HOUR = 3_600_000;
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
const STYLE = `Watercolour ${Date.now()}`;

const stamp = Date.now();
const ids = {
  biz: randomUUID(),
  shop: randomUUID(),
  cust: randomUUID(),
  owner: randomUUID(),
  va: randomUUID(),
  // Abdul holds the untouched work; Jo has room; Mia is ranked first but already
  // at her open-order limit; Pat draws another style only.
  abdul: randomUUID(),
  jo: randomUUID(),
  mia: randomUUID(),
  pat: randomUUID(),
};
const people = [ids.owner, ids.va, ids.abdul, ids.jo, ids.mia, ids.pat];

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({
      id: ids.biz,
      name: `Not Started Test ${stamp}`,
      slug: `not-started-test-${stamp}`,
      agentAssignEnabled: true,
    });
    await tx.insert(users).values([
      { id: ids.owner, email: `nstest-owner-${stamp}@example.test`, name: "NS Owner", role: "admin" },
      { id: ids.va, email: `nstest-va-${stamp}@example.test`, name: "Alpha VA", role: "va" },
      { id: ids.abdul, email: `nstest-abdul-${stamp}@example.test`, name: "Abdul", role: "designer" },
      { id: ids.jo, email: `nstest-jo-${stamp}@example.test`, name: "Jo", role: "designer" },
      { id: ids.mia, email: `nstest-mia-${stamp}@example.test`, name: "Mia", role: "designer" },
      { id: ids.pat, email: `nstest-pat-${stamp}@example.test`, name: "Pat", role: "designer" },
    ]);
    await tx.insert(designerProfiles).values([
      { userId: ids.abdul, dailyCapacity: 20, styles: [STYLE], rank: 5 },
      { userId: ids.jo, dailyCapacity: 20, styles: [STYLE], rank: 2 },
      { userId: ids.mia, dailyCapacity: 20, styles: [STYLE], rank: 0, maxActiveOrders: 1 },
      { userId: ids.pat, dailyCapacity: 20, styles: ["Line art"], rank: 0 },
    ]);
    await tx.insert(designerBusinesses).values([ids.abdul, ids.jo, ids.mia, ids.pat].map((userId) => ({ userId, businessId: ids.biz })));
    await tx.insert(shops).values({ id: ids.shop, businessId: ids.biz, platform: "shopify", name: "NS Shop", externalShopId: `ns-${stamp}`, credentials: {} });
    await tx.insert(customers).values({ id: ids.cust, businessId: ids.biz, email: `ns-customer-${stamp}@example.test`, firstName: "Kayla" });
  });
}

let n = 0;
async function order(o: {
  assignedHoursAgo: number;
  designer?: string;
  by?: string | null;
  status?: typeof orders.$inferInsert.status;
  style?: string | null;
  revisionCount?: number;
  archived?: boolean;
  dueInHours?: number;
}) {
  n++;
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        customerId: ids.cust,
        platformOrderId: `ns-${stamp}-${n}`,
        platformOrderName: `NS${n}`,
        status: o.status ?? "ready_to_assign",
        source: "manual",
        uploadToken: randomUUID(),
        revisionCount: o.revisionCount ?? 0,
        dueAt: new Date(now.getTime() + (o.dueInHours ?? 72) * HOUR),
        createdAt: ago(o.assignedHoursAgo + 2),
        ...(o.archived ? { archivedAt: ago(1), archiveReason: "test" } : {}),
      })
      .returning({ id: orders.id });
    await tx.insert(orderItems).values({
      businessId: ids.biz,
      orderId: row.id,
      title: "Custom portrait",
      style: o.style === undefined ? STYLE : o.style,
      figureCount: 1,
      figureCountSource: "manual",
      productType: "digital",
    });
    await tx.insert(assignments).values({
      businessId: ids.biz,
      orderId: row.id,
      designerId: o.designer ?? ids.abdul,
      assignedBy: o.by === undefined ? ids.va : o.by,
      assignedAt: ago(o.assignedHoursAgo),
      dueAt: ago(o.assignedHoursAgo - 24),
      active: true,
    });
    return row.id;
  });
}

const holder = (orderId: string) =>
  withSystemContext(async (tx) => {
    const [a] = await tx
      .select({ designerId: assignments.designerId, assignedBy: assignments.assignedBy, dueAt: assignments.dueAt })
      .from(assignments)
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
    return a ?? null;
  });

const actions = (orderId: string, action: string) =>
  withSystemContext((tx) => tx.select({ metadata: activityLog.metadata }).from(activityLog).where(and(eq(activityLog.orderId, orderId), eq(activityLog.action, action))));

async function dbTests() {
  // Mia is at her limit of 1 open order (an in-flight one on another order).
  await order({ assignedHoursAgo: 2, designer: ids.mia, status: "in_design" });

  const plain = await order({ assignedHoursAgo: 30 });
  const soon = await order({ assignedHoursAgo: 30, dueInHours: 5 });
  const young = await order({ assignedHoursAgo: 10 });
  const commented = await order({ assignedHoursAgo: 30 });
  const uploaded = await order({ assignedHoursAgo: 30 });
  const started = await order({ assignedHoursAgo: 30, status: "in_design" });
  const pinned = await order({ assignedHoursAgo: 30, by: ids.owner });
  const unpinned = await order({ assignedHoursAgo: 30, by: null });
  const noStyle = await order({ assignedHoursAgo: 30, style: null });
  const revision = await order({ assignedHoursAgo: 30, revisionCount: 1 });
  const archived = await order({ assignedHoursAgo: 30, archived: true });
  const toured = await order({ assignedHoursAgo: 30 });

  await withSystemContext(async (tx) => {
    // Abdul commented on one after it was given to him: that is a start.
    await tx.insert(activityLog).values({ businessId: ids.biz, orderId: commented, actorId: ids.abdul, action: "comment", metadata: {}, createdAt: ago(20) });
    // A comment of his from BEFORE this assignment does not count.
    await tx.insert(activityLog).values({ businessId: ids.biz, orderId: plain, actorId: ids.abdul, action: "comment", metadata: {}, createdAt: ago(40) });
    await tx.insert(assets).values({
      businessId: ids.biz,
      orderId: uploaded,
      type: "submission",
      storage: "r2",
      r2Key: `ns/${stamp}/sub.png`,
      createdAt: ago(5),
    });
    for (let i = 0; i < MAX_NOT_STARTED_MOVES; i++) {
      await tx.insert(activityLog).values({ businessId: ids.biz, orderId: toured, actorId: null, action: "agent.not_started_moved", metadata: {}, createdAt: ago(60 - i) });
    }
  });

  // ---- dry run: the plan, nothing changed ---------------------------------
  // The hook is live for these calls: a dry run rolls its writes back, so it
  // must not push a single message to the daemon (which delivers at once).
  const { out: dry, pushed: dryPushed } = await recordAlphaPushes(() => runNotStartedPass(ids.biz, { dryRun: true, now }));
  check("dry run: plans the three untouched VA/agent-placed orders", dry.moves.length === 3, JSON.stringify(dry.moves.map((m) => m.orderNumber)));
  check("dry run: nothing moved", (await holder(plain))?.designerId === ids.abdul);
  check("dry run: no timeline row", (await actions(plain, "agent.not_started_moved")).length === 0);
  check("dry run: no message pushed to the daemon", dryPushed.length === 0, JSON.stringify(dryPushed.map((p) => p.type)));

  // ---- a clock of 0 is off -------------------------------------------------
  await withSystemContext((tx) => tx.update(businesses).set({ agentConfig: { notStartedMoveHours: 0 } }).where(eq(businesses.id, ids.biz)));
  const off = await runNotStartedPass(ids.biz, { now });
  check("clock 0: never moves", off.moves.length === 0 && off.checked === 0);
  await withSystemContext((tx) => tx.update(businesses).set({ agentConfig: {} }).where(eq(businesses.id, ids.biz)));

  // ---- the real run --------------------------------------------------------
  const { out: real, pushed: realPushed } = await recordAlphaPushes(() => runNotStartedPass(ids.biz, { now }));
  const moved = new Set(real.moves.map((m) => m.orderId));
  const plainPushes = realPushed.filter((p) => p.orderId === plain);
  check(
    "real run: the hook gets both reassignment notes and the new brief at once",
    plainPushes.some((p) => p.type === "designer.reassigned" && p.toUserId === ids.abdul) &&
      plainPushes.some((p) => p.type === "designer.reassigned" && p.toUserId === ids.jo) &&
      plainPushes.some((p) => p.type === "designer.brief" && p.toUserId === ids.jo),
    JSON.stringify(plainPushes.map((p) => `${p.type}>${p.toUserId === ids.jo ? "jo" : p.toUserId === ids.abdul ? "abdul" : p.toUserId}`)),
  );
  check("moves the untouched order placed by a VA login", moved.has(plain));
  check("moves the untouched order the agent placed", moved.has(unpinned));
  check("moves the untouched order due soon", moved.has(soon));
  check("exactly those three", real.moves.length === 3, JSON.stringify(real.moves.map((m) => m.orderNumber)));
  const to = await holder(plain);
  check("goes to the designer with room in the style (not Mia at her limit, not Pat in another style)", to?.designerId === ids.jo, to?.designerId ?? "none");
  check("the new assignment is the agent's (no pin)", to?.assignedBy === null);
  const soonTo = await holder(soon);
  check("the new deadline never passes the buyer's date", !!soonTo?.dueAt && soonTo.dueAt.getTime() <= now.getTime() + 5 * HOUR + 60_000);
  const log = await actions(plain, "agent.not_started_moved");
  const meta = (log[0]?.metadata ?? {}) as Record<string, unknown>;
  check("timeline row names both designers and the wait", log.length === 1 && meta.from === ids.abdul && meta.to === ids.jo && Number(meta.hoursWaited) >= 30, JSON.stringify(meta));
  const events = await withSystemContext((tx) =>
    tx.select({ type: alphaEvents.type, to: alphaEvents.toUserId }).from(alphaEvents).where(and(eq(alphaEvents.orderId, plain), eq(alphaEvents.type, "designer.reassigned"))),
  );
  check("both designers are told on the reassignment road", events.some((e) => e.to === ids.abdul) && events.some((e) => e.to === ids.jo), JSON.stringify(events));
  const brief = await withSystemContext((tx) =>
    tx.select({ id: alphaEvents.id }).from(alphaEvents).where(and(eq(alphaEvents.orderId, plain), eq(alphaEvents.toUserId, ids.jo), sql`${alphaEvents.type} <> 'designer.reassigned'`)),
  );
  check("the new designer gets the brief", brief.length >= 1);

  for (const [name, id] of [
    ["under the clock", young],
    ["he commented since it was assigned", commented],
    ["a submission since it was assigned", uploaded],
    ["Start was pressed (in_design)", started],
    ["an admin pinned it", pinned],
    ["no style", noStyle],
    ["in revision", revision],
    ["archived", archived],
    ["already moved the most times", toured],
  ] as const) {
    check(`stays with Abdul: ${name}`, (await holder(id))?.designerId === ids.abdul);
  }
  check("kept counts: admin pin, no style, moved enough", real.keptPinned === 1 && real.keptNoStyle === 1 && real.keptMovedEnough === 1, JSON.stringify(real));

  // ---- second pass: the moved orders start a fresh clock with Jo ------------
  const again = await runNotStartedPass(ids.biz, { now });
  check("second pass moves nothing", again.moves.length === 0);

  // ---- nobody with room: the order stays and is counted ---------------------
  await withSystemContext((tx) => tx.update(users).set({ active: false }).where(eq(users.id, ids.jo)));
  const stuck = await order({ assignedHoursAgo: 30 });
  const none = await runNotStartedPass(ids.biz, { now });
  check("nobody with room: stays where it is", (await holder(stuck))?.designerId === ids.abdul && none.noTarget >= 1, JSON.stringify(none));
  await withSystemContext((tx) => tx.update(users).set({ active: true }).where(eq(users.id, ids.jo)));

  // ---- the tick runs it under the assign switch ----------------------------
  const { out: tick, pushed: tickPushed } = await recordAlphaPushes(() => runAgentTick({ businessId: ids.biz, now, dryRun: true }));
  const b = tick.businesses.find((x) => x.businessId === ids.biz);
  check("the tick reports the move (dry run)", b?.notStartedMoved === 1, JSON.stringify({ moved: b?.notStartedMoved, kept: b?.notStartedKept, errors: b?.errors }));
  check("the dry tick pushes nothing to the daemon", tickPushed.length === 0, JSON.stringify(tickPushed.map((p) => p.type)));
  await withSystemContext((tx) => tx.update(businesses).set({ agentAssignEnabled: false }).where(eq(businesses.id, ids.biz)));
  const offTick = await runAgentTick({ businessId: ids.biz, now, dryRun: true });
  check("assign switch off: the tick leaves it", offTick.businesses.find((x) => x.businessId === ids.biz)?.notStartedMoved === undefined);
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
  try {
    await dbTests();
  } finally {
    await cleanup();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall not-started checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await cleanup();
  } catch {}
  process.exit(1);
});
