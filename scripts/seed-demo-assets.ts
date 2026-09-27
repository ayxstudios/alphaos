/**
 * seed-demo-assets: make every order in the DEMO database look like a real
 * running business by attaching images from public/demo/manifest.json.
 *
 *  - every non-cancelled order: 1-3 customer reference photos (pet products
 *    get pet photos, people/family products get people photos, else any)
 *  - every order at/past awaiting_qc: a designer submission artwork matching
 *    the product style (same picker as seed-qc), unless it already has one
 *  - every order at/past awaiting_approval: a "final" asset (same artwork) so
 *    the proof and print screens show an image
 *
 * Assets are plain cdn rows (absolute url, r2Key null), which every screen
 * renders directly. Idempotent: deterministic ids + onConflictDoNothing, and
 * an order that already has an asset of a type is skipped for that type (so
 * the QC-seeded submissions are never touched). Run as the owner.
 */
import "./load-env";

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "../lib/db/schema";
import { demoArtUrl, demoPhotoPool } from "./demo/images";

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DIRECT_URL! });
const db = drizzle(pool, { schema });

const HOUR = 3_600_000;
const PAST_QC = ["awaiting_qc", "awaiting_approval", "approved", "printing", "shipped", "delivered", "complete"];
const PAST_APPROVAL = ["awaiting_approval", "approved", "printing", "shipped", "delivered", "complete"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function photoKind(title: string | null, style: string | null): "pet" | "people" | "any" {
  const t = title ?? "";
  if (/\b(pet|dog|cat|puppy|kitten|paw|paws|horse|bunny)\b/i.test(t)) return "pet";
  if (/\b(family|couple|wedding|people|person|kids?|child|children|baby|portrait of|grandparents?|self)\b/i.test(t)) return "people";
  if (style === "renaissance" && /human|people/i.test(t)) return "people";
  return "any";
}

async function main() {
  const url = new URL(process.env.DIRECT_URL!);
  if (url.username !== "neondb_owner") throw new Error(`seed-demo-assets must run as the owner (DIRECT_URL); got "${url.username}"`);

  const orders = await db
    .select({
      id: schema.orders.id,
      businessId: schema.orders.businessId,
      status: schema.orders.status,
      createdAt: schema.orders.createdAt,
      updatedAt: schema.orders.updatedAt,
    })
    .from(schema.orders)
    .where(ne(schema.orders.status, "cancelled"));
  const items = await db
    .select({ id: schema.orderItems.id, orderId: schema.orderItems.orderId, title: schema.orderItems.title, style: schema.orderItems.style })
    .from(schema.orderItems);
  const firstItem = new Map<string, (typeof items)[number]>();
  for (const it of items) if (!firstItem.has(it.orderId)) firstItem.set(it.orderId, it);

  const existing = await db
    .select({ orderId: schema.assets.orderId, type: schema.assets.type })
    .from(schema.assets)
    .where(and(inArray(schema.assets.orderId, orders.map((o) => o.id)), isNull(schema.assets.deletedAt)));
  const has = new Set(existing.map((e) => `${e.orderId}:${e.type}`));

  const designers = await db
    .select({ userId: schema.designerBusinesses.userId, businessId: schema.designerBusinesses.businessId })
    .from(schema.designerBusinesses);
  const activeAsn = await db
    .select({ orderId: schema.assignments.orderId, designerId: schema.assignments.designerId })
    .from(schema.assignments)
    .where(eq(schema.assignments.active, true));
  const asnByOrder = new Map(activeAsn.map((a) => [a.orderId, a.designerId]));
  const admins = await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.role, ["va", "admin"]));

  const rows: (typeof schema.assets.$inferInsert)[] = [];
  for (const o of orders) {
    const it = firstItem.get(o.id);
    const style = it?.style ?? null;
    const dPool = designers.filter((d) => d.businessId === o.businessId).map((d) => d.userId);
    const designerId = asnByOrder.get(o.id) ?? (dPool.length ? dPool[hash(o.id) % dPool.length] : null);
    const staffId = admins.length ? admins[hash(o.id) % admins.length].id : null;
    const base = o.createdAt.getTime();

    if (!has.has(`${o.id}:reference`)) {
      const kind = photoKind(it?.title ?? null, style);
      const photos = demoPhotoPool(kind);
      const n = 1 + (hash(o.id + "n") % 3);
      const seen = new Set<string>();
      for (let i = 0; i < n && photos.length; i++) {
        const u = photos[(hash(o.id) + i) % photos.length];
        if (seen.has(u)) continue;
        seen.add(u);
        rows.push({
          id: `demo-ref-${o.id}-${i}`,
          businessId: o.businessId,
          orderId: o.id,
          orderItemId: it?.id ?? null,
          type: "reference",
          storage: "cdn",
          url: u,
          r2Key: null,
          uploadedBy: null, // customers upload via the upload link, no staff user
          createdAt: new Date(base + (i + 1) * 60_000),
        });
      }
    }

    if (PAST_QC.includes(o.status) && !has.has(`${o.id}:submission`) && !has.has(`${o.id}:final`)) {
      const art = demoArtUrl(o.id, style) ?? `https://picsum.photos/seed/qc-${hash(o.id)}/900/900`;
      const subAt = new Date(Math.min(o.updatedAt.getTime(), base + 30 * HOUR));
      rows.push({
        id: `demo-sub-${o.id}`,
        businessId: o.businessId,
        orderId: o.id,
        orderItemId: it?.id ?? null,
        type: "submission",
        storage: "cdn",
        url: art,
        r2Key: null,
        uploadedBy: designerId,
        createdAt: subAt,
      });
      if (PAST_APPROVAL.includes(o.status) && !has.has(`${o.id}:final`)) {
        rows.push({
          id: `demo-final-${o.id}`,
          businessId: o.businessId,
          orderId: o.id,
          orderItemId: it?.id ?? null,
          type: "final",
          storage: "cdn",
          url: art,
          r2Key: null,
          uploadedBy: staffId ?? designerId,
          createdAt: new Date(subAt.getTime() + 2 * HOUR),
        });
      }
    } else if (PAST_APPROVAL.includes(o.status) && !has.has(`${o.id}:final`)) {
      // Already has a (QC-seeded) submission but no final: reuse its image.
      const art = demoArtUrl(o.id, style);
      if (art) {
        rows.push({
          id: `demo-final-${o.id}`,
          businessId: o.businessId,
          orderId: o.id,
          orderItemId: it?.id ?? null,
          type: "final",
          storage: "cdn",
          url: art,
          r2Key: null,
          uploadedBy: staffId ?? designerId,
          createdAt: new Date(o.updatedAt.getTime()),
        });
      }
    }
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const res = await db.insert(schema.assets).values(rows.slice(i, i + 200)).onConflictDoNothing().returning({ id: schema.assets.id });
    inserted += res.length;
  }
  console.log(`seed-demo-assets: ${orders.length} orders, ${rows.length} candidate assets, ${inserted} inserted`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
