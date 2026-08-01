/**
 * Seed script. Connects as the OWNER (DIRECT_URL) so it bypasses RLS
 * legitimately — seeds set up cross-tenant data no request-context user could.
 *
 * Idempotent: truncates the application tables, then inserts a fixed fixture:
 *   - 2 businesses (PixArt + Lumina, a second test brand)
 *   - 1 admin, 2 VAs, 3 designers (d1 spans both businesses; d2 -> PixArt,
 *     d3 -> Lumina), designer capacities 5 / 8 / 3
 *   - 4 shops (PixArt Etsy + Shopify, Lumina Etsy + Shopify) w/ encrypted creds
 *   - 11 customers, 20 orders across all statuses (some overdue, some due soon),
 *     order_items with figure counts 1-3, and active assignments giving every
 *     designer work (d1=6, d2=4, d3=4).
 */
import { randomUUID } from "node:crypto";

import { config } from "dotenv";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import ws from "ws";

import * as schema from "../lib/db/schema";
import { encryptCredentials } from "../lib/db/credentials";
import { hashPassword } from "../lib/auth/password";

// Dev-only password shared by every seeded user (printed at the end).
const DEV_PASSWORD = "alphaos123";

config({ path: ".env.local" });
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DIRECT_URL! });
const db = drizzle(pool, { schema });

const HOUR = 60 * 60 * 1000;
const now = Date.now();
const at = (hoursFromNow: number) => new Date(now + hoursFromNow * HOUR);

