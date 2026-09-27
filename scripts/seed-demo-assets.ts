/**
 * seed-demo-assets: make every order in the DEMO database look like a real
 * running business by attaching images from public/demo/manifest.json.
 *
 *  - every non-cancelled order: 1-3 customer reference photos (pet products
 *    get pet photos, people/family products get people photos, else any)
 *  - an order that has (or gets) a submission uses the photo that artwork was
 *    drawn from (manifest.pairs) as its FIRST reference photo, so QC compares a
 *    coherent pair; extra reference photos may be anything
 *  - 3 fresh ready_to_assign orders per business (reference photos, no
 *    assignee) so the assign list always has work
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
import { createHash } from "node:crypto";

import { demoArtUrl, demoPairedPhoto, demoPhotoPool } from "./demo/images";

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

  const subUrls = await db
    .select({ orderId: schema.assets.orderId, type: schema.assets.type, url: schema.assets.url })
    .from(schema.assets)
    .where(and(inArray(schema.assets.type, ["submission", "final"]), isNull(schema.assets.deletedAt)));
  const artOf = new Map<string, string>();
  for (const a of subUrls) if (a.url && !artOf.has(a.orderId)) artOf.set(a.orderId, a.url);

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
  const fixups: { orderId: string; paired: string }[] = [];
  for (const o of orders) {
    const it = firstItem.get(o.id);
    const style = it?.style ?? null;
    const dPool = designers.filter((d) => d.businessId === o.businessId).map((d) => d.userId);
    const designerId = asnByOrder.get(o.id) ?? (dPool.length ? dPool[hash(o.id) % dPool.length] : null);
    const staffId = admins.length ? admins[hash(o.id) % admins.length].id : null;
    const base = o.createdAt.getTime();

    // Artwork this order will show in QC: the seeded one, or the one we are about to add.
    const hasSub = PAST_QC.includes(o.status);
    const plannedArt = artOf.get(o.id) ?? (hasSub ? demoArtUrl(o.id, style) : null);
    const paired = plannedArt ? demoPairedPhoto(plannedArt) : null;
    if (plannedArt && !artOf.has(o.id)) artOf.set(o.id, plannedArt);

    if (has.has(`${o.id}:reference`)) {
      if (paired) fixups.push({ orderId: o.id, paired });
    } else {
      const kind = photoKind(it?.title ?? null, style);
      const photos = demoPhotoPool(kind);
      const n = 1 + (hash(o.id + "n") % 3);
      const seen = new Set<string>(paired ? [paired] : []);
      if (paired) {
        rows.push({
          id: `demo-ref-${o.id}-0`,
          businessId: o.businessId,
          orderId: o.id,
          orderItemId: it?.id ?? null,
          type: "reference",
          storage: "cdn",
          url: paired,
          r2Key: null,
          uploadedBy: null,
          createdAt: new Date(base + 60_000),
        });
      }
      for (let i = paired ? 1 : 0; i < n && photos.length; i++) {
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
      const art = plannedArt ?? `https://picsum.photos/seed/qc-${hash(o.id)}/900/900`;
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

  // Orders whose reference photos already existed (QC-seeded): make the earliest
  // reference the photo the submission was drawn from, and drop any duplicate of it.
  let repaired = 0;
  for (const f of fixups) {
    const refs = await db
      .select({ id: schema.assets.id, url: schema.assets.url })
      .from(schema.assets)
      .where(and(eq(schema.assets.orderId, f.orderId), eq(schema.assets.type, "reference"), isNull(schema.assets.deletedAt)))
      .orderBy(schema.assets.createdAt, schema.assets.id);
    if (refs.length === 0 || refs[0].url === f.paired) continue;
    const dupes = refs.slice(1).filter((r) => r.url === f.paired).map((r) => r.id);
    if (dupes.length) await db.update(schema.assets).set({ deletedAt: new Date() }).where(inArray(schema.assets.id, dupes));
    await db.update(schema.assets).set({ url: f.paired }).where(eq(schema.assets.id, refs[0].id));
    repaired += 1;
  }

  // ---- 3 fresh ready_to_assign orders per business ------------------------
  const detId = (k: string) => {
    const h = createHash("sha1").update(k).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const READY = [
    { first: "Ruth", last: "Calloway", title: "Custom Hand-Drawn Cartoon Pet Portrait", style: "cartoon", kind: "pet" as const },
    { first: "Marcus", last: "Ellery", title: "Custom Watercolor Pet Portrait from Photo", style: "watercolor", kind: "pet" as const },
    { first: "Priya", last: "Venn", title: "Custom Renaissance Portrait from Photo", style: "renaissance", kind: "people" as const },
  ];
  const biz = await db.select({ id: schema.businesses.id, slug: schema.businesses.slug }).from(schema.businesses);
  const shopRows = await db.select({ id: schema.shops.id, businessId: schema.shops.businessId, platform: schema.shops.platform }).from(schema.shops);
  let readyNew = 0;
  for (const b of biz) {
    const shop = shopRows.find((x) => x.businessId === b.id && x.platform === "etsy") ?? shopRows.find((x) => x.businessId === b.id);
    if (!shop) continue;
    for (const [i, r] of READY.entries()) {
      const key = `demo-ready-${b.slug}-${i}`;
      const customerId = detId(`${key}-cust`);
      const orderId = detId(`${key}-order`);
      const itemId = detId(`${key}-item`);
      const placed = new Date(Date.now() - (6 + i * 5) * HOUR);
      const cust = await db
        .insert(schema.customers)
        .values({ id: customerId, businessId: b.id, email: `${r.first.toLowerCase()}.${b.slug}@example.com`, firstName: r.first, lastName: r.last })
        .onConflictDoNothing()
        .returning({ id: schema.customers.id });
      const ord = await db
        .insert(schema.orders)
        .values({
          id: orderId,
          businessId: b.id,
          shopId: shop.id,
          customerId,
          platformOrderId: `ORD-R${b.slug.slice(0, 2).toUpperCase()}${i + 1}`,
          status: "ready_to_assign",
          source: shop.platform,
          dueAt: new Date(Date.now() + (48 + i * 24) * HOUR),
          placedAt: placed,
          uploadToken: detId(`${key}-token`),
        })
        .onConflictDoNothing()
        .returning({ id: schema.orders.id });
      void cust;
      if (!ord.length) continue;
      readyNew += 1;
      await db
        .insert(schema.orderItems)
        .values({
          id: itemId,
          businessId: b.id,
          orderId,
          sku: `READY-${i + 1}`,
          title: r.title,
          variation: "1 figure",
          figureCount: 1,
          style: r.style,
          productType: shop.platform === "shopify" ? "physical" : "digital",
        })
        .onConflictDoNothing();
      const pool = demoPhotoPool(r.kind);
      const refs = [pool[(hash(key) + 0) % pool.length], pool[(hash(key) + 1) % pool.length]].filter((u, k, a) => u && a.indexOf(u) === k);
      refs.forEach((u, k) =>
        rows.push({
          id: `demo-ref-${orderId}-${k}`,
          businessId: b.id,
          orderId,
          orderItemId: itemId,
          type: "reference",
          storage: "cdn",
          url: u,
          r2Key: null,
          uploadedBy: null,
          createdAt: new Date(placed.getTime() + (k + 1) * 60_000),
        }),
      );
    }
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const res = await db.insert(schema.assets).values(rows.slice(i, i + 200)).onConflictDoNothing().returning({ id: schema.assets.id });
    inserted += res.length;
  }
  console.log(`seed-demo-assets: ${orders.length} orders, ${rows.length} candidate assets, ${inserted} inserted, ${repaired} orders re-paired to their artwork's source photo, ${readyNew} ready_to_assign orders added`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
