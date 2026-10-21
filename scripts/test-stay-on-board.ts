// An order stays on its designer's board (Yousif 2026-10-21: "Some designers
// are saying some orders disappear from their alphaOS boards, can we make sure
// this stops happening. You shouldn't really reassign orders unless they are
// severely late or we've talked about it here"). lib/orders/board-hold.ts in
// the app paths and migration 0064's trigger for every other writer. Runs
// against a throwaway business of its own, deleted at the end with its people.
// Never run against production.
import "./load-env";

process.env.ANTHROPIC_API_KEY = "";
process.env.ALPHA_HOOK_URL = "";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { reassignOrder } from "../lib/agent/ai-designer";
import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import {
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
import { createAssignment, runAutoAssign } from "../lib/orders/assign";
import { isStaysOnBoardDbError, StaysOnBoardError } from "../lib/orders/board-hold";
import { moveApproved } from "../lib/orders/move-approved";

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
    await tx.insert(businesses).values({ id: ids.biz, name: `Board Test ${stamp}`, slug: `board-test-${stamp}`, agentAssignEnabled: true });
    await tx.insert(users).values([
      { id: ids.owner, email: `bdtest-owner-${stamp}@example.test`, name: "BD Owner", role: "admin" },
      { id: ids.va, email: `bdtest-va-${stamp}@example.test`, name: "BD VA", role: "va" },
      { id: ids.abdul, email: `bdtest-abdul-${stamp}@example.test`, name: "Abdul", role: "designer" },
      { id: ids.jo, email: `bdtest-jo-${stamp}@example.test`, name: "Jo", role: "designer" },
      { id: ids.pat, email: `bdtest-pat-${stamp}@example.test`, name: "Pat", role: "designer" },
      { id: ids.lee, email: `bdtest-lee-${stamp}@example.test`, name: "Lee", role: "designer", active: false },
      { id: ids.ai, email: `bdtest-ai-${stamp}@example.test`, name: "AI Studio", role: "designer" },
    ]);
    await tx.insert(designerProfiles).values([
      { userId: ids.abdul, dailyCapacity: 20, styles: [STYLE], rank: 5 },
      { userId: ids.jo, dailyCapacity: 20, styles: [STYLE], rank: 0 },
      { userId: ids.pat, dailyCapacity: 20, styles: [STYLE], rank: 3 },
      { userId: ids.lee, dailyCapacity: 20, styles: [STYLE], rank: 1 },
      { userId: ids.ai, dailyCapacity: 20, styles: [STYLE], rank: 0, isAgent: true },
    ]);
    await tx.insert(designerBusinesses).values([ids.abdul, ids.jo, ids.pat, ids.lee, ids.ai].map((userId) => ({ userId, businessId: ids.biz })));
    await tx.insert(shops).values({ id: ids.shop, businessId: ids.biz, platform: "shopify", name: "BD Shop", externalShopId: `bd-${stamp}`, credentials: {} });
    await tx.insert(customers).values({ id: ids.cust, businessId: ids.biz, email: `bd-customer-${stamp}@example.test`, firstName: "Nevaeh" });
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
        platformOrderId: `bd-${stamp}-${n}`,
        platformOrderName: `BD${n}`,
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
    await tx.insert(assets).values({
      businessId: ids.biz,
      orderId: row.id,
      type: "reference",
      storage: "r2",
      r2Key: `bd/${stamp}/${n}-ref.jpg`,
      uploadedBy: null,
      createdAt: ago(40),
    });
    let i = 0;
    for (const by of o.drawnBy ?? []) {
      i++;
      await tx.insert(assets).values({
        businessId: ids.biz,
        orderId: row.id,
        type: "submission",
        storage: "r2",
        r2Key: `bd/${stamp}/${n}-${i}.png`,
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
  // ---- the agent's own passes never take it off a person -------------------
  const held = await order({ status: "ready_to_assign", rows: [{ designer: ids.abdul, active: true, hoursAgo: 30 }] });
  const auto = await withSystemContext((tx) => runAutoAssign(tx, { orderId: held, businessId: ids.biz, assignedBy: null }));
  check("auto-assign keeps Abdul although Jo ranks first", auto.assigned === ids.abdul && (await holder(held)) === ids.abdul, JSON.stringify(auto));

  // ---- a VA or the system cannot move it -------------------------------------
  const r1 = await reassignOrder(held, ids.jo, ids.va);
  check("a VA cannot move it (stays_on_board, names Abdul)", !r1.ok && r1.code === "stays_on_board" && /Abdul/.test(r1.message), JSON.stringify(r1));
  const r2 = await reassignOrder(held, ids.jo, null);
  check("the system cannot move it", !r2.ok && r2.code === "stays_on_board" && (await holder(held)) === ids.abdul);
  let thrown: unknown = null;
  try {
    await withSystemContext((tx) => createAssignment(tx, { orderId: held, businessId: ids.biz, designerId: ids.jo, assignedBy: null, reason: "test" }));
  } catch (e) {
    thrown = e;
  }
  check("createAssignment refuses it", thrown instanceof StaysOnBoardError && (await holder(held)) === ids.abdul, String(thrown));
  const m1 = await moveApproved({ order: "BD1", to: "Jo" });
  check("move-approved preview: needs a yes", m1.ok && m1.needsYes, JSON.stringify(m1));
  const m2 = await moveApproved({ order: "BD1", to: "Jo", apply: true });
  check(
    "move-approved without words is refused (names Abdul's board)",
    !m2.ok && m2.code === "needs_yes" && /Abdul's board/.test(m2.message) && (await holder(held)) === ids.abdul,
    JSON.stringify(m2),
  );

  // ---- the same designer again is fine (a fresh row) ------------------------
  const r3 = await reassignOrder(held, ids.abdul, ids.va);
  check("handing it back to Abdul is fine", r3.ok && (await holder(held)) === ids.abdul, JSON.stringify(r3));

  // ---- an owner's yes moves it -----------------------------------------------
  const r4 = await reassignOrder(held, ids.jo, ids.owner);
  check("an admin moves it", r4.ok && (await holder(held)) === ids.jo, JSON.stringify(r4));
  const r5 = await reassignOrder(held, ids.pat, null, { ownerApproved: "Yousif in chat: move it to Pat" });
  check("an owner's words move it", r5.ok && (await holder(held)) === ids.pat, JSON.stringify(r5));

  // ---- AI Studio and a deactivated designer move freely ---------------------
  const ai = await order({ rows: [{ designer: ids.ai, active: true, hoursAgo: 30 }] });
  const r6 = await reassignOrder(ai, ids.jo, ids.va);
  check("off AI Studio: a VA moves it", r6.ok && (await holder(ai)) === ids.jo, JSON.stringify(r6));
  const gone = await order({ rows: [{ designer: ids.lee, active: true, hoursAgo: 30 }] });
  const r7 = await reassignOrder(gone, ids.jo, ids.va);
  check("off a deactivated designer: a VA moves it", r7.ok && (await holder(gone)) === ids.jo, JSON.stringify(r7));

  // ---- a first assignment is untouched ---------------------------------------
  const fresh = await order({ status: "ready_to_assign" });
  const r8 = await reassignOrder(fresh, ids.jo, ids.va);
  check("an unassigned order is assigned", r8.ok && (await holder(fresh)) === ids.jo, JSON.stringify(r8));
}

async function triggerTests(ownerDb: ReturnType<typeof drizzle<typeof schema>>) {
  // Ad-hoc SQL on the owner connection: no app code in the way, only migration 0064.
  const o = await order({ rows: [{ designer: ids.abdul, active: true, hoursAgo: 30 }] });
  const moveTo = (designerId: string, setting?: [string, string]) =>
    ownerDb.transaction(async (tx) => {
      if (setting) await tx.execute(sql`select set_config(${setting[0]}, ${setting[1]}, true)`);
      await tx.update(assignments).set({ active: false }).where(and(eq(assignments.orderId, o), eq(assignments.active, true)));
      await tx.insert(assignments).values({ businessId: ids.biz, orderId: o, designerId, assignedBy: null, dueAt: new Date(now.getTime() + 24 * HOUR), active: true });
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
  check("raw SQL: switching Abdul's row off is refused", isStaysOnBoardDbError(e1) && (await holder(o)) === ids.abdul, why(e1));
  const e2 = await attempt(() => moveTo(ids.jo, ["alphaos.board_move_ok", `${o}:${ids.abdul}`]));
  check("raw SQL: the hand-back mark does not open a move to someone else", isStaysOnBoardDbError(e2) && (await holder(o)) === ids.abdul, why(e2));
  const e3 = await attempt(() => moveTo(ids.abdul, ["alphaos.board_move_ok", `${o}:${ids.abdul}`]));
  check("raw SQL: a hand-back to Abdul with the mark works", e3 === null && (await holder(o)) === ids.abdul, String(e3 ?? ""));
  const e4 = await attempt(() =>
    ownerDb.update(assignments).set({ designerId: ids.jo }).where(and(eq(assignments.orderId, o), eq(assignments.active, true))),
  );
  check("raw SQL: re-pointing the active row is refused", isStaysOnBoardDbError(e4) && (await holder(o)) === ids.abdul, why(e4));
  const e5 = await attempt(() =>
    ownerDb.update(assignments).set({ dueAt: new Date(now.getTime() + 5 * HOUR) }).where(and(eq(assignments.orderId, o), eq(assignments.active, true))),
  );
  check("raw SQL: a deadline change is never touched", e5 === null, String(e5 ?? ""));
  const e6 = await attempt(() => moveTo(ids.jo, ["alphaos.rework_move_ok", "test: an owner said yes"]));
  check("raw SQL: with an owner's approval it moves", e6 === null && (await holder(o)) === ids.jo, String(e6 ?? ""));
  const e7 = await attempt(() => moveTo(ids.pat));
  check("raw SQL: the approval does not outlive its transaction", isStaysOnBoardDbError(e7) && (await holder(o)) === ids.jo, why(e7));
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
    await appTests();
    await triggerTests(drizzle(pool, { schema }));
  } finally {
    await pool.end();
    await cleanup();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall stay-on-board checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await cleanup();
  } catch {}
  process.exit(1);
});
