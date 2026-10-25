// Assignment guards (2026-10-25).
//   Bug 1: an order is routed by its PORTRAIT item, never an add-on line that
//          happens to come first (lib/orders/portrait-item.ts).
//   Bug 2: a manual / VA / agent reassign follows the same eligibility rules as
//          auto-assign (Disney only to Disney designers, a Disney-only designer
//          never takes a plain order, a styled order only to a designer who
//          draws it, the AI Studio only where the style has it switched on). An
//          admin or an owner's yes may override, a VA may not.
// Pure rules first, then the real paths against a throwaway business of its
// own ("Assign Guards <stamp>"), deleted again at the end. Never run against
// production.
import "./load-env";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { reassignOrder } from "../lib/agent/ai-designer";
import { ensureAgentDesigner } from "../lib/agent/ai-core";
import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import { assets, assignments, businesses, designerBusinesses, designerProfiles, orderItems, orders, shops, styles, users } from "../lib/db/schema";
import { drawsOnlyDisney, loadIsDisneyOrder, runAutoAssign } from "../lib/orders/assign";
import { isAddOnItem, pickPortraitItem } from "../lib/orders/portrait-item";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

function pureTests() {
  const item = (id: string, title: string, style: string | null = null, sku: string | null = null) => ({ id, title, sku, style });
  const addon = item("a", "Print & Ship My Order - ADD-ON LISTING", "Print & Ship My Order");
  const pet = item("b", "Custom Watercolor Pet Portrait", "Watercolor Pets");
  const people = item("c", "Custom Watercolor Couple Portrait", "Watercolor People");

  check("pick: nothing = null", pickPortraitItem([], null) === null);
  check("pick: a single item is itself", pickPortraitItem([pet], null)?.id === "b");
  check("pick: an add-on listed first is skipped", pickPortraitItem([addon, pet], null)?.id === "b");
  check("pick: an add-on listed last is skipped", pickPortraitItem([pet, addon], null)?.id === "b");
  check("pick: an add-on by title only (no style) is skipped", pickPortraitItem([item("a", "Rush Add-on", null), pet], null)?.id === "b");
  check("pick: all add-ons keeps them (nothing else to route by)", pickPortraitItem([addon, item("z", "Add-on two")], null)?.id === "a");
  check(
    "pick: a styled portrait beats an unstyled one",
    pickPortraitItem([item("a", "Mystery Portrait", null), item("b", "Custom Portrait", "Watercolor Pets")], null)?.id === "b",
  );
  check("pick: two portraits = lowest id, whatever the input order", pickPortraitItem([people, pet], null)?.id === "b" && pickPortraitItem([pet, people], null)?.id === "b");
  check(
    "pick: the shop's non-portrait SKU list counts as an add-on",
    pickPortraitItem([item("a", "Custom Portrait", "Watercolor Pets", "RUSH-1"), people], { nonPortraitSkus: ["RUSH-1"] } as never)?.id === "c",
  );
  check("addon: Print & Ship is one, a pet portrait is not", isAddOnItem(addon, null) && !isAddOnItem(pet, null));

  check("disney-only: Mar's styles", drawsOnlyDisney(["Disney Pet", "cartoon"]));
  check("disney-only: Wahyu draws People too, still Disney styles only", drawsOnlyDisney(["cartoon", "Disney Pet", "Disneyfy People"]));
  check("disney-only: one plain style is enough to draw plain orders", !drawsOnlyDisney(["Disney Pet", "Watercolor Pets"]));
  check("disney-only: no styles is not Disney-only", !drawsOnlyDisney([]) && !drawsOnlyDisney(null));
}

// ---------------------------------------------------------------------------
// The real paths against a throwaway business
// ---------------------------------------------------------------------------

