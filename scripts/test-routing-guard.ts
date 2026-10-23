// Routing guard (2026-10-23): an order with no style never goes to whoever
// ranks first, and a missing buyer email never keeps an Etsy order off the
// boards. Pure rules first, then the real paths against a throwaway business
// of its own ("Routing Test <stamp>"), deleted again at the end. Never run
// against production.
import "./load-env";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { parseIntake } from "../lib/agent/intake";
import { routingStyleMatch, type BusinessStyle } from "../lib/designers/styles";
import { withSystemContext, SYSTEM_ACTOR_ID } from "../lib/db";
import * as schema from "../lib/db/schema";
import { assets, assignments, businesses, designerBusinesses, designerProfiles, orderItems, orders, shops, styles, users } from "../lib/db/schema";
import { completeOrderDetailsCore } from "../lib/orders/complete-details";
import { runAutoAssign } from "../lib/orders/assign";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

const style = (name: string, titleMatches: string[], o: Partial<BusinessStyle> = {}): BusinessStyle => ({
  id: randomUUID(),
  name,
  titleMatches,
  skuMatches: [],
  isDefault: false,
  perFigureRate: null,
  ...o,
});

function pureTests() {
  const catalog = [
    style("Watercolor Pets", ["Custom Watercolor Pet Portrait", "Custom Pet Portrait"]),
    style("Watercolor People", ["Watercolor Portrait", "Custom Hand-Drawn Watercolor Couple Portrait"]),
    style("Disney Pet", ["Custom Disney-Cartoon Pet Portrait"], { skuMatches: ["DPET-1"] }),
    style("Print & Ship My Order", ["Print & Ship My Order"]),
    style("Unmapped thing", ["Mystery Listing"], { autoCreated: true }),
    style("House", ["Home"], { isDefault: true }),
  ];
  const pet = "Custom Watercolor Pet Portrait, Pet Memorial Art, Personalized Cat Painting";
  check("route: a title rule gives the style", routingStyleMatch(pet, null, catalog) === "Watercolor Pets");
  check(
    "route: the longest rule wins over a shorter one",
    routingStyleMatch("Custom Hand-Drawn Watercolor Couple Portrait, Proposal", null, catalog) === "Watercolor People",
  );
  check("route: an exact SKU beats the title", routingStyleMatch(pet, "dpet-1", catalog) === "Disney Pet");
  check("route: never an add-on style", routingStyleMatch("Print & Ship My Order - ADD-ON LISTING", null, catalog) === null);
  check("route: never an auto-created style", routingStyleMatch("Mystery Listing for you", null, catalog) === null);
  check("route: never the default", routingStyleMatch("Something nobody mapped", null, catalog) === null);
  const tie = [style("A", ["Portrait"]), style("B", ["portrait"])];
  check("route: two styles tie = nobody guesses", routingStyleMatch("Pet Portrait", null, tie) === null);
  check("route: no title, no style", routingStyleMatch(null, null, catalog) === null);

  // Intake: every field known but the email = confident, the email waits for the filler.
  const rawImport = {
    receipt_id: 1,
    transactions: [
      {
        transaction_id: 1,
        title: pet,
        sku: null,
        quantity: 1,
        is_digital: true,
        listing_id: null,
        variations: [{ formatted_name: "Number of Pets", formatted_value: "2" }],
      },
    ],
  };
  const ctx = {
    rawImport,
    shopConfig: { figureRules: [{ match: "Number of Pets", type: "integer" as const }] },
    styleOptions: ["Watercolor Pets", "Watercolor People"],
    customerName: null,
    customerEmail: null,
    orderNotes: null,
    catalogStyle: "Watercolor Pets",
  };
  const noEmail = parseIntake(ctx);
  check(
    "intake: no email is not a blocker",
    noEmail.confident && noEmail.values.customerEmail === "" && noEmail.values.style === "Watercolor Pets" && noEmail.values.figureCount === 2,
    JSON.stringify(noEmail),
  );
  const bad = parseIntake({ ...ctx, customerEmail: "sara@" });
  check("intake: a malformed email still holds it", !bad.confident && bad.missing.some((m) => m.startsWith("customer email")), JSON.stringify(bad));
  const good = parseIntake({ ...ctx, customerEmail: "Sara@Example.test" });
  check("intake: a real email rides along", good.confident && good.values.customerEmail === "sara@example.test");
}