async function main() {
  const url = new URL(process.env.DIRECT_URL!);
  if (url.username !== "neondb_owner") {
    throw new Error(
      `Seed must run as the owner (DIRECT_URL); got user "${url.username}"`,
    );
  }

  // ---- reset -------------------------------------------------------------
  await db.execute(sql`
    truncate table
      activity_log, notifications, notification_channels, earnings,
      print_jobs, messages, proofs, qc_checks, assignments, assets,
      order_items, orders, customers, designer_businesses, designer_profiles,
      shops, businesses, "user"
    restart identity cascade
  `);

  // ---- businesses --------------------------------------------------------
  const pixart = randomUUID();
  const lumina = randomUUID();
  await db.insert(schema.businesses).values([
    { id: pixart, name: "PixArt", slug: "pixart" },
    { id: lumina, name: "Lumina", slug: "lumina" },
  ]);

  // ---- users -------------------------------------------------------------
  const admin = randomUUID();
  const va1 = randomUUID();
  const va2 = randomUUID();
  const d1 = randomUUID();
  const d2 = randomUUID();
  const d3 = randomUUID();
  const passwordHash = await hashPassword(DEV_PASSWORD);
  await db.insert(schema.users).values([
    { id: admin, name: "Ada Admin", email: "admin@aystudios.io", role: "admin", passwordHash },
    { id: va1, name: "Vic VA", email: "va1@aystudios.io", role: "va", passwordHash },
    { id: va2, name: "Val VA", email: "va2@aystudios.io", role: "va", passwordHash },
    { id: d1, name: "Dana Designer", email: "d1@aystudios.io", role: "designer", passwordHash },
    { id: d2, name: "Deb Designer", email: "d2@aystudios.io", role: "designer", passwordHash },
    { id: d3, name: "Dex Designer", email: "d3@aystudios.io", role: "designer", passwordHash },
  ]);

  await db.insert(schema.designerProfiles).values([
    { userId: d1, dailyCapacity: 5, perFigureRate: "4.00", styles: ["classic"] },
    { userId: d2, dailyCapacity: 8, perFigureRate: "3.50", styles: ["modern"] },
    { userId: d3, dailyCapacity: 3, perFigureRate: "5.00", styles: ["retro"] },
  ]);

  // d1 spans both businesses; d2 -> PixArt only; d3 -> Lumina only.
  await db.insert(schema.designerBusinesses).values([
    { userId: d1, businessId: pixart },
    { userId: d1, businessId: lumina },
    { userId: d2, businessId: pixart },
    { userId: d3, businessId: lumina },
  ]);

  // ---- shops -------------------------------------------------------------
  const s1 = randomUUID(); // PixArt Etsy
  const s2 = randomUUID(); // PixArt Shopify
  const s3 = randomUUID(); // Lumina Etsy
  const s4 = randomUUID(); // Lumina Shopify
  const etsyCreds = () =>
    encryptCredentials({
      keystring: "etsy_keystring_" + randomUUID().slice(0, 8),
      sharedSecret: "etsy_secret_" + randomUUID().slice(0, 8),
      accessToken: "etsy_at_" + randomUUID().slice(0, 8),
      refreshToken: "etsy_rt_" + randomUUID().slice(0, 8),
    });
  const shopifyCreds = () =>
    encryptCredentials({
      accessToken: "shpat_" + randomUUID().slice(0, 12),
    });
  await db.insert(schema.shops).values([
    { id: s1, businessId: pixart, platform: "etsy", name: "PixArt Etsy", externalShopId: "etsy-pixart-1", credentials: etsyCreds() },
    { id: s2, businessId: pixart, platform: "shopify", name: "PixArt Shopify", externalShopId: "pixart.myshopify.com", credentials: shopifyCreds() },
    { id: s3, businessId: lumina, platform: "etsy", name: "Lumina Etsy", externalShopId: "etsy-lumina-1", credentials: etsyCreds() },
    { id: s4, businessId: lumina, platform: "shopify", name: "Lumina Shopify", externalShopId: "lumina.myshopify.com", credentials: shopifyCreds() },
  ]);

  // ---- customers ---------------------------------------------------------
  type C = { id: string; business: string; email: string; first: string; last: string };
  const customers: C[] = [
    { id: randomUUID(), business: pixart, email: "alice@example.com", first: "Alice", last: "Nguyen" },
    { id: randomUUID(), business: pixart, email: "ben@example.com", first: "Ben", last: "Carter" },
    { id: randomUUID(), business: pixart, email: "chloe@example.com", first: "Chloe", last: "Diaz" },
    { id: randomUUID(), business: pixart, email: "dan@example.com", first: "Dan", last: "Evans" },
    { id: randomUUID(), business: pixart, email: "erin@example.com", first: "Erin", last: "Ford" },
    { id: randomUUID(), business: pixart, email: "finn@example.com", first: "Finn", last: "Gray" },
    { id: randomUUID(), business: lumina, email: "gwen@example.com", first: "Gwen", last: "Hill" },
    { id: randomUUID(), business: lumina, email: "hugo@example.com", first: "Hugo", last: "Iyer" },
    { id: randomUUID(), business: lumina, email: "isla@example.com", first: "Isla", last: "Jones" },
    { id: randomUUID(), business: lumina, email: "jack@example.com", first: "Jack", last: "Kerr" },
    { id: randomUUID(), business: lumina, email: "kira@example.com", first: "Kira", last: "Lowe" },
  ];
  await db.insert(schema.customers).values(
    customers.map((c) => ({
      id: c.id,
      businessId: c.business,
      email: c.email,
      firstName: c.first,
      lastName: c.last,
    })),
  );
  const c = (email: string) => customers.find((x) => x.email === email)!.id;

  // ---- orders + items + assignments -------------------------------------
  type OrderSpec = {
    business: string;
    shop: string;
    platform: "etsy" | "shopify";
    customer: string;
    status: (typeof schema.orderStatus.enumValues)[number];
    dueH: number | null; // hours from now; negative = overdue
    assignee: string | null;
    figures: number[]; // one order_item per entry
  };

  const specs: OrderSpec[] = [
    // PixArt (b1)
    { business: pixart, shop: s1, platform: "etsy", customer: c("alice@example.com"), status: "in_design", dueH: -12, assignee: d2, figures: [2] },
    { business: pixart, shop: s1, platform: "etsy", customer: c("ben@example.com"), status: "awaiting_qc", dueH: 18, assignee: d2, figures: [1] },
    { business: pixart, shop: s2, platform: "shopify", customer: c("chloe@example.com"), status: "in_design", dueH: 6, assignee: d1, figures: [3] },
    { business: pixart, shop: s2, platform: "shopify", customer: c("alice@example.com"), status: "printing", dueH: -48, assignee: d1, figures: [1, 2] },
    { business: pixart, shop: s1, platform: "etsy", customer: c("dan@example.com"), status: "ready_to_assign", dueH: 72, assignee: null, figures: [1] },
    { business: pixart, shop: s1, platform: "etsy", customer: c("ben@example.com"), status: "awaiting_photos", dueH: null, assignee: null, figures: [1] },
    { business: pixart, shop: s2, platform: "shopify", customer: c("erin@example.com"), status: "awaiting_approval", dueH: 30, assignee: d2, figures: [2] },
    { business: pixart, shop: s2, platform: "shopify", customer: c("chloe@example.com"), status: "complete", dueH: -240, assignee: d1, figures: [1] },
    { business: pixart, shop: s1, platform: "etsy", customer: c("finn@example.com"), status: "shipped", dueH: -120, assignee: d2, figures: [3] },
    { business: pixart, shop: s1, platform: "etsy", customer: c("dan@example.com"), status: "on_hold", dueH: 200, assignee: null, figures: [1] },
    { business: pixart, shop: s2, platform: "shopify", customer: c("erin@example.com"), status: "delivered", dueH: -300, assignee: d1, figures: [2] },
    { business: pixart, shop: s2, platform: "shopify", customer: c("alice@example.com"), status: "cancelled", dueH: null, assignee: null, figures: [1] },
    // Lumina (b2)
    { business: lumina, shop: s3, platform: "etsy", customer: c("gwen@example.com"), status: "in_design", dueH: -6, assignee: d3, figures: [2] },
    { business: lumina, shop: s3, platform: "etsy", customer: c("hugo@example.com"), status: "awaiting_qc", dueH: 20, assignee: d3, figures: [1] },
    { business: lumina, shop: s4, platform: "shopify", customer: c("isla@example.com"), status: "in_design", dueH: 12, assignee: d1, figures: [3] },
    { business: lumina, shop: s4, platform: "shopify", customer: c("gwen@example.com"), status: "printing", dueH: -72, assignee: d1, figures: [1] },
    { business: lumina, shop: s3, platform: "etsy", customer: c("jack@example.com"), status: "ready_to_assign", dueH: 96, assignee: null, figures: [2] },
    { business: lumina, shop: s3, platform: "etsy", customer: c("hugo@example.com"), status: "approved", dueH: 40, assignee: d3, figures: [1] },
    { business: lumina, shop: s4, platform: "shopify", customer: c("isla@example.com"), status: "shipped", dueH: -150, assignee: d3, figures: [2] },
    { business: lumina, shop: s4, platform: "shopify", customer: c("kira@example.com"), status: "awaiting_photos", dueH: null, assignee: null, figures: [1] },
  ];

  let orderNo = 1000;
  for (const o of specs) {
    orderNo += 1;
    const orderId = randomUUID();
    const dueAt = o.dueH === null ? null : at(o.dueH);
    await db.insert(schema.orders).values({
      id: orderId,
      businessId: o.business,
      shopId: o.shop,
      customerId: o.customer,
      platformOrderId: `ORD-${orderNo}`,
      status: o.status,
      source: o.platform,
      dueAt,
      placedAt: at(-500),
      uploadToken: randomUUID(),
    });

    await db.insert(schema.orderItems).values(
      o.figures.map((fc, idx) => ({
        id: randomUUID(),
        businessId: o.business,
        orderId,
        sku: `SKU-${orderNo}-${idx + 1}`,
        variation: fc > 1 ? `${fc} figures` : "1 figure",
        figureCount: fc,
        style: "classic",
        productType: o.platform === "shopify" ? ("physical" as const) : ("digital" as const),
      })),
    );

    if (o.assignee) {
      await db.insert(schema.assignments).values({
        id: randomUUID(),
        businessId: o.business,
        orderId,
        designerId: o.assignee,
        assignedBy: va1,
        dueAt: dueAt ?? at(24),
        active: true,
      });
    }
  }

  // ---- summary -----------------------------------------------------------
  const counts = await db.execute<{ t: string; n: number }>(sql`
    select 'businesses' t, count(*)::int n from businesses
    union all select 'users', count(*)::int from "user"
    union all select 'shops', count(*)::int from shops
    union all select 'customers', count(*)::int from customers
    union all select 'orders', count(*)::int from orders
    union all select 'order_items', count(*)::int from order_items
    union all select 'assignments (active)', count(*)::int from assignments where active
    order by t
  `);
  console.log("Seed complete:");
  for (const row of counts.rows) console.log(`  ${row.t}: ${row.n}`);

  // Login credentials for testing each role (dev only).
  console.log("\nLogin credentials (password is the same for all):");
  const logins = [
    ["admin@aystudios.io", "admin"],
    ["va1@aystudios.io", "va"],
    ["va2@aystudios.io", "va"],
    ["d1@aystudios.io", "designer (both businesses)"],
    ["d2@aystudios.io", "designer (PixArt)"],
    ["d3@aystudios.io", "designer (Lumina)"],
  ];
  for (const [email, role] of logins) {
    console.log(`  ${email.padEnd(22)} ${DEV_PASSWORD}   ${role}`);
  }

  // Expose the ids the RLS test needs, without hardcoding UUIDs there.
  console.log(
    "\nSEED_IDS=" +
      JSON.stringify({
        pixart,
        lumina,
        admin,
        va1,
        d1,
        d2,
        d3,
      }),
  );

  await pool.end();
}

main().catch(async (err) => {
  console.error("Seed failed:", err);
  await pool.end();
  process.exit(1);
});