const stamp = Date.now();
const ids = {
  biz: randomUUID(),
  shop: randomUUID(),
  pets: randomUUID(),
  people: randomUUID(),
  disney: randomUUID(),
  va: randomUUID(),
  admin: randomUUID(),
  agent: "",
};
const PET_TITLE = "Custom Watercolor Pet Portrait, Pet Memorial Art";
const PEOPLE_TITLE = "Custom Watercolor Couple Portrait";
const DISNEY_TITLE = "Custom Disney-Cartoon Pet Portrait";
const ADDON_TITLE = "Print & Ship My Order - ADD-ON LISTING";

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.biz, name: `Assign Guards ${stamp}`, slug: `assign-guards-${stamp}` });
    await tx.insert(users).values([
      { id: ids.pets, email: `guards-pets-${stamp}@example.test`, name: "Pet Painter", role: "designer" },
      { id: ids.people, email: `guards-people-${stamp}@example.test`, name: "People Painter", role: "designer" },
      { id: ids.disney, email: `guards-disney-${stamp}@example.test`, name: "Disney Only", role: "designer" },
      { id: ids.va, email: `guards-va-${stamp}@example.test`, name: "Guard VA", role: "va" },
      { id: ids.admin, email: `guards-admin-${stamp}@example.test`, name: "Guard Admin", role: "admin" },
    ]);
    await tx.insert(designerProfiles).values([
      { userId: ids.pets, dailyCapacity: 20, styles: ["Watercolor Pets"], rank: 5 },
      { userId: ids.people, dailyCapacity: 20, styles: ["Watercolor People"], rank: 5 },
      // Rank 1 and Disney only, like Mar: before the guard a plain order could be moved to them.
      { userId: ids.disney, dailyCapacity: 20, styles: ["Disney Pet", "cartoon"], rank: 1 },
    ]);
    await tx.insert(designerBusinesses).values([ids.pets, ids.people, ids.disney].map((userId) => ({ userId, businessId: ids.biz })));
    await tx.insert(styles).values([
      { businessId: ids.biz, name: "Watercolor Pets", titleMatches: ["Custom Watercolor Pet Portrait"] },
      { businessId: ids.biz, name: "Watercolor People", titleMatches: ["Watercolor Couple Portrait"] },
      { businessId: ids.biz, name: "Disney Pet", titleMatches: ["Disney-Cartoon Pet Portrait"] },
      // The AI Studio draws only this style here; Watercolor Pets is designer-only.
      { businessId: ids.biz, name: "Vintage Sketch", titleMatches: ["Vintage Sketch"], aiDesignerEnabled: true },
      { businessId: ids.biz, name: "Print & Ship My Order", titleMatches: ["Print & Ship My Order"] },
    ]);
    await tx.insert(shops).values({
      id: ids.shop,
      businessId: ids.biz,
      platform: "etsy",
      name: "Guards Etsy",
      externalShopId: `guards-${stamp}`,
      credentials: {},
    });
    ids.agent = await ensureAgentDesigner(tx, ids.biz);
  });
}

let orderNo = 0;
type ItemSpec = { title: string; style?: string | null };
async function mkOrder(o: { status: typeof orders.$inferInsert.status; items: ItemSpec[]; rawImport?: unknown; photo?: boolean }) {
  orderNo++;
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        platformOrderId: `guards-${stamp}-${orderNo}`,
        platformOrderName: `AG${orderNo}`,
        status: o.status,
        source: "manual",
        uploadToken: randomUUID(),
        rawImport: (o.rawImport ?? null) as never,
      })
      .returning({ id: orders.id });
    // Explicit, ascending ids so the FIRST item in the list is the lowest id:
    // that is the "add-on first" shape the old bare `limit 1` tripped on.
    const itemIds = o.items.map(() => randomUUID()).sort();
    for (const [n, it] of o.items.entries()) {
      await tx.insert(orderItems).values({
        id: itemIds[n],
        businessId: ids.biz,
        orderId: row.id,
        title: it.title,
        figureCount: 1,
        figureCountSource: "manual",
        style: it.style ?? null,
        productType: "digital",
      });
    }
    if (o.photo !== false) {
      await tx.insert(assets).values({
        businessId: ids.biz,
        orderId: row.id,
        type: "reference",
        storage: "cdn",
        url: `https://example.test/guards-${stamp}-${orderNo}.jpg`,
      });
    }
    return row.id;
  });
}

const holder = (orderId: string) =>
  withSystemContext(async (tx) => {
    const [a] = await tx
      .select({ designerId: assignments.designerId })
      .from(assignments)
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
    return a?.designerId ?? null;
  });

