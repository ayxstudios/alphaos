// Capacity model + agent rebalancing against the DEMO database (Northlight Portraits).
// Overloads one designer with synthetic orders (platform ids "captest-*"), checks a
// dry run and a real run, then restores designer profiles and the agent flag and
// archives the synthetic orders. Never run against staging or production.
import "./load-env";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, like, sql } from "drizzle-orm";

import { loadCapacityModel } from "../lib/agent/capacity";
import { rebalanceBusiness, runRebalance } from "../lib/agent/rebalance";
import { withSystemContext } from "../lib/db";
import {
  activityLog,
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

const BUSINESS_NAME = "Northlight Portraits";
const PREFIX = "captest-";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

type Profile = {
  userId: string;
  dailyCapacity: number;
  maxActiveOrders: number;
  quietStart: string | null;
  quietEnd: string | null;
};

async function main() {
  const [biz] = await withSystemContext((tx) =>
    tx
      .select({ id: businesses.id, assign: businesses.agentAssignEnabled })
      .from(businesses)
      .where(eq(businesses.name, BUSINESS_NAME)),
  );
  if (!biz) throw new Error(`demo business ${BUSINESS_NAME} not found: is .env.local the DEMO database?`);
  const businessId = biz.id;
  const originalFlag = biz.assign;

  const [shop] = await withSystemContext((tx) =>
    tx.select({ id: shops.id }).from(shops).where(eq(shops.businessId, businessId)).limit(1),
  );
  const [admin] = await withSystemContext((tx) =>
    tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.active, true))).limit(1),
  );
  if (!shop || !admin) throw new Error("demo business needs a shop and an admin user");

  const roster: Profile[] = await withSystemContext((tx) =>
    tx
      .select({
        userId: designerProfiles.userId,
        dailyCapacity: designerProfiles.dailyCapacity,
        maxActiveOrders: designerProfiles.maxActiveOrders,
        quietStart: designerProfiles.quietStart,
        quietEnd: designerProfiles.quietEnd,
      })
      .from(designerBusinesses)
      .innerJoin(users, and(eq(users.id, designerBusinesses.userId), eq(users.active, true), eq(users.role, "designer")))
      .innerJoin(designerProfiles, eq(designerProfiles.userId, designerBusinesses.userId))
      .where(eq(designerBusinesses.businessId, businessId)),
  );
  if (roster.length < 2) throw new Error("need at least 2 active designers on the demo business");
  const [overloaded, ...others] = roster;
  const orderIds: string[] = [];

  try {
    // ---- setup: everyone else roomy and awake, the first designer capped at 2 --------
    await withSystemContext(async (tx) => {
      await tx
        .update(designerProfiles)
        .set({ dailyCapacity: 100, maxActiveOrders: 0, quietStart: null, quietEnd: null })
        .where(inArray(designerProfiles.userId, others.map((o) => o.userId)));
      await tx
        .update(designerProfiles)
        .set({ dailyCapacity: 100, maxActiveOrders: 2, quietStart: null, quietEnd: null })
        .where(eq(designerProfiles.userId, overloaded.userId));
      await tx
        .update(orders)
        .set({ archivedAt: new Date(), archiveReason: "capacity test leftover" })
        .where(and(eq(orders.businessId, businessId), like(orders.platformOrderId, `${PREFIX}%`), sql`${orders.archivedAt} is null`));
    });

    const stamp = Date.now().toString(36);
    const make = async (
      kind: "plain" | "pinned" | "proof" | "started",
      n: number,
    ): Promise<string> =>
      withSystemContext(async (tx) => {
        const [cust] = await tx
          .insert(customers)
          .values({ businessId, email: `${PREFIX}${stamp}-${kind}${n}@example.test`, firstName: "Cap", lastName: "Test" })
          .returning({ id: customers.id });
        const [o] = await tx
          .insert(orders)
          .values({
            businessId,
            shopId: shop.id,
            customerId: cust.id,
            platformOrderId: `${PREFIX}${stamp}-${kind}${n}`,
            platformOrderName: `${PREFIX}${stamp}-${kind}${n}`,
            status: kind === "started" ? "in_design" : "ready_to_assign",
            source: "manual",
            uploadToken: randomUUID(),
          })
          .returning({ id: orders.id });
        await tx.insert(orderItems).values({
          businessId,
          orderId: o.id,
          title: "Custom portrait",
          figureCount: 1,
          figureCountSource: "manual",
          productType: "digital",
        });
        await tx.insert(assignments).values({
          businessId,
          orderId: o.id,
          designerId: overloaded.userId,
          assignedBy: kind === "pinned" ? admin.id : null,
          // Older than the stage timer so the same orders would also qualify if the designer were away.
          assignedAt: new Date(Date.now() - (30 - n) * 60 * 1000),
          dueAt: new Date(Date.now() + 24 * 3600 * 1000),
          active: true,
        });
        if (kind === "proof") {
          await tx.insert(assets).values({
            businessId,
            orderId: o.id,
            type: "submission",
            storage: "cdn",
            url: "https://example.test/captest-proof.jpg",
          });
        }
        orderIds.push(o.id);
        return o.id;
      });

    const plain = [await make("plain", 1), await make("plain", 2), await make("plain", 3)];
    const pinned = await make("pinned", 4);
    const proof = await make("proof", 5);
    const started = await make("started", 6);
    const all = [...plain, pinned, proof, started];

    const holder = async (id: string) =>
      withSystemContext(async (tx) => {
        const [a] = await tx
          .select({ d: assignments.designerId })
          .from(assignments)
          .where(and(eq(assignments.orderId, id), eq(assignments.active, true)));
        return a?.d ?? null;
      });

    // ---- capacity model ----------------------------------------------------------------
    const model = await withSystemContext((tx) => loadCapacityModel(tx, businessId));
    const row = model.designers.find((d) => d.designerId === overloaded.userId)!;
    check("model: overloaded designer flagged over capacity", row.overCapacity && row.status === "over_capacity", `${row.openLoad}/${row.limit}`);
    check("model: open load counts queued + started", row.openLoad >= 6 && row.queued >= 5, `open ${row.openLoad} queued ${row.queued}`);
    check("model: weekly = daily x 5", row.weeklyCapacity === 500);
    check("model: limit is the tighter max-active cap", row.limit === 2);

    // ---- flag off: the tick hook does nothing -----------------------------------------
    await withSystemContext((tx) => tx.update(businesses).set({ agentAssignEnabled: false }).where(eq(businesses.id, businessId)));
    const off = await runRebalance(businessId);
    check("flag off: no moves", off.moves.length === 0);

    // ---- dry run: reports moves, changes nothing --------------------------------------
    const dry = await rebalanceBusiness(businessId, { dryRun: true });
    const dryMine = dry.moves.filter((m) => all.includes(m.orderId));
    check("dry run: plans the 3 plain orders", dryMine.length === 3 && plain.every((id) => dryMine.some((m) => m.orderId === id)), `moves ${dryMine.length}`);
    check("dry run: pinned counted as skipped", dry.skippedPinned >= 1, `skippedPinned ${dry.skippedPinned}`);
    check("dry run: nothing changed", (await Promise.all(all.map(holder))).every((d) => d === overloaded.userId));

    // ---- real run ---------------------------------------------------------------------
    await withSystemContext((tx) => tx.update(businesses).set({ agentAssignEnabled: true }).where(eq(businesses.id, businessId)));
    const real = await runRebalance(businessId);
    const realMine = real.moves.filter((m) => all.includes(m.orderId));
    check("real run: 3 plain orders moved", realMine.length === 3, `moves ${realMine.length}`);
    check("real run: no errors", real.errors.length === 0, real.errors.map((e) => e.message).join("; "));
    const heldNow = await Promise.all(plain.map(holder));
    check("real run: plain orders now with another designer", heldNow.every((d) => d && d !== overloaded.userId));
    check("real run: pinned order untouched", (await holder(pinned)) === overloaded.userId);
    check("real run: order with a proof untouched", (await holder(proof)) === overloaded.userId);
    check("real run: started order untouched", (await holder(started)) === overloaded.userId);

    const logs = await withSystemContext((tx) =>
      tx
        .select({ orderId: activityLog.orderId, actorId: activityLog.actorId, metadata: activityLog.metadata })
        .from(activityLog)
        .where(and(eq(activityLog.action, "agent.rebalanced"), inArray(activityLog.orderId, all))),
    );
    check(
      "activity log: agent.rebalanced, actor null, from/to/reason",
      logs.length === 3 &&
        logs.every((l) => {
          const m = l.metadata as { from?: string; to?: string; reason?: string } | null;
          return l.actorId === null && m?.from === overloaded.userId && !!m?.to && !!m?.reason;
        }),
      `rows ${logs.length}`,
    );

    const again = await runRebalance(businessId);
    check("second run: nothing more to move", again.moves.filter((m) => all.includes(m.orderId)).length === 0);
  } finally {
    // ---- restore -----------------------------------------------------------------------
    await withSystemContext(async (tx) => {
      for (const p of roster) {
        await tx
          .update(designerProfiles)
          .set({
            dailyCapacity: p.dailyCapacity,
            maxActiveOrders: p.maxActiveOrders,
            quietStart: p.quietStart,
            quietEnd: p.quietEnd,
          })
          .where(eq(designerProfiles.userId, p.userId));
      }
      await tx.update(businesses).set({ agentAssignEnabled: originalFlag }).where(eq(businesses.id, businessId));
      if (orderIds.length) {
        await tx.update(assignments).set({ active: false }).where(inArray(assignments.orderId, orderIds));
        await tx
          .update(orders)
          .set({ archivedAt: new Date(), archiveReason: "capacity test cleanup" })
          .where(inArray(orders.id, orderIds));
      }
    });
    const [after] = await withSystemContext((tx) =>
      tx.select({ a: businesses.agentAssignEnabled }).from(businesses).where(eq(businesses.id, businessId)),
    );
    check("restore: agent assign flag back to original", after?.a === originalFlag, `was ${originalFlag}`);
  }

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
