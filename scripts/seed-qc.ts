/**
 * seed-qc: keep a LIVE quality-check queue in the demo database.
 *
 * The history seed only writes finished lifecycles, so nothing ever sits in
 * awaiting_qc and the QC page reads "Nothing waiting". This script moves a
 * handful of live orders per business into awaiting_qc with a real submitted
 * portrait (picsum placeholder, like every other demo photo), an active
 * designer assignment and the activity-log entry the QC clock reads.
 *
 * Idempotent: a business that already has >= TARGET orders awaiting QC with a
 * submission is left alone; orders it touched are tagged rawImport.qcSeeded.
 * Run as the owner:  npm run seed:qc
 */
import "./load-env";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "../lib/db/schema";

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DIRECT_URL! });
const db = drizzle(pool, { schema });

const TARGET = Number(process.env.SEED_QC_TARGET ?? 4);
const HOUR = 3_600_000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

async function main() {
  const url = new URL(process.env.DIRECT_URL!);
  if (url.username !== "neondb_owner") throw new Error(`seed-qc must run as the owner (DIRECT_URL); got "${url.username}"`);

  const businesses = await db.select({ id: schema.businesses.id, name: schema.businesses.name }).from(schema.businesses);
  const designers = await db
    .select({ userId: schema.designerBusinesses.userId, businessId: schema.designerBusinesses.businessId })
    .from(schema.designerBusinesses);
  const vas = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "va"));
  const now = new Date();

  for (const biz of businesses) {
    const pool = designers.filter((d) => d.businessId === biz.id).map((d) => d.userId);
    if (!pool.length) continue;

    // 1. Every order already awaiting QC gets a submission if it has none
    //    (the one stray awaiting_qc row had nothing to review).
    const waiting = await db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(and(eq(schema.orders.businessId, biz.id), eq(schema.orders.status, "awaiting_qc"), isNull(schema.orders.archivedAt)));
    let withSubmission = 0;
    for (const o of waiting) {
      const [sub] = await db
        .select({ id: schema.assets.id })
        .from(schema.assets)
        .where(and(eq(schema.assets.orderId, o.id), inArray(schema.assets.type, ["submission", "final"]), isNull(schema.assets.deletedAt)))
        .limit(1);
      if (sub) {
        withSubmission += 1;
        continue;
      }
      await addSubmission(o.id, biz.id, pool, now, vas.map((v) => v.id), true);
      withSubmission += 1;
    }

    // 2. Top the queue up to TARGET from live orders that are ready or in design.
    const need = TARGET - withSubmission;
    if (need <= 0) {
      console.log(`${biz.name}: ${withSubmission} awaiting QC, nothing to do`);
      continue;
    }
    const candidates = await db
      .select({ id: schema.orders.id, status: schema.orders.status, dueAt: schema.orders.dueAt })
      .from(schema.orders)
      .where(and(eq(schema.orders.businessId, biz.id), inArray(schema.orders.status, ["in_design", "ready_to_assign"]), isNull(schema.orders.archivedAt)))
      .orderBy(sql`${schema.orders.dueAt} asc nulls last`, schema.orders.createdAt)
      .limit(need * 3);
    // Prefer orders that actually have reference photos (the QC screen shows them side by side).
    const picked: typeof candidates = [];
    for (const c of candidates) {
      const [ref] = await db
        .select({ id: schema.assets.id })
        .from(schema.assets)
        .where(and(eq(schema.assets.orderId, c.id), eq(schema.assets.type, "reference"), isNull(schema.assets.deletedAt)))
        .limit(1);
      if (ref) picked.push(c);
      if (picked.length >= need) break;
    }
    for (const c of candidates) {
      if (picked.length >= need) break;
      if (!picked.includes(c)) picked.push(c);
    }

    for (const [i, o] of picked.entries()) {
      const submittedAt = new Date(now.getTime() - (2 + i * 5 + (hash(o.id) % 4)) * HOUR);
      await addSubmission(o.id, biz.id, pool, submittedAt, vas.map((v) => v.id), o.status !== "in_design");
      await db
        .update(schema.orders)
        .set({ status: "awaiting_qc", updatedAt: submittedAt, rawImport: sql`coalesce(${schema.orders.rawImport}, '{}'::jsonb) || '{"qcSeeded": true}'::jsonb` })
        .where(eq(schema.orders.id, o.id));
    }
    console.log(`${biz.name}: moved ${picked.length} order(s) into QC (now ${withSubmission + picked.length})`);
  }
  await pool.end();
}

/** Assignment (if missing) + submission asset + the in_design -> awaiting_qc log line. */
async function addSubmission(orderId: string, businessId: string, designerPool: string[], submittedAt: Date, vaIds: string[], logStart: boolean) {
  const designerId = designerPool[hash(orderId) % designerPool.length];
  const [asn] = await db
    .select({ id: schema.assignments.id, designerId: schema.assignments.designerId })
    .from(schema.assignments)
    .where(and(eq(schema.assignments.orderId, orderId), eq(schema.assignments.active, true)))
    .limit(1);
  const who = asn?.designerId ?? designerId;
  const startedAt = new Date(submittedAt.getTime() - 20 * HOUR);
  if (!asn) {
    await db.insert(schema.assignments).values({
      id: `qc-asn-${orderId}`,
      businessId,
      orderId,
      designerId: who,
      assignedBy: vaIds[hash(orderId) % Math.max(1, vaIds.length)] ?? null,
      assignedAt: startedAt,
      dueAt: new Date(submittedAt.getTime() + 24 * HOUR),
      active: true,
    }).onConflictDoNothing();
  }
  await db.insert(schema.assets).values({
    id: `qc-sub-${orderId}`,
    businessId,
    orderId,
    type: "submission",
    storage: "cdn",
    url: `https://picsum.photos/seed/qc-${hash(orderId)}/900/900`,
    uploadedBy: who,
    createdAt: submittedAt,
  }).onConflictDoNothing();
  if (logStart) {
    await db.insert(schema.activityLog).values({
      id: `qc-act-start-${orderId}`,
      businessId,
      orderId,
      actorId: who,
      action: "order.in_design",
      fromState: "ready_to_assign",
      toState: "in_design",
      createdAt: startedAt,
      metadata: { seed: "qc" },
    }).onConflictDoNothing();
  }
  await db.insert(schema.activityLog).values({
    id: `qc-act-${orderId}`,
    businessId,
    orderId,
    actorId: who,
    action: "order.awaiting_qc",
    fromState: "in_design",
    toState: "awaiting_qc",
    createdAt: submittedAt,
    metadata: { seed: "qc" },
  }).onConflictDoNothing();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
