/**
 * Seed script. Connects as the OWNER (DIRECT_URL) so it bypasses RLS
 * legitimately — seeds set up cross-tenant data no request-context user could.
 *
 * Idempotent: truncates the application tables, then inserts a fixed fixture:
 *   - 2 businesses (PixArt + Lumina by default; override with SEED_BUSINESS_A_*
 *     / SEED_BUSINESS_B_* for a fictional demo, see docs/DEMO.md)
 *   - 1 admin, 2 VAs, 3 designers (d1 spans both businesses; d2 -> business A,
 *     d3 -> business B), designer capacities 5 / 8 / 3 (override the 6 users
 *     with SEED_USERS_JSON)
 *   - 4 shops (business A Etsy + Shopify, business B Etsy + Shopify) w/
 *     encrypted mock creds
 *   - 11 customers, 20 orders across all statuses (some overdue, some due soon),
 *     order_items with figure counts 1-3, and active assignments giving every
 *     designer work (d1=6, d2=4, d3=4).
 *
 * Password for every seeded user defaults to "alphaos123"; override with
 * SEED_PASSWORD.
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
import { applyLocalNeonProxy } from "../lib/db/local-proxy";

// Dev-only password shared by every seeded user (printed at the end).
// Overridable so a demo run (docs/DEMO.md) can use its own login password.
const DEV_PASSWORD = process.env.SEED_PASSWORD ?? "alphaos123";

// ---------------------------------------------------------------------------
// Overridable brand + user identity (docs/DEMO.md): a demo run seeds this
// fixture under fictional names instead of PixArt/Lumina. Everything else
// about the fixture (statuses, counts, designer capacities) stays identical
// so seed-history.ts and seed-qc.ts still line up.
// ---------------------------------------------------------------------------
function slugWord(slug: string): string {
  return slug.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
type Brand = {
  name: string;
  slug: string;
  gmailAddress: string;
  etsyShopName: string;
  etsyShopId: string;
  shopifyShopName: string;
  shopifyDomain: string;
};
function deriveBrand(name: string, slug: string, mailboxLocal: string, etsyShopId: string): Brand {
  return {
    name,
    slug,
    gmailAddress: `${mailboxLocal}@${slugWord(slug)}.com`,
    etsyShopName: `${name} Etsy`,
    etsyShopId,
    shopifyShopName: `${name} Shopify`,
    shopifyDomain: `${slug}.myshopify.com`,
  };
}
const BIZ_A = deriveBrand(
  process.env.SEED_BUSINESS_A_NAME ?? "PixArt",
  process.env.SEED_BUSINESS_A_SLUG ?? "pixart",
  "orders",
  "31415926",
);
const BIZ_B = deriveBrand(
  process.env.SEED_BUSINESS_B_NAME ?? "Lumina",
  process.env.SEED_BUSINESS_B_SLUG ?? "lumina",
  "hello",
  "27182818",
);

type SeedUserSpec = { email: string; name: string; role: "admin" | "va" | "designer" };
// Fixed order: admin, va1, va2, d1 (both businesses), d2 (PixArt/A only), d3 (Lumina/B only).
const DEFAULT_SEED_USERS: SeedUserSpec[] = [
  { email: "admin@aystudios.io", name: "Admin", role: "admin" },
  { email: "va1@aystudios.io", name: "Vic VA", role: "va" },
  { email: "va2@aystudios.io", name: "Val VA", role: "va" },
  { email: "d1@aystudios.io", name: "Dana Designer", role: "designer" },
  { email: "d2@aystudios.io", name: "Deb Designer", role: "designer" },
  { email: "d3@aystudios.io", name: "Dex Designer", role: "designer" },
];
function loadSeedUsers(): SeedUserSpec[] {
  if (!process.env.SEED_USERS_JSON) return DEFAULT_SEED_USERS;
  const parsed = JSON.parse(process.env.SEED_USERS_JSON) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 6) {
    throw new Error("SEED_USERS_JSON must be an array of exactly 6 users: [admin, va1, va2, d1, d2, d3]");
  }
  return parsed as SeedUserSpec[];
}
const SEED_USERS = loadSeedUsers();

config({ path: ".env.local" });
neonConfig.webSocketConstructor = ws;
applyLocalNeonProxy();

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
      shops, styles, businesses, "user"
    restart identity cascade
  `);

  // ---- businesses --------------------------------------------------------
  const pixart = randomUUID();
  const lumina = randomUUID();
  // Mock credentials (lib/mock): they look like the real thing (a Gmail
  // refresh token, a Gelato key, Luma basic auth) but carry the "mock_" marker
  // the transport answers from fixtures. Both mailboxes start "connected" at
  // history id 1000 so the first poll pulls the recent Etsy notifications.
  const gmailCreds = (address: string) =>
    encryptCredentials({
      clientId: "mock_" + randomUUID().slice(0, 8) + ".apps.googleusercontent.com",
      clientSecret: "GOCSPX-mock_" + randomUUID().slice(0, 12),
      refreshToken: "mock_rt_" + Buffer.from(address).toString("base64url"),
      accessToken: "mock_gat_" + Buffer.from(address).toString("base64url"),
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      address,
      status: "connected",
      connectedAt: new Date(Date.now() - 6 * 24 * HOUR).toISOString(),
    });
  const printCreds = () =>
    encryptCredentials({
      gelato: { apiKey: "mock_" + randomUUID().replace(/-/g, "") + "-gelato", webhookSecret: "mock_whsec_" + randomUUID().slice(0, 8) },
      lumaprints: { username: "mock_luma_" + randomUUID().slice(0, 6), password: "mock_" + randomUUID().slice(0, 10), storeId: "818", sandbox: true },
    });
  await db.insert(schema.businesses).values([
    {
      id: pixart,
      name: BIZ_A.name,
      slug: BIZ_A.slug,
      gmailCredentials: gmailCreds(BIZ_A.gmailAddress),
      gmailAddress: BIZ_A.gmailAddress,
      gmailHistoryId: "1000",
      emailSendingEnabled: true,
      stageEmailAutoSend: true,
      dailyHealthEmailEnabled: true,
      printCredentials: printCreds(),
    },
    {
      id: lumina,
      name: BIZ_B.name,
      slug: BIZ_B.slug,
      gmailCredentials: gmailCreds(BIZ_B.gmailAddress),
      gmailAddress: BIZ_B.gmailAddress,
      gmailHistoryId: "1000",
      emailSendingEnabled: true,
      stageEmailAutoSend: true,
      dailyHealthEmailEnabled: true,
      printCredentials: printCreds(),
    },
  ]);

  // ---- users -------------------------------------------------------------
  const admin = randomUUID();
  const va1 = randomUUID();
  const va2 = randomUUID();
  const d1 = randomUUID();
  const d2 = randomUUID();
  const d3 = randomUUID();
  const [uAdmin, uVa1, uVa2, uD1, uD2, uD3] = SEED_USERS;
  const passwordHash = await hashPassword(DEV_PASSWORD);
  await db.insert(schema.users).values([
    { id: admin, name: uAdmin.name, email: uAdmin.email, role: "admin", passwordHash },
    { id: va1, name: uVa1.name, email: uVa1.email, role: "va", passwordHash },
    { id: va2, name: uVa2.name, email: uVa2.email, role: "va", passwordHash },
    { id: d1, name: uD1.name, email: uD1.email, role: "designer", passwordHash },
    { id: d2, name: uD2.name, email: uD2.email, role: "designer", passwordHash },
    { id: d3, name: uD3.name, email: uD3.email, role: "designer", passwordHash },
  ]);

  // Portrait styles per business (Settings > Portrait Styles): what a
  // designer can be matched on, with the title/SKU matches the mock orders use.
  await db.insert(schema.styles).values(
    [pixart, lumina].flatMap((businessId) => [
      { businessId, name: "cartoon", titleMatches: ["Cartoon"], skuMatches: ["PET-CARTOON"], perFigureRate: "4.00", isDefault: true },
      { businessId, name: "watercolor", titleMatches: ["Watercolor"], skuMatches: ["PET-WATER"], perFigureRate: "4.50", isDefault: false },
      { businessId, name: "renaissance", titleMatches: ["Renaissance"], skuMatches: [], perFigureRate: "6.00", isDefault: false },
      { businessId, name: "line-art", titleMatches: ["Line Art"], skuMatches: [], perFigureRate: "3.00", isDefault: false },
    ]),
  );
  // The daily health briefing goes to the admin for both businesses.
  await db.update(schema.businesses).set({ dailyHealthEmailRecipientIds: [admin] });
  await db.insert(schema.designerProfiles).values([
    // Capacity sized for the mock shops (about 60 orders a day each on
    // Shopify): a demo day must not leave the board unassigned.
    { userId: d1, dailyCapacity: 40, perFigureRate: "4.00", styles: ["cartoon", "watercolor"] },
    { userId: d2, dailyCapacity: 40, perFigureRate: "3.50", styles: ["cartoon", "renaissance", "line-art"] },
    { userId: d3, dailyCapacity: 25, perFigureRate: "5.00", styles: ["watercolor", "cartoon"] },
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
  // Shop credentials carry the "mock_" marker (lib/mock/transport.ts): a
  // sync, a webhook check or a token refresh against them is answered by the
  // mock, a real key on the same deployment goes to the real API.
  const etsyCreds = (etsyShopId: string) =>
    encryptCredentials({
      keystring: "mock_" + randomUUID().replace(/-/g, "").slice(0, 24),
      sharedSecret: "mock_" + randomUUID().replace(/-/g, "").slice(0, 12),
      etsyShopId,
      etsyUserId: etsyShopId,
      accessToken: `${etsyShopId}.mock_at_seed`,
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshToken: "mock_rt_" + randomUUID().replace(/-/g, "").slice(0, 32),
      refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * HOUR).toISOString(),
      status: "connected",
    });
  const shopifyCreds = (shopDomain: string) =>
    encryptCredentials({
      authType: "legacy",
      shopDomain,
      accessToken: "shpat_mock_" + randomUUID().replace(/-/g, "").slice(0, 26),
      webhookSecret: "mock_shpss_" + randomUUID().replace(/-/g, "").slice(0, 20),
      status: "connected",
    });
  // Onboarded (a sync cursor exists, so cron picks the shop up) with the
  // resolution rules the mock orders are built to satisfy. The cursor sits
  // six hours back so the first tick imports a handful, then one per tick.
  const sixHoursAgo = new Date(Date.now() - 6 * HOUR);
  const shopifyConfig = {
    figureRules: [{ match: "Number of Figures", type: "integer" as const }],
    styleRules: [{ match: "Style", map: { cartoon: "cartoon", watercolor: "watercolor", renaissance: "renaissance", "line art": "line-art" } }],
    defaultStyle: "cartoon",
    nonPortraitTitles: ["Rush My Order"],
    photoRequestEnabled: false,
    syncCursor: sixHoursAgo.toISOString(),
    lastSyncAt: sixHoursAgo.toISOString(),
    backfillCutoffAt: new Date(Date.now() - 7 * 24 * HOUR).toISOString(),
  };
  const etsyConfig = {
    figureRules: [
      { match: "Number of Pets", type: "integer" as const },
      { match: "Number of People", type: "integer" as const },
    ],
    titleStyleRules: [
      { match: "Watercolor", style: "watercolor" },
      { match: "Cartoon", style: "cartoon" },
    ],
    defaultStyle: "cartoon",
    photoRequestEnabled: true,
    syncCursor: String(Math.floor(sixHoursAgo.getTime() / 1000)),
    lastSyncAt: sixHoursAgo.toISOString(),
    backfillCutoffAt: new Date(Date.now() - 7 * 24 * HOUR).toISOString(),
  };
  await db.insert(schema.shops).values([
    { id: s1, businessId: pixart, platform: "etsy", name: BIZ_A.etsyShopName, externalShopId: BIZ_A.etsyShopId, credentials: etsyCreds(BIZ_A.etsyShopId), integrationConfig: etsyConfig },
    { id: s2, businessId: pixart, platform: "shopify", name: BIZ_A.shopifyShopName, externalShopId: BIZ_A.shopifyDomain, credentials: shopifyCreds(BIZ_A.shopifyDomain), integrationConfig: shopifyConfig },
    { id: s3, businessId: lumina, platform: "etsy", name: BIZ_B.etsyShopName, externalShopId: BIZ_B.etsyShopId, credentials: etsyCreds(BIZ_B.etsyShopId), integrationConfig: etsyConfig },
    { id: s4, businessId: lumina, platform: "shopify", name: BIZ_B.shopifyShopName, externalShopId: BIZ_B.shopifyDomain, credentials: shopifyCreds(BIZ_B.shopifyDomain), integrationConfig: shopifyConfig },
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
    [uAdmin.email, "admin"],
    [uVa1.email, "va"],
    [uVa2.email, "va"],
    [uD1.email, "designer (both businesses)"],
    [uD2.email, `designer (${BIZ_A.name})`],
    [uD3.email, `designer (${BIZ_B.name})`],
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
