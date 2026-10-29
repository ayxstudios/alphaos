// Multi-portrait, multi-style orders (owner 2026-10-29: "customers give
// multiple portraits in different styles they should get all the portraits
// at the same time ... even if there is multiple designers in the mix").
// One receipt = one order = ONE designer, so:
//   1. add-on lines (Fast Track, Print & Ship, rush) are never a portrait;
//   2. each portrait line keeps its own style when the order's style is set;
//   3. the designer picked draws EVERY style on the order; nobody like that =
//      unassigned, and the card says why;
//   4. the brief and the board list every portrait.
// Pure rules first, then the real paths against a throwaway business of its
// own ("Multi Style <stamp>"), deleted again at the end. Never run against
// production.
import "./load-env";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { reassignOrder } from "../lib/agent/ai-designer";
import { whyNoDesigner } from "../lib/agent/autopilot";
import { noDesignerRecommendation } from "../lib/agent/limbo";
import { SYSTEM_ACTOR_ID, withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import { assets, assignments, businesses, designerBusinesses, designerProfiles, orderItems, orders, shops, styles, users } from "../lib/db/schema";
import { isAddOnItem, isAddOnTitle } from "../lib/orders/add-ons";
import { combineQuotas, rankCandidates, runAutoAssign, type Candidate } from "../lib/orders/assign";
import { completeOrderDetailsCore } from "../lib/orders/complete-details";
import { applyOrderStyle, planItemStyles, type StyleItem } from "../lib/orders/item-styles";
import { multiStyleGap } from "../lib/orders/order-styles";
import { pickPortraitItem, portraitStylesFrom, portraitStylesOf } from "../lib/orders/portrait-item";
import { buildPortraitSlots } from "../lib/orders/portraits";
import { loadOrderBrief, portraitBriefLines } from "../lib/notifications/designer-events";
import type { BusinessStyle } from "../lib/designers/styles";
import type { BoardCard } from "../lib/orders/board-data";
import { cardLabels, portraitLine } from "../components/board/card-meta";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const WP = "Watercolor People";
const DP = "Disney Pet";
const PETS = "Watercolor Pets";

// Real CPS / PixArt shaped titles.
const PEOPLE_TITLE = "Custom Watercolor Family Portrait from Photo, Personalized Couple Gift";
const DISNEY_TITLE = "Custom Disney Pet Portrait, Cartoon Pet Drawing from Photo";
const PETS_TITLE = "Custom Watercolor Pet Portrait, Pet Memorial Art";
const PLAIN_TITLE = "Custom Portrait from Your Photo, Digital Download";
const FAST_TRACK = "Fast Track My Order";
const PRINT_SHIP = "Print & Ship My Order - ADD-ON LISTING";

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

function pureTests() {
  // 1. Add-on recognizer: one definition, Fast Track caught, portraits not.
  for (const t of [
    FAST_TRACK,
    "FAST TRACK MY ORDER",
    "Fast-Track My Order",
    "Fast Track",
    PRINT_SHIP,
    "Rush My Order",
    "Rush Order Upgrade",
    "Priority Processing",
    "Expedited Processing",
    "Skip The Line - Priority Order",
    "Extra Pet - ADD-ON LISTING",
    "Add-on: Additional Person",
    "Upgrade to a Framed Canvas",
  ]) {
    check(`add-on: "${t}" is an add-on`, isAddOnTitle(t));
  }
  for (const t of [
    PEOPLE_TITLE,
    DISNEY_TITLE,
    PETS_TITLE,
    PLAIN_TITLE,
    "Custom Pet Portrait from Photo, Digital Watercolor, Fast Delivery",
    "Custom Disney Pet Portrait | Fast Track Available | Digital File",
    "Family Portrait Illustration - Rush Order Available - Gift for Mom",
    "Watercolor People Portrait, Priority Processing Included, Custom Couple Gift",
    "Pixar Style Family Portrait - Quick Turnaround, Fast Shipping",
    "Custom House Portrait, Watercolor Home Painting, Fast Track Delivery Option",
  ]) {
    check(`add-on: "${t}" is a portrait`, !isAddOnTitle(t));
  }
  check("add-on: Fast Track as an order item", isAddOnItem({ title: FAST_TRACK, sku: null, style: null }, null));
  check("add-on: the shop's own list still counts", isAddOnItem({ title: "Gift Wrap", sku: "GW-1" }, { nonPortraitSkus: ["gw-1"] }));

  const slotItem = (id: string, title: string, quantity = 1) => ({ id, title, variation: null, sku: null, quantity });
  const slots = buildPortraitSlots([slotItem("a", FAST_TRACK), slotItem("b", PEOPLE_TITLE), slotItem("c", DISNEY_TITLE)], null);
  check("slots: Fast Track is no portrait slot", slots.length === 2 && slots.every((s) => s.itemId !== "a"), JSON.stringify(slots.map((s) => s.itemId)));
  check("slots: a lone Fast Track line still is one (a lone line is always a portrait)", buildPortraitSlots([slotItem("a", FAST_TRACK)], null).length === 1);
  const pick = (id: string, title: string, style: string | null = null) => ({ id, title, sku: null, style });
  check("pick: Fast Track listed first is skipped", pickPortraitItem([pick("a", FAST_TRACK), pick("b", PEOPLE_TITLE)], null)?.id === "b");

  // 2. Every portrait style, primary first, add-ons out.
  check(
    "styles: two portraits + Fast Track = both styles",
    JSON.stringify(portraitStylesFrom([pick("a", FAST_TRACK), pick("b", PEOPLE_TITLE, WP), pick("c", DISNEY_TITLE, DP)], null)) === JSON.stringify([WP, DP]),
  );
  check(
    "styles: same style twice (any case) counts once",
    JSON.stringify(portraitStylesFrom([pick("a", PEOPLE_TITLE, WP), pick("b", PEOPLE_TITLE, "watercolor people ")], null)) === JSON.stringify([WP]),
  );
  check(
    "styles: the styled portrait leads (primary), the unstyled one adds nothing",
    JSON.stringify(portraitStylesFrom([pick("a", PLAIN_TITLE), pick("b", DISNEY_TITLE, DP)], null)) === JSON.stringify([DP]),
  );
  check("styles: one item, one style (as before)", JSON.stringify(portraitStylesFrom([pick("a", PEOPLE_TITLE, WP)], null)) === JSON.stringify([WP]));

  // 3. Per-item style plan.
  const catalog: BusinessStyle[] = [
    { id: "s1", name: WP, titleMatches: ["Watercolor Family Portrait"], skuMatches: [], isDefault: false, perFigureRate: null },
    { id: "s2", name: DP, titleMatches: ["Disney Pet Portrait"], skuMatches: [], isDefault: false, perFigureRate: null },
    { id: "s3", name: PETS, titleMatches: ["Watercolor Pet Portrait"], skuMatches: [], isDefault: false, perFigureRate: null },
  ];
  const si = (id: string, title: string, style: string | null = null, styleLocked = false): StyleItem => ({ id, title, sku: null, style, styleLocked });
  const plan = (items: StyleItem[], chosen: string | null, chosenLocked = true) =>
    Object.fromEntries(planItemStyles({ items, chosen, chosenLocked, catalog, cfg: null }).map((w) => [w.id, `${w.style}${w.styleLocked ? "!" : ""}`]));

  const p1 = plan([si("a", PEOPLE_TITLE), si("b", DISNEY_TITLE), si("c", FAST_TRACK)], WP);
  check("plan: each portrait gets its own catalog style, the add-on none", JSON.stringify(p1) === JSON.stringify({ a: WP, b: DP }), JSON.stringify(p1));
  const p2 = plan([si("a", PEOPLE_TITLE), si("b", PLAIN_TITLE)], DP);
  check("plan: a portrait that matches nothing takes the chosen style (locked: a person chose it)", JSON.stringify(p2) === JSON.stringify({ a: WP, b: `${DP}!` }), JSON.stringify(p2));
  const p3 = plan([si("a", PEOPLE_TITLE, PETS, true), si("b", DISNEY_TITLE)], WP);
  check("plan: a style a person set stays", JSON.stringify(p3) === JSON.stringify({ b: DP }), JSON.stringify(p3));
  const p4 = plan([si("a", PEOPLE_TITLE, PETS, true), si("b", FAST_TRACK)], DP);
  check("plan: ONE portrait (+ add-on) takes the chosen style, as before", JSON.stringify(p4) === JSON.stringify({ a: `${DP}!` }), JSON.stringify(p4));
  const p5 = plan([si("a", PEOPLE_TITLE)], DP, false);
  check("plan: a one-item order takes the chosen style, unlocked when a rule chose it", JSON.stringify(p5) === JSON.stringify({ a: DP }), JSON.stringify(p5));
  const p6 = planItemStyles({ items: [si("a", PEOPLE_TITLE), si("b", DISNEY_TITLE)], chosen: WP, chosenLocked: true, catalog, cfg: null, allowed: (s) => s !== DP });
  check("plan: a catalog style the shop does not offer is not used", JSON.stringify(p6.map((w) => w.style)) === JSON.stringify([WP, WP]));

  // 4. Ranking with two styles.
  const cand = (designerId: string, own: string[], rank = 5, quota: Candidate["styleQuota"] = null): Candidate => ({
    designerId,
    styles: own,
    rank,
    dailyCapacity: 20,
    ordersAssignedToday: 0,
    wipCount: 0,
    onTimeRate30d: 1,
    maxActiveOrders: 0,
    styleQuota: quota,
  });
  const roster = [cand("people", [WP], 1), cand("disney", [DP, "cartoon"], 1), cand("duo", [WP, DP], 5), cand("pets", [PETS], 1)];
  const both = rankCandidates(roster, { styles: [WP, DP], disney: true });
  check("rank: two styles -> only the designer who draws both", both.length === 1 && both[0].designerId === "duo", JSON.stringify(both.map((c) => c.designerId)));
  check("rank: two styles nobody covers -> nobody", rankCandidates(roster, { styles: [WP, PETS] }).length === 0);
  const one = rankCandidates(roster, { style: WP });
  check("rank: one style unchanged (rank 1 people first, duo still eligible)", one[0]?.designerId === "people" && one.some((c) => c.designerId === "duo"));
  check(
    "rank: styles [WP] = style WP",
    JSON.stringify(rankCandidates(roster, { styles: [WP] }).map((c) => c.designerId)) === JSON.stringify(one.map((c) => c.designerId)),
  );
  check("rank: no style still open to everyone", rankCandidates(roster, { styles: [] }).length === roster.length);

  // Quotas: an order in two styles must fit in each style's group.
  const q = (limit: number, usedToday: number, priority = 1, overflow = false) => ({ limit, usedToday, priority, overflow });
  check("quota: one group = itself", JSON.stringify(combineQuotas([q(3, 1)])) === JSON.stringify(q(3, 1)));
  check("quota: none = null", combineQuotas([]) === null);
  check("quota: any group full = out", combineQuotas([q(3, 1, 1), q(1, 1, 2)])?.limit === 1);
  check("quota: full but overflow = unquota'd", combineQuotas([q(3, 1, 1), q(1, 1, 2, true)])?.overflow === true);
  check("quota: all open = best priority", combineQuotas([q(3, 1, 4), q(5, 0, 2)])?.priority === 2);
  const quotaFull = rankCandidates([cand("duo", [WP, DP], 1, q(1, 1)), cand("duo2", [WP, DP], 9)], { styles: [WP, DP] });
  check("quota: the full one is skipped, the next who draws both gets it", quotaFull.length === 1 && quotaFull[0].designerId === "duo2");

  // 5. The reason an owner reads.
  check(
    "reason: two styles, nobody does both",
    multiStyleGap([WP, DP], [[WP], [DP]]) === "two styles on one order (Watercolor People + Disney Pet): no designer does both",
    String(multiStyleGap([WP, DP], [[WP], [DP]])),
  );
  check("reason: someone does both = no gap", multiStyleGap([WP, DP], [[WP], [WP, DP]]) === null);
  check("reason: one style = no gap", multiStyleGap([WP], [[DP]]) === null);

  // 6. Brief lines.
  const bp = (n: number[], style: string | null, figureCount: number | null, title: string, options: { name: string; value: string }[] = []) => ({ slots: n, style, figureCount, title, options });
  const brief = portraitBriefLines([bp([1], WP, 2, PEOPLE_TITLE, [{ name: "Size", value: "8x10" }]), bp([2, 3], DP, 1, DISNEY_TITLE)]);
  check("brief: says how many portraits and that they go together", /3 portraits, all for you/.test(brief[0] ?? ""), brief[0]);
  check("brief: portrait 1 with its style, figures, product and options", brief[1] === `Portrait 1: ${WP}, 2 figures, ${PEOPLE_TITLE}. Options: Size: 8x10.`, brief[1]);
  check("brief: a line bought twice reads as two portraits", brief[2] === `Portraits 2 and 3: ${DP}, 1 figure, ${DISNEY_TITLE}.`, brief[2]);
  check("brief: one portrait = no extra lines (reads as before)", portraitBriefLines([bp([1], WP, 2, PEOPLE_TITLE)]).length === 0);

  // 7. Board card: one line per portrait, one pill per style.
  check("board: a portrait line", portraitLine(bp([1], WP, 2, PEOPLE_TITLE)) === `Portrait 1 · ${WP} · 2 figures · ${PEOPLE_TITLE}`, portraitLine(bp([1], WP, 2, PEOPLE_TITLE)));
  check("board: a line bought twice", portraitLine(bp([2, 3], null, null, DISNEY_TITLE)) === `Portraits 2 and 3 · style not set · figures not set · ${DISNEY_TITLE}`);
  const card = (style: string | null, styles: string[]) =>
    ({ urgent: false, sameBuyerNumbers: [], source: "etsy", customerRevision: null, qcFail: null, style, styles, figuresResolved: true }) as unknown as BoardCard;
  const pills = (c: BoardCard) => cardLabels(c).filter((l) => l.tone === "sage").map((l) => l.text);
  check("board: two styles = two style pills", pills(card(WP, [WP, DP])).length === 2, JSON.stringify(pills(card(WP, [WP, DP]))));
  check("board: one style = one pill, as before", pills(card(WP, [WP])).length === 1);
}

// ---------------------------------------------------------------------------
// The real paths against a throwaway business
// ---------------------------------------------------------------------------

const stamp = Date.now();
const ids = {
  biz: randomUUID(),
  shop: randomUUID(),
  people: randomUUID(),
  disney: randomUUID(),
  duo: randomUUID(),
  pets: randomUUID(),
  va: randomUUID(),
};

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.biz, name: `Multi Style ${stamp}`, slug: `multi-style-${stamp}` });
    await tx.insert(users).values([
      { id: ids.people, email: `ms-people-${stamp}@example.test`, name: "People Painter", role: "designer" },
      { id: ids.disney, email: `ms-disney-${stamp}@example.test`, name: "Disney Painter", role: "designer" },
      { id: ids.duo, email: `ms-duo-${stamp}@example.test`, name: "Duo Painter", role: "designer" },
      { id: ids.pets, email: `ms-pets-${stamp}@example.test`, name: "Pet Painter", role: "designer" },
      { id: ids.va, email: `ms-va-${stamp}@example.test`, name: "Style VA", role: "va" },
    ]);
    await tx.insert(designerProfiles).values([
      { userId: ids.people, dailyCapacity: 20, styles: [WP], rank: 1 },
      { userId: ids.disney, dailyCapacity: 20, styles: [DP, "cartoon"], rank: 1 },
      // Rank 5: never first for a one-style order, the only one for People + Disney.
      { userId: ids.duo, dailyCapacity: 20, styles: [WP, DP], rank: 5 },
      { userId: ids.pets, dailyCapacity: 20, styles: [PETS], rank: 1 },
    ]);
    await tx.insert(designerBusinesses).values([ids.people, ids.disney, ids.duo, ids.pets].map((userId) => ({ userId, businessId: ids.biz })));
    await tx.insert(styles).values([
      { businessId: ids.biz, name: WP, titleMatches: ["Watercolor Family Portrait"] },
      { businessId: ids.biz, name: DP, titleMatches: ["Disney Pet Portrait"] },
      { businessId: ids.biz, name: PETS, titleMatches: ["Watercolor Pet Portrait"] },
    ]);
    await tx.insert(shops).values({
      id: ids.shop,
      businessId: ids.biz,
      platform: "etsy",
      name: "Multi Style Etsy",
      externalShopId: `multi-style-${stamp}`,
      credentials: {},
    });
  });
}