// ---------------------------------------------------------------------------
// The real paths against a throwaway business
// ---------------------------------------------------------------------------

const stamp = Date.now();
const ids = { biz: randomUUID(), shop: randomUUID(), first: randomUUID(), pets: randomUUID(), people: randomUUID() };
const PET_TITLE = "Custom Watercolor Pet Portrait, Pet Memorial Art";

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.biz, name: `Routing Test ${stamp}`, slug: `routing-test-${stamp}` });
    await tx.insert(users).values([
      { id: ids.first, email: `routingtest-first-${stamp}@example.test`, name: "First In Line", role: "designer" },
      { id: ids.pets, email: `routingtest-pets-${stamp}@example.test`, name: "Pet Painter", role: "designer" },
      { id: ids.people, email: `routingtest-people-${stamp}@example.test`, name: "People Painter", role: "designer" },
    ]);
    // "First In Line" ranks first and draws cartoon only: before the guard an
    // unstyled order went to them whatever it was.
    await tx.insert(designerProfiles).values([
      { userId: ids.first, dailyCapacity: 20, styles: ["Cartoon"], rank: 1 },
      { userId: ids.pets, dailyCapacity: 20, styles: ["Watercolor Pets"], rank: 5 },
      { userId: ids.people, dailyCapacity: 20, styles: ["Watercolor People"], rank: 5 },
    ]);
    await tx.insert(designerBusinesses).values([ids.first, ids.pets, ids.people].map((userId) => ({ userId, businessId: ids.biz })));
    await tx.insert(styles).values([
      { businessId: ids.biz, name: "Cartoon", titleMatches: ["Cartoon Portrait"] },
      { businessId: ids.biz, name: "Watercolor Pets", titleMatches: ["Custom Watercolor Pet Portrait"] },
      { businessId: ids.biz, name: "Watercolor People", titleMatches: ["Watercolor Couple Portrait"] },
      { businessId: ids.biz, name: "Print & Ship My Order", titleMatches: ["Print & Ship My Order"] },
    ]);
    await tx.insert(shops).values({
      id: ids.shop,
      businessId: ids.biz,
      platform: "etsy",
      name: "Routing Etsy",
      externalShopId: `routing-${stamp}`,
      credentials: {},
    });
  });
}

let orderNo = 0;
async function mkOrder(o: { status: typeof orders.$inferInsert.status; title: string; style?: string | null; photo?: boolean }) {
  orderNo++;
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        platformOrderId: `routingtest-${stamp}-${orderNo}`,
        platformOrderName: `RT${orderNo}`,
        status: o.status,
        source: "manual",
        uploadToken: randomUUID(),
      })
      .returning({ id: orders.id });
    await tx.insert(orderItems).values({
      businessId: ids.biz,
      orderId: row.id,
      title: o.title,
      figureCount: 1,
      figureCountSource: "manual",
      style: o.style ?? null,
      productType: "digital",
    });
    if (o.photo !== false) {
      await tx.insert(assets).values({
        businessId: ids.biz,
        orderId: row.id,
        type: "reference",
        storage: "cdn",
        url: `https://example.test/routingtest-${stamp}-${orderNo}.jpg`,
      });
    }
    return row.id;
  });
}

const itemOf = (orderId: string) =>
  withSystemContext(async (tx) => {
    const [i] = await tx.select({ style: orderItems.style, locked: orderItems.styleLocked }).from(orderItems).where(eq(orderItems.orderId, orderId));
    const [a] = await tx
      .select({ designerId: assignments.designerId })
      .from(assignments)
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    return { style: i?.style ?? null, locked: !!i?.locked, designerId: a?.designerId ?? null, status: o?.status ?? null };
  });

