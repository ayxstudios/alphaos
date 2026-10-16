// The agent's change-request road (lib/orders/agent-revision.ts, POST
// /api/alpha/revision; Yousif 2026-10-17: "Most of these "Needs you" should be
// done by you"; Katie Hutchinson, Perfetta 4197441022, asked in Etsy chat for
// the pumpkin and the flowers back and nothing could queue it): a dry run
// changes nothing, apply sends the newest undecided proof back to the SAME
// designer with her words, and everything else is refused. Against a throwaway
// business of its own, deleted at the end. Never run against production.
import "./load-env";

process.env.ALPHA_HOOK_URL = "";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import { activityLog, assignments, businesses, customers, orderItems, orders, proofs, shops, users } from "../lib/db/schema";
import { agentRevision, AGENT_REVISION_VIA } from "../lib/orders/agent-revision";
import { generateProofToken } from "../lib/proofs/tokens";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const HOUR = 3_600_000;
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
const stamp = Date.now();
const ids = { biz: randomUUID(), shop: randomUUID(), cust: randomUUID(), designer: randomUUID() };
const DESIGNER = `Jerome Rev ${stamp}`;

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.biz, name: `Agent Revision Test ${stamp}`, slug: `agent-revision-test-${stamp}` });
    await tx.insert(shops).values({ id: ids.shop, businessId: ids.biz, platform: "etsy", name: "Ar Shop", externalShopId: `ar-${stamp}`, credentials: {} });
    await tx.insert(customers).values({ id: ids.cust, businessId: ids.biz, email: `ar-customer-${stamp}@example.test`, firstName: "Katie" });
    await tx.insert(users).values({ id: ids.designer, email: `ar-designer-${stamp}@example.test`, name: DESIGNER, role: "designer" });
  });
}

let n = 0;
async function order(o: { status?: typeof orders.$inferInsert.status; archived?: boolean; decided?: "approved" | "revision" } = {}) {
  n++;
  const number = `AR${stamp % 100000}-${n}`;
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        customerId: ids.cust,
        platformOrderId: `ar-${stamp}-${n}`,
        platformOrderName: number,
        status: o.status ?? "awaiting_approval",
        source: "manual",
        uploadToken: randomUUID(),
        createdAt: ago(72),
        archivedAt: o.archived ? ago(1) : null,
      })
      .returning({ id: orders.id });
    await tx.insert(orderItems).values({ businessId: ids.biz, orderId: row.id, title: "Venue watercolor", figureCount: 1, figureCountSource: "manual", productType: "digital" });
    await tx.insert(assignments).values({ businessId: ids.biz, orderId: row.id, designerId: ids.designer, active: true });
    // An older proof she already answered, then the newest one out for approval.
    await tx.insert(proofs).values({ businessId: ids.biz, orderId: row.id, token: generateProofToken(), sentAt: ago(30), createdAt: ago(30), decision: "revision", decidedAt: ago(29) });
    await tx.insert(proofs).values({ businessId: ids.biz, orderId: row.id, token: generateProofToken(), sentAt: ago(2), createdAt: ago(2), ...(o.decided ? { decision: o.decided, decidedAt: ago(1) } : {}) });
    return { id: row.id, number };
  });
}

const state = (orderId: string) =>
  withSystemContext(async (tx) => {
    const [o] = await tx.select({ status: orders.status, revisionCount: orders.revisionCount }).from(orders).where(eq(orders.id, orderId));
    const [p] = await tx
      .select({ decision: proofs.decision, revisionNotes: proofs.revisionNotes })
      .from(proofs)
      .where(eq(proofs.orderId, orderId))
      .orderBy(desc(proofs.createdAt))
      .limit(1);
    const active = await tx
      .select({ designerId: assignments.designerId })
      .from(assignments)
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
    const logs = await tx
      .select({ action: activityLog.action, metadata: activityLog.metadata })
      .from(activityLog)
      .where(eq(activityLog.orderId, orderId));
    return { o, p, active, logs };
  });

async function dbTests() {
  const REASON = "Please put the S pumpkin with the bouquet in front back like the first version, and keep the Old Faithful change.";

  check("usage: no words is refused", (await agentRevision({ order: "anything", reason: "  " })).ok === false);
  const missing = await agentRevision({ order: `nope-${stamp}`, reason: REASON });
  check("an unknown order is not_found", !missing.ok && missing.code === "not_found");

  const a = await order();
  const dry = await agentRevision({ order: `#${a.number}`, reason: REASON });
  check("dry run: ok, names the designer and the revision it becomes", dry.ok && !dry.applied && dry.designer === DESIGNER && dry.revision === 1, JSON.stringify(dry));
  const before = await state(a.id);
  check("dry run: nothing changed", before.o.status === "awaiting_approval" && before.o.revisionCount === 0 && before.p.decision === null);

  const done = await agentRevision({ order: a.id, reason: REASON, by: "Etsy chat 17 Oct, Alpha VA", apply: true });
  check("apply: ok", done.ok && done.applied, JSON.stringify(done));
  const after = await state(a.id);
  check("apply: back in design as revision 1", after.o.status === "in_design" && after.o.revisionCount === 1, JSON.stringify(after.o));
  check("apply: the newest proof carries her words", after.p.decision === "revision" && after.p.revisionNotes === REASON);
  check("apply: the same designer, still the only active one", after.active.length === 1 && after.active[0].designerId === ids.designer);
  const log = after.logs.find((l) => (l.metadata as Record<string, unknown> | null)?.via === AGENT_REVISION_VIA);
  const meta = (log?.metadata ?? {}) as Record<string, unknown>;
  check("apply: the timeline says where it came from", !!log && meta.requestedBy === "Etsy chat 17 Oct, Alpha VA" && meta.revisionReason === REASON, JSON.stringify(after.logs));

  const again = await agentRevision({ order: a.id, reason: REASON, apply: true });
  check("a second apply is refused (no longer out for approval)", !again.ok && again.code === "not_awaiting_approval");

  const shipped = await order({ status: "delivered" });
  const late = await agentRevision({ order: shipped.number, reason: REASON, apply: true });
  check("after delivery: refused, the order page handles it", !late.ok && late.code === "not_awaiting_approval");

  const archived = await order({ archived: true });
  const arch = await agentRevision({ order: archived.number, reason: REASON, apply: true });
  check("an archived order is refused", !arch.ok && arch.code === "archived");
  check("... and left as it was", (await state(archived.id)).o.status === "awaiting_approval");

  const decided = await order({ decided: "approved" });
  const dec = await agentRevision({ order: decided.number, reason: REASON, apply: true });
  check("a newest proof that already has a decision is refused", !dec.ok && dec.code === "already_decided");
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
    await ownerDb.delete(businesses).where(eq(businesses.id, ids.biz));
    await ownerDb.delete(users).where(eq(users.id, ids.designer));
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
  console.log(failed ? `\n${failed} check(s) failed` : "\nall agent-revision checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