let orderNo = 0;
type ItemSpec = { title: string; style?: string | null; styleLocked?: boolean; figures?: number | null; quantity?: number };
async function mkOrder(o: { status: typeof orders.$inferInsert.status; items: ItemSpec[] }) {
  orderNo++;
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        platformOrderId: `ms-${stamp}-${orderNo}`,
        platformOrderName: `MS${orderNo}`,
        status: o.status,
        source: "manual",
        uploadToken: randomUUID(),
      })
      .returning({ id: orders.id });
    // Ascending ids so the list order is the item order.
    const itemIds = o.items.map(() => randomUUID()).sort();
    for (const [n, it] of o.items.entries()) {
      await tx.insert(orderItems).values({
        id: itemIds[n],
        businessId: ids.biz,
        orderId: row.id,
        title: it.title,
        figureCount: it.figures === undefined ? 1 : it.figures,
        figureCountSource: "manual",
        style: it.style ?? null,
        styleLocked: it.styleLocked ?? false,
        quantity: it.quantity ?? 1,
        productType: "digital",
      });
    }
    await tx.insert(assets).values({
      businessId: ids.biz,
      orderId: row.id,
      type: "reference",
      storage: "cdn",
      url: `https://example.test/ms-${stamp}-${orderNo}.jpg`,
    });
    return { id: row.id, itemIds };
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