async function dbTests() {
  // An unstyled pet order: the catalog gives its style and its designer, never first in line.
  const pet = await mkOrder({ status: "ready_to_assign", title: PET_TITLE });
  const r1 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: pet, businessId: ids.biz, assignedBy: null }));
  const s1 = await itemOf(pet);
  check("assign: an unstyled order goes to its style's designer", r1.assigned === ids.pets && s1.designerId === ids.pets, JSON.stringify(r1));
  check("assign: the routed style is saved, unlocked", s1.style === "Watercolor Pets" && !s1.locked, JSON.stringify(s1));

  // Nothing in the catalog matches: nobody is picked.
  const odd = await mkOrder({ status: "ready_to_assign", title: "A listing nobody mapped" });
  const r2 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: odd, businessId: ids.biz, assignedBy: null }));
  const s2 = await itemOf(odd);
  check("assign: no style anywhere = nobody, flagged noStyle", r2.assigned === null && r2.noStyle === true && s2.designerId === null, JSON.stringify(r2));

  // An add-on title never routes by its add-on style.
  const addon = await mkOrder({ status: "ready_to_assign", title: "Print & Ship My Order - ADD-ON LISTING" });
  const r3 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: addon, businessId: ids.biz, assignedBy: null }));
  check("assign: an add-on is never drawn by first in line", r3.assigned === null && r3.noStyle === true, JSON.stringify(r3));

  // A style someone set is left alone.
  const set = await mkOrder({ status: "ready_to_assign", title: PET_TITLE, style: "Cartoon" });
  const r4 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: set, businessId: ids.biz, assignedBy: null }));
  check("assign: a set style still routes by itself", r4.assigned === ids.first && (await itemOf(set)).style === "Cartoon", JSON.stringify(r4));

  // Completing details with no style (the agent's intake often sends none):
  // the catalog style is saved and the order lands with that style's designer.
  const couple = await mkOrder({ status: "awaiting_details", title: "Custom Hand-Drawn Watercolor Couple Portrait" });
  const res = await completeOrderDetailsCore(
    { id: SYSTEM_ACTOR_ID, role: "system" },
    { orderId: couple, figureCount: 2, productTitle: "Custom Hand-Drawn Watercolor Couple Portrait", productType: "digital", customerEmail: "" },
    (fn) => withSystemContext(fn),
    { expectedStatus: "awaiting_details" },
  );
  const s5 = await itemOf(couple);
  check("complete: no style given = the catalog's, unlocked", res.ok && s5.style === "Watercolor People" && !s5.locked, JSON.stringify({ res, s5 }));
  check("complete: no email, still on a board", s5.status === "ready_to_assign" && s5.designerId === ids.people, JSON.stringify(s5));

  // A style already on the item survives a save that sends none.
  const kept = await mkOrder({ status: "awaiting_details", title: "Odd title", style: "Watercolor Pets" });
  const res2 = await completeOrderDetailsCore(
    { id: SYSTEM_ACTOR_ID, role: "system" },
    { orderId: kept, figureCount: 1, productTitle: "Odd title", productType: "digital" },
    (fn) => withSystemContext(fn),
    { expectedStatus: "awaiting_details" },
  );
  check("complete: an item's own style is kept", res2.ok && (await itemOf(kept)).style === "Watercolor Pets");
}

// The app login may not delete activity_log rows (append-only), so the
// clean-up uses the owner connection, as the other suites do.
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
      await tx.delete(designerProfiles).where(sql`${designerProfiles.userId} in (${ids.first}, ${ids.pets}, ${ids.people})`);
      await tx.delete(users).where(sql`${users.id} in (${ids.first}, ${ids.pets}, ${ids.people})`);
      await tx.delete(businesses).where(eq(businesses.id, ids.biz));
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  pureTests();
  await setup();
  try {
    await dbTests();
  } finally {
    await cleanup();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall routing guard checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
