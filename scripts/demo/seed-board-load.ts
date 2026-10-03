/**
 * seed-board-load: stress-load ONE demo designer board so the Trello-style
 * staff board can be judged at real scale (Yousif 2026-10-01: "wouldn't
 * handle 50 orders plus easily"). Clones an existing live order on the
 * busiest demo designer's board into ~54 new orders (40 in design, 8 queued,
 * 6 awaiting QC), each with items, a reference photo and an active
 * assignment. Demo database only; every row is tagged rawImport.loadSeeded
 * so `--clean` removes them all.
 */
import "../load-env";
import { and, eq, sql } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "../../lib/db/schema";

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DIRECT_URL! });
const db = drizzle(pool, { schema });

async function main() {
  const url = new URL(process.env.DIRECT_URL!);
  if (url.username !== "neondb_owner") throw new Error("run as the demo owner (DIRECT_URL)");

  if (process.argv.includes("--clean")) {
    const seeded = await db.select({ id: schema.orders.id }).from(schema.orders)
      .where(sql`raw_import ->> 'loadSeeded' = '1'`);
    for (const o of seeded) {
      await db.delete(schema.activityLog).where(eq(schema.activityLog.orderId, o.id));
      await db.delete(schema.assets).where(eq(schema.assets.orderId, o.id));
      await db.delete(schema.assignments).where(eq(schema.assignments.orderId, o.id));
      await db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, o.id));
      await db.delete(schema.orders).where(eq(schema.orders.id, o.id));
    }
    console.log(`cleaned ${seeded.length}`);
    return;
  }

  // Source: Dana's in_design order on Northlight (the busiest demo board).
  const [src] = await db.select().from(schema.orders)
    .innerJoin(schema.assignments, and(eq(schema.assignments.orderId, schema.orders.id), eq(schema.assignments.active, true)))
    .where(eq(schema.orders.status, "in_design"))
    .limit(1);
  if (!src) throw new Error("no in_design source order found");
  const source = src.orders;
  const designerId = src.assignments.designerId;
  const [items, refs] = await Promise.all([
    db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, source.id)),
    db.select().from(schema.assets).where(and(eq(schema.assets.orderId, source.id), eq(schema.assets.type, "reference"))),
  ]);

  const statuses = [
    ...Array(40).fill("in_design"),
    ...Array(8).fill("ready_to_assign"),
    ...Array(6).fill("awaiting_qc"),
  ] as const;
  const now = Date.now();
  let n = 0;
  for (const status of statuses) {
    n++;
    const num = `LOAD-${String(n).padStart(3, "0")}`;
    const [order] = await db.insert(schema.orders).values({
      ...source,
      id: undefined as never,
      platformOrderId: `load-seed-${n}`,
      platformOrderName: num,
      uploadToken: crypto.randomUUID(),
      status,
      dueAt: new Date(now + (n - 10) * 3_600_000),
      createdAt: new Date(now - n * 600_000),
      updatedAt: new Date(now - n * 300_000),
      revisionCount: 0,
      rawImport: { ...(source.rawImport as object ?? {}), loadSeeded: "1" },
    }).returning({ id: schema.orders.id });
    for (const it of items) {
      await db.insert(schema.orderItems).values({ ...it, id: undefined as never, orderId: order.id });
    }
    // Vary the thumbnail so the column doesn't look like one repeated card.
    for (const a of refs) {
      const url = a.url?.includes("picsum.photos") ? a.url.replace(/seed\/[^/]*\//, `seed/load${n}/`) : a.url;
      await db.insert(schema.assets).values({ ...a, id: undefined as never, orderId: order.id, url });
    }
    await db.insert(schema.assignments).values({
      businessId: source.businessId,
      orderId: order.id,
      designerId,
      active: true,
      dueAt: new Date(now + (n - 10) * 3_600_000),
    });
  }
  console.log(`seeded ${n} orders onto designer ${designerId}`);
}

main().then(() => pool.end());