const reassign = (orderId: string, to: string, by: string | null, ownerApproved?: string) =>
  reassignOrder(orderId, to, by, ownerApproved ? { ownerApproved } : {});

const code = (r: Awaited<ReturnType<typeof reassignOrder>>) => (r.ok ? "ok" : r.code);

async function dbTests() {
  // ---- Bug 1: add-on first -------------------------------------------------
  // The add-on (style "Print & Ship My Order") has the lowest id and the pet
  // portrait comes second. The order must route by the portrait.
  const addonFirst = await mkOrder({
    status: "ready_to_assign",
    items: [{ title: ADDON_TITLE, style: "Print & Ship My Order" }, { title: PET_TITLE, style: "Watercolor Pets" }],
  });
  const r1 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: addonFirst, businessId: ids.biz, assignedBy: null }));
  check("bug1: add-on first, pet second routes to the pet painter", r1.assigned === ids.pets && (await holder(addonFirst)) === ids.pets, JSON.stringify(r1));

  // Same with no style on either line: the catalog gives the portrait's style, not the add-on's.
  const unstyled = await mkOrder({ status: "ready_to_assign", items: [{ title: ADDON_TITLE }, { title: PEOPLE_TITLE }] });
  const r2 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: unstyled, businessId: ids.biz, assignedBy: null }));
  check("bug1: unstyled add-on + people portrait routes to the people painter", r2.assigned === ids.people, JSON.stringify(r2));

  // Add-on only: still nobody (noStyle), as before.
  const addonOnly = await mkOrder({ status: "ready_to_assign", items: [{ title: ADDON_TITLE }] });
  const r3 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: addonOnly, businessId: ids.biz, assignedBy: null }));
  check("bug1: an add-on alone routes to nobody", r3.assigned === null && r3.noStyle === true, JSON.stringify(r3));

  // A Disney portrait behind an add-on still goes Disney-only.
  const disneyBehind = await mkOrder({
    status: "ready_to_assign",
    items: [{ title: ADDON_TITLE, style: "Print & Ship My Order" }, { title: DISNEY_TITLE, style: "Disney Pet" }],
  });
  const r4 = await withSystemContext((tx) => runAutoAssign(tx, { orderId: disneyBehind, businessId: ids.biz, assignedBy: null }));
  check("bug1: add-on first, Disney portrait second goes to the Disney designer", r4.assigned === ids.disney, JSON.stringify(r4));

  // ---- Bug 2: reassign follows the auto-assign rules ------------------------
  // Disney order: only a Disney designer (never overridable, even by an admin).
  const disney = await mkOrder({ status: "ready_to_assign", items: [{ title: DISNEY_TITLE, style: "Disney Pet" }] });
  check("bug2: Disney order refused to a plain designer", code(await reassign(disney, ids.pets, ids.va)) === "disney_only");
  check("bug2: Disney order refused to a plain designer even for an admin", code(await reassign(disney, ids.pets, ids.admin)) === "disney_only");
  check("bug2: Disney order allowed to the Disney designer", code(await reassign(disney, ids.disney, ids.va)) === "ok" && (await holder(disney)) === ids.disney);
  check("bug2: Disney order refused to the AI Studio", code(await reassign(disney, ids.agent, ids.va)) === "disney_only" || code(await reassign(disney, ids.agent, ids.va)) === "not_eligible");

  // The 4188930166 shape: no order_items rows at all, the Disney product only in the raw Etsy receipt.
  const legacy = await mkOrder({
    status: "ready_to_assign",
    items: [],
    rawImport: { receipt_id: 4188930166, transactions: [{ title: "Custom Disney-Cartoon Pet Portrait, Pixar Style" }] },
  });
  const isDisney = await withSystemContext((tx) => loadIsDisneyOrder(tx, legacy));
  check("bug2: an itemless order is Disney when its raw receipt says so", isDisney === true);
  check("bug2: itemless Disney order refused to a plain designer (the 4188930166 move)", code(await reassign(legacy, ids.pets, ids.va)) === "disney_only");
  check("bug2: itemless Disney order allowed to the Disney designer", code(await reassign(legacy, ids.disney, ids.va)) === "ok");

  const legacyPlain = await mkOrder({
    status: "ready_to_assign",
    items: [],
    rawImport: { receipt_id: 1, transactions: [{ title: "Custom Watercolor Pet Portrait" }] },
  });
  check("bug2: an itemless plain order is not Disney", (await withSystemContext((tx) => loadIsDisneyOrder(tx, legacyPlain))) === false);

  // A plain order never goes to a Disney-only designer (Mar), by a VA or by the agent.
  const plain = await mkOrder({ status: "ready_to_assign", items: [{ title: PET_TITLE, style: "Watercolor Pets" }] });
  const toMar = await reassign(plain, ids.disney, ids.va);
  check("bug2: VA cannot give a plain order to a Disney-only designer", code(toMar) === "not_eligible" && (await holder(plain)) === null, JSON.stringify(toMar));
  check("bug2: the agent path (no user) cannot either", code(await reassign(plain, ids.disney, null)) === "not_eligible");

  // A styled order only to a designer who draws that style.
  const toPeople = await reassign(plain, ids.people, ids.va);
  check("bug2: VA cannot give a Watercolor Pets order to a People painter", code(toPeople) === "not_eligible" && (await holder(plain)) === null, JSON.stringify(toPeople));
  check("bug2: the matching designer is allowed", code(await reassign(plain, ids.pets, ids.va)) === "ok" && (await holder(plain)) === ids.pets);

  // The AI Studio only where the style has it switched on.
  const toAgent = await reassign(plain, ids.agent, ids.va);
  check(
    "bug2: VA cannot give a designer-only style to the AI Studio",
    code(toAgent) === "not_eligible" && (await holder(plain)) === ids.pets,
    JSON.stringify(toAgent),
  );
  const sketch = await mkOrder({ status: "ready_to_assign", items: [{ title: "Vintage Sketch Portrait", style: "Vintage Sketch" }] });
  check("bug2: the AI Studio is allowed where the style has it on", code(await reassign(sketch, ids.agent, ids.va)) === "ok" && (await holder(sketch)) === ids.agent);

  // An unstyled order: the AI Studio is refused, a Disney-only designer is refused.
  const noStyle = await mkOrder({ status: "ready_to_assign", items: [{ title: "A listing nobody mapped" }] });
  check("bug2: unstyled order refused to the AI Studio", code(await reassign(noStyle, ids.agent, ids.va)) === "not_eligible");
  check("bug2: unstyled order refused to a Disney-only designer", code(await reassign(noStyle, ids.disney, ids.va)) === "not_eligible");

  // Overrides: an admin making the move, or an owner's yes (ownerApproved).
  const override = await mkOrder({ status: "ready_to_assign", items: [{ title: PET_TITLE, style: "Watercolor Pets" }] });
  check("bug2: an admin may override a style mismatch", code(await reassign(override, ids.people, ids.admin)) === "ok" && (await holder(override)) === ids.people);
  const override2 = await mkOrder({ status: "ready_to_assign", items: [{ title: PET_TITLE, style: "Watercolor Pets" }] });
  check(
    "bug2: an owner's yes (ownerApproved) may override a style mismatch",
    code(await reassign(override2, ids.people, ids.va, "Yousif in chat: give it to the people painter")) === "ok" && (await holder(override2)) === ids.people,
  );
  const override3 = await mkOrder({ status: "ready_to_assign", items: [{ title: PET_TITLE, style: "Watercolor Pets" }] });
  check("bug2: an admin may send a designer-only style to the AI Studio on purpose", code(await reassign(override3, ids.agent, ids.admin)) === "ok");
}

// The app login may not delete activity_log rows (append-only), so the
// clean-up uses the owner connection, as the other suites do.
async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    const members = (await ownerDb.select({ id: designerBusinesses.userId }).from(designerBusinesses).where(eq(designerBusinesses.businessId, ids.biz))).map((r) => r.id);
    const userIds = [...new Set([...members, ids.pets, ids.people, ids.disney, ids.va, ids.admin])];
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
      await tx.delete(designerProfiles).where(inArray(designerProfiles.userId, userIds));
      await tx.delete(users).where(inArray(users.id, userIds));
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
  console.log(failed ? `\n${failed} check(s) failed` : "\nall assignment guard checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