const itemStyles = (orderId: string) =>
  withSystemContext(async (tx) =>
    (
      await tx
        .select({ id: orderItems.id, style: orderItems.style, styleLocked: orderItems.styleLocked })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
    ).sort((a, b) => (a.id < b.id ? -1 : 1)),
  );

async function dbTests() {
  // ---- Etsy shape: no item styles, completed with ONE chosen style ----------
  // Watercolor People + Disney Pet + Fast Track on one receipt. Completing it
  // with "Watercolor People" keeps the Disney portrait Disney (its catalog
  // style), leaves Fast Track styleless, and the order goes to the one
  // designer who draws both.
  const etsy = await mkOrder({
    status: "awaiting_details",
    items: [{ title: FAST_TRACK, figures: null }, { title: PEOPLE_TITLE }, { title: DISNEY_TITLE }],
  });
  const done = await completeOrderDetailsCore(
    { id: SYSTEM_ACTOR_ID, role: "system" },
    { orderId: etsy.id, figureCount: 2, style: WP, styleLocked: false, productTitle: PEOPLE_TITLE, productType: "digital" },
    (fn) => withSystemContext(fn),
    { expectedStatus: "awaiting_details" },
  );
  check("complete: the order completes", done.ok && done.toStatus === "ready_to_assign", JSON.stringify(done));
  const after = await itemStyles(etsy.id);
  check(
    "complete: Fast Track no style, people portrait Watercolor People, Disney portrait Disney Pet",
    after[0].style === null && after[1].style === WP && after[2].style === DP,
    JSON.stringify(after),
  );
  check(
    "complete: both portrait styles route the order",
    JSON.stringify(await withSystemContext((tx) => portraitStylesOf(tx, etsy.id))) === JSON.stringify([WP, DP]),
  );
  check("assign: two styles -> the designer who draws both (rank 5 beats rank 1 who draws one)", (await holder(etsy.id)) === ids.duo, String(await holder(etsy.id)));

  const brief = await withSystemContext((tx) => loadOrderBrief(tx, etsy.id));
  const lines = portraitBriefLines(brief?.portraits ?? []);
  check("brief: both portraits listed, Fast Track not", brief?.portraits.length === 2 && lines.length === 3, JSON.stringify(lines));
  check("brief: portrait 1 Watercolor People, portrait 2 Disney Pet", /^Portrait 1: Watercolor People, 2 figures/.test(lines[1] ?? "") && /^Portrait 2: Disney Pet, 1 figure/.test(lines[2] ?? ""), JSON.stringify(lines));
  check("brief: total figures leave the add-on out", brief?.figureCount === 3, String(brief?.figureCount));
  check("brief: both styles on the brief", JSON.stringify(brief?.styles) === JSON.stringify([WP, DP]), JSON.stringify(brief?.styles));

  // ---- Two styles nobody draws together ---------------------------------------
  const gap = await mkOrder({ status: "ready_to_assign", items: [{ title: PEOPLE_TITLE, style: WP }, { title: PETS_TITLE, style: PETS }] });
  const r = await withSystemContext((tx) => runAutoAssign(tx, { orderId: gap.id, businessId: ids.biz, assignedBy: null }));
  check("assign: Watercolor People + Watercolor Pets, nobody draws both -> unassigned", r.assigned === null && (await holder(gap.id)) === null, JSON.stringify(r));
  const why = await withSystemContext((tx) => whyNoDesigner(tx, ids.biz, gap.id));
  check(
    "reason: the card says two styles, no designer does both",
    why.headline === "two styles on one order (Watercolor People + Watercolor Pets): no designer does both",
    why.headline,
  );
  const peopleRow = why.roster.find((d) => d.designerId === ids.people);
  check("reason: each designer's missing style is named", !!peopleRow?.blockers.includes(`does not do ${PETS}`), JSON.stringify(peopleRow));
  const advice = await withSystemContext((tx) => noDesignerRecommendation(tx, ids.biz, why.styles, null));
  check(
    "reason: what to do names who draws each style",
    /Nobody draws both Watercolor People and Watercolor Pets/.test(advice) && /Watercolor Pets: Pet Painter/.test(advice),
    advice,
  );

  // A person picking by hand gets the same rule.
  const toPeople = await reassignOrder(gap.id, ids.people, ids.va, {});
  check(
    "reassign: a VA cannot give it to someone who draws one of the two",
    !toPeople.ok && toPeople.code === "not_eligible" && /does not draw Watercolor Pets/.test(toPeople.message),
    JSON.stringify(toPeople),
  );

  // ---- One style: unchanged -----------------------------------------------------
  const single = await mkOrder({ status: "ready_to_assign", items: [{ title: PEOPLE_TITLE, style: WP }] });
  await withSystemContext((tx) => runAutoAssign(tx, { orderId: single.id, businessId: ids.biz, assignedBy: null }));
  check("assign: one style -> rank 1 people painter, as before", (await holder(single.id)) === ids.people);
  const singleBrief = await withSystemContext((tx) => loadOrderBrief(tx, single.id));
  check("brief: one portrait = no per-portrait lines", portraitBriefLines(singleBrief?.portraits ?? []).length === 0 && singleBrief?.style === WP);

  // Same style on two lines is one style: the rank 1 people painter.
  const twoSame = await mkOrder({ status: "ready_to_assign", items: [{ title: PEOPLE_TITLE, style: WP }, { title: PEOPLE_TITLE, style: WP }] });
  await withSystemContext((tx) => runAutoAssign(tx, { orderId: twoSame.id, businessId: ids.biz, assignedBy: null }));
  check("assign: two portraits in one style -> rank 1 people painter", (await holder(twoSame.id)) === ids.people);

  // ---- applyOrderStyle (setOrderStyleOnce without a line) ----------------------
  const set = await mkOrder({
    status: "ready_to_assign",
    items: [{ title: PEOPLE_TITLE }, { title: PLAIN_TITLE }, { title: PRINT_SHIP }, { title: DISNEY_TITLE, style: PETS, styleLocked: true }],
  });
  await withSystemContext((tx) => applyOrderStyle(tx, { orderId: set.id, businessId: ids.biz, chosen: DP, chosenLocked: true }));
  const s = await itemStyles(set.id);
  check("set: catalog line keeps its own style (unlocked)", s[0].style === WP && !s[0].styleLocked, JSON.stringify(s[0]));
  check("set: a line that matches nothing takes the chosen style (locked)", s[1].style === DP && s[1].styleLocked, JSON.stringify(s[1]));
  check("set: the add-on gets no style", s[2].style === null, JSON.stringify(s[2]));
  check("set: a style a person set stays", s[3].style === PETS && s[3].styleLocked, JSON.stringify(s[3]));

  const lone = await mkOrder({ status: "ready_to_assign", items: [{ title: PEOPLE_TITLE }, { title: FAST_TRACK }] });
  await withSystemContext((tx) => applyOrderStyle(tx, { orderId: lone.id, businessId: ids.biz, chosen: DP, chosenLocked: true }));
  const l = await itemStyles(lone.id);
  check("set: one portrait + Fast Track: the portrait takes it, as before; Fast Track none", l[0].style === DP && l[0].styleLocked && l[1].style === null, JSON.stringify(l));
}

// The app login may not delete activity_log rows (append-only), so the
// clean-up uses the owner connection, as the other suites do.
async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    const userIds = [ids.people, ids.disney, ids.duo, ids.pets, ids.va];
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
  console.log(failed ? `\n${failed} check(s) failed` : "\nall multi-style checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
