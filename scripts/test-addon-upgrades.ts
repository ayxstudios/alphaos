// Upgrades (Yousif 2026-11-08: "customers order digital only then upgrade to
// physical ... cannot be left behind"): a print bought on its own finds the
// buyer's portrait order, even a finished one, and is never left unprinted.
// Pure rules only, no database (the passes run in lib/agent/autopilot.ts).
import assert from "node:assert/strict";

import {
  ADDON_PRINT_HOURS,
  ADDON_SETTLE_HOURS,
  namedOrderNumbers,
  ownerOf,
  pickAddonParent,
  stuckWords,
  type AddonCandidate,
  type OrderFacts,
} from "../lib/agent/limbo";
import { roadOf } from "../lib/agent/needs-you";
import { isAddOnOnly, isLinkableAddOn, isPrintLine } from "../lib/orders/add-ons";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok ${name}`);
}

const HOUR = 3_600_000;
const now = new Date("2026-11-08T08:00:00Z");
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

// --- Order numbers written on the add-on ------------------------------------

test("an Etsy receipt number and shop order names are read off the buyer's words", () => {
  assert.deepEqual(namedOrderNumbers("Please print my order 4202684757 at 8x10"), ["4202684757"]);
  assert.deepEqual(namedOrderNumbers("Print & Ship for #CPS10300"), ["CPS10300"]);
  assert.deepEqual(namedOrderNumbers("same as pc32227 please"), ["PC32227"]);
  assert.deepEqual(namedOrderNumbers("order #1234"), ["1234"]);
  assert.deepEqual(namedOrderNumbers(null, undefined, ""), []);
});

test("sizes and short numbers are not order numbers", () => {
  assert.deepEqual(namedOrderNumbers("8x10 canvas, 2 copies, 30x40cm"), []);
  assert.deepEqual(namedOrderNumbers("Print & Ship My Order - ADD-ON LISTING"), []);
});

// --- Which order it rides on --------------------------------------------------

const cand = (number: string, over: Partial<AddonCandidate> = {}): AddonCandidate => ({
  id: `id-${number}`,
  number,
  status: "complete",
  placedAt: ago(20 * 24),
  named: false,
  physical: false,
  closed: true,
  ...over,
});
const print = { physical: true, at: ago(3) };

test("the order she wrote on it wins over her other orders", () => {
  const pick = pickAddonParent([cand("4100000001"), cand("4202684757", { named: true })], print, now);
  assert.equal(pick.kind === "link" && pick.parent.number, "4202684757");
});

test("two orders written on it = a person picks between those two", () => {
  const pick = pickAddonParent([cand("A", { named: true }), cand("B", { named: true }), cand("C")], print, now);
  assert.equal(pick.kind, "ask");
  assert.deepEqual(pick.kind === "ask" && pick.candidates.map((c) => c.number), ["A", "B"]);
});

test("her one finished digital order is upgraded: the print links to it", () => {
  const pick = pickAddonParent([cand("4202684757")], print, now);
  assert.equal(pick.kind === "link" && pick.parent.number, "4202684757");
});

test("a lone finished order waits out the first hour (a portrait bought with it may still be importing)", () => {
  const fresh = { physical: true, at: new Date(now.getTime() - (ADDON_SETTLE_HOURS * HOUR) / 2) };
  assert.equal(pickAddonParent([cand("4202684757")], fresh, now).kind, "wait");
  // An open order is hers to ride on straight away.
  assert.equal(pickAddonParent([cand("4202684757", { closed: false, status: "in_design" })], fresh, now).kind, "link");
  // Nothing found yet asks nobody inside the hour, and asks after it.
  assert.equal(pickAddonParent([], fresh, now).kind, "wait");
  const none = pickAddonParent([], print, now);
  assert.equal(none.kind === "ask" && none.candidates.length, 0);
});

test("a print goes on the order she bought digital only, not one that already ships", () => {
  const pick = pickAddonParent([cand("CANVAS", { physical: true }), cand("DIGITAL")], print, now);
  assert.equal(pick.kind === "link" && pick.parent.number, "DIGITAL");
});

test("among her digital orders, the one bought within a day of the print is it", () => {
  const pick = pickAddonParent([cand("OLD"), cand("TODAY", { placedAt: ago(5) })], print, now);
  assert.equal(pick.kind === "link" && pick.parent.number, "TODAY");
});

test("two equally likely orders = a person picks, with both named", () => {
  const pick = pickAddonParent([cand("ONE"), cand("TWO")], print, now);
  assert.equal(pick.kind, "ask");
  assert.deepEqual(pick.kind === "ask" && pick.candidates.map((c) => c.number), ["ONE", "TWO"]);
});

// --- Lines ----------------------------------------------------------------------

const pixart = { nonPortraitTitles: ["eGift Card", "Phone Case"] };

test("a gift card is never linked to a portrait order", () => {
  assert.equal(isLinkableAddOn({ title: "eGift Card" }, pixart), false);
  assert.equal(isLinkableAddOn({ title: "Print & Ship My Order - ADD-ON LISTING" }, null), true);
  assert.equal(isLinkableAddOn({ title: "Phone Case" }, pixart), true);
});

test("CPS's Print & Ship add-on is a print even though it is saved as digital", () => {
  assert.equal(isPrintLine({ title: "Print & Ship My Order - ADD-ON LISTING", productType: "digital" }), true);
  assert.equal(isPrintLine({ title: "Poster", productType: "physical" }), true);
  assert.equal(isPrintLine({ title: "Rush My Order", productType: "digital" }), false);
});

test("only an order of nothing but add-ons is an add-on order", () => {
  assert.equal(isAddOnOnly([], null), false);
  assert.equal(isAddOnOnly([{ title: "Print & Ship My Order - ADD-ON LISTING" }], null), true);
  assert.equal(isAddOnOnly([{ title: "Custom Pet Portrait" }, { title: "Rush My Order" }], null), false);
});

// --- Never left behind ----------------------------------------------------------

const facts = (over: Partial<OrderFacts>): OrderFacts => ({
  id: "o1",
  number: "4214319332",
  status: "fulfillment_only",
  needsReview: false,
  inScope: true,
  enteredAt: ago(10 * 24),
  activeAssignment: false,
  aiFailedHold: false,
  hasContact: true,
  lastChaseAt: null,
  parentLive: true,
  openKinds: [],
  style: null,
  addonPhysical: true,
  parentClosed: true,
  parentArt: true,
  parentReadyAt: ago(2),
  addonPrinted: false,
  ...over,
});

test("a paid print on a finished order is the print road's for a day from when it was ready", () => {
  const o = ownerOf(facts({}), now);
  assert.equal(o.bucket, "pipeline");
  assert.equal(o.why, "paid print, prints from its finished order's approved art");
});

test("still not at a printer a day after it was ready = raised, never quiet", () => {
  const o = ownerOf(facts({ parentReadyAt: ago(ADDON_PRINT_HOURS + 1) }), now);
  assert.equal(o.bucket, "limbo");
  assert.equal(o.bucket === "limbo" && o.reason, "addon_unprinted");
});

test("a finished order with no approved art to print from is raised as that", () => {
  const o = ownerOf(facts({ parentReadyAt: ago(ADDON_PRINT_HOURS + 1), parentArt: false }), now);
  assert.equal(o.bucket === "limbo" && o.reason, "addon_no_art");
});

test("the clock runs from the later of linking and the order being ready, not the purchase", () => {
  // Bought 10 days ago, her portrait approved 2 hours ago: a fresh day.
  assert.equal(ownerOf(facts({ enteredAt: ago(10 * 24), parentReadyAt: ago(2) }), now).bucket, "pipeline");
  // Linked 2 hours ago onto an order approved weeks back: a fresh day too.
  assert.equal(ownerOf(facts({ enteredAt: ago(2), parentReadyAt: ago(30 * 24) }), now).bucket, "pipeline");
});

test("a print at the printer is the printer's, however old", () => {
  assert.equal(ownerOf(facts({ parentReadyAt: ago(30 * 24), addonPrinted: true }), now).bucket, "pipeline");
});

test("a print on an open portrait order rides with it; so does a digital extra on a finished one", () => {
  assert.equal(ownerOf(facts({ parentClosed: false, parentReadyAt: ago(30 * 24) }), now).why, "add-on with its portrait order");
  assert.equal(ownerOf(facts({ addonPhysical: false, parentReadyAt: ago(30 * 24) }), now).why, "add-on with its portrait order");
});

test("a print with no portrait order is an orphan after its day", () => {
  const o = ownerOf(facts({ parentLive: false, parentClosed: false, parentArt: false, parentReadyAt: null, enteredAt: ago(2 * 24) }), now);
  assert.equal(o.bucket === "limbo" && o.reason, "addon_orphan");
});

test("the raised cards are the agent's to work, never an owner's", () => {
  const base = { status: "fulfillment_only", lastChaseAt: null, hasContact: true, style: null };
  for (const reason of ["addon_unprinted", "addon_no_art", "addon_orphan"] as const) {
    const w = stuckWords(reason, base, null, now);
    assert.equal(roadOf({ kind: "stuck_order", reason, summary: w.summary, recommendation: w.recommendation }).road, "agent", reason);
  }
  const ask = `A paid print with no portrait order from this buyer in the last 120 days: find hers (her messages, or the order number she gave) and link it so it prints.`;
  assert.equal(roadOf({ kind: "addon_only", summary: "Order #4214319332 is an add-on only (Print & Ship My Order - ADD-ON LISTING): match it to the portrait order and fulfil it", recommendation: ask }).road, "agent");
});

console.log(`\n${passed} add-on upgrade tests passed`);
