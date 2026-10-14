// Portrait slots (two portraits in one email, Yousif 2026-10-14): one order
// line x quantity N is N portraits to draw and send, each with a stable key an
// upload can be tagged with. Covers the quantity read at import, the slot
// builder (quantity expansion, add-on lines, the proof page's per-line mode),
// the key helpers and the pairing the quantity backfill uses. Pure, no database.
import assert from "node:assert/strict";

import { etsyImportItems } from "../lib/integrations/etsy/receipt-review";
import {
  MAX_ITEM_QUANTITY,
  clampItemQuantity,
  matchItemQuantities,
  type QuantityLine,
} from "../lib/orders/item-quantity";
import {
  buildPortraitSlots,
  parseSlotKey,
  portraitLabel,
  slotKeyOf,
  type PortraitItem,
} from "../lib/orders/portraits";

const item = (id: string, title: string | null, quantity = 1, variation: string | null = null, sku: string | null = null): PortraitItem => ({
  id,
  title,
  variation,
  sku,
  quantity,
});

// ---- Quantity as stored: floored, at least 1, at most 20 ----------------
assert.equal(MAX_ITEM_QUANTITY, 20);
for (const [raw, want] of [
  [1, 1],
  [2, 2],
  [2.9, 2],
  [0, 1],
  [-3, 1],
  ["3", 3],
  [" 4 ", 4],
  ["2.5", 2],
  ["", 1],
  ["abc", 1],
  [Number.NaN, 1],
  [Number.POSITIVE_INFINITY, 1],
  [null, 1],
  [undefined, 1],
  [true, 1],
  [{}, 1],
  [20, 20],
  [21, 20],
  [500, 20],
  [1e9, 20],
] as const) {
  assert.equal(clampItemQuantity(raw), want, `quantity ${String(raw)} is stored as ${want}`);
}

// An Etsy receipt line carries its quantity into the import, clamped.
const importQuantity = (quantity: unknown) =>
  etsyImportItems({ transactions: [{ title: "Pet Portrait", quantity, variations: [] }] })[0].quantity;
assert.equal(importQuantity(2), 2);
assert.equal(importQuantity("3"), 3);
assert.equal(importQuantity(99), 20);
assert.equal(importQuantity(0), 1);
assert.equal(importQuantity(undefined), 1);
assert.equal(importQuantity("not a number"), 1);

// ---- Slots: one line x quantity ----------------------------------------
// One line, quantity 1: one slot, keyed by the item id, labelled as before.
let slots = buildPortraitSlots([item("i1", "Pet Portrait", 1, "8x10")], null);
assert.deepEqual(slots, [{ key: "i1", itemId: "i1", unit: 1, n: 1, label: "Pet Portrait · 8x10" }]);
assert.equal(slots[0].label, portraitLabel({ title: "Pet Portrait", variation: "8x10" }), "quantity 1 keeps the plain label");

// One line, quantity 2 (orders 4200816588 and 4198299787): two slots.
slots = buildPortraitSlots([item("i1", "Two Pets Watercolor", 2, "8x10")], null);
assert.deepEqual(
  slots.map((s) => [s.key, s.itemId, s.unit, s.n, s.label]),
  [
    ["i1", "i1", 1, 1, "Two Pets Watercolor · 8x10 · 1 of 2"],
    ["i1:2", "i1", 2, 2, "Two Pets Watercolor · 8x10 · 2 of 2"],
  ],
);

// Subject count is not portrait count: two pets together is one file.
slots = buildPortraitSlots([item("pair", "Two Pets Watercolor", 1, "Number Of Pets: 2")], null);
assert.equal(slots.length, 1, "two pets in one purchased portrait is one slot");

// Two lines of quantity 1 (order 4201015378): the item ids stay the keys, so
// every upload tagged before quantities counted still lands on its portrait.
slots = buildPortraitSlots([item("a", "Dog", 1), item("b", "Cat", 1)], null);
assert.deepEqual(slots.map((s) => [s.key, s.unit, s.n, s.label]), [["a", 1, 1, "Dog"], ["b", 1, 2, "Cat"]]);

// A quantity-2 line next to a quantity-1 line: three slots, numbered across the order.
slots = buildPortraitSlots([item("a", "Dog", 2), item("b", "Cat", 1)], null);
assert.deepEqual(slots.map((s) => [s.key, s.n]), [["a", 1], ["a:2", 2], ["b", 3]]);
assert.deepEqual(slots.map((s) => s.label), ["Dog · 1 of 2", "Dog · 2 of 2", "Cat"]);

// Quantity 9 on one line (order 4200343312): nine slots, nine distinct keys.
slots = buildPortraitSlots([item("big", "Family Cartoon", 9)], null);
assert.equal(slots.length, 9);
assert.deepEqual(slots.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.deepEqual(slots.map((s) => s.unit), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.equal(new Set(slots.map((s) => s.key)).size, 9);
assert.equal(slots[0].key, "big");
assert.equal(slots[8].key, "big:9");
assert.equal(slots[8].label, "Family Cartoon · 9 of 9");

// A quantity above the cap is capped; unreadable quantities are one slot.
assert.equal(buildPortraitSlots([item("x", "Huge", 99)], null).length, 20);
assert.equal(buildPortraitSlots([item("x", "Zero", 0)], null).length, 1);
assert.equal(buildPortraitSlots([item("x", "Neg", -4)], null).length, 1);
assert.equal(buildPortraitSlots([item("x", "NaN", Number.NaN)], null).length, 1);

// A line with no title or option still gets a readable label per unit.
slots = buildPortraitSlots([item("e", null, 2)], null);
assert.deepEqual(slots.map((s) => s.label), ["1 of 2", "2 of 2"]);
slots = buildPortraitSlots([item("e", "   ", 1)], null);
assert.equal(slots[0].label, "");

// A long title is cut so the label with its "n of N" tail stays within 70.
slots = buildPortraitSlots([item("long", "Custom Pet Portrait from Photo Watercolor Painting Gift ".repeat(3), 3, "11x14 canvas")], null);
for (const s of slots) assert.ok(s.label.length <= 70, `label fits: ${s.label.length}`);
assert.ok(slots[1].label.endsWith(" · 2 of 3"), slots[1].label);
assert.ok(slots[1].label.includes("…"), "the title is the part that is cut");

// ---- Slots: add-on lines never become portraits --------------------------
slots = buildPortraitSlots([item("p", "Pet Portrait", 2), item("addon", "Print & Ship Add-on", 1)], null);
assert.deepEqual(slots.map((s) => s.key), ["p", "p:2"], "an add-on next to a portrait is no slot");

slots = buildPortraitSlots([item("p", "Pet Portrait", 1), item("r", "Rush 24 Hour Delivery", 3)], null);
assert.deepEqual(slots.map((s) => s.key), ["p"], "a rush line's quantity does not add slots");

slots = buildPortraitSlots([item("p", "Pet Portrait", 1, null, "PORT"), item("s", "Tracked Shipping", 2, null, "SHIP-1")], {
  nonPortraitSkus: ["ship-1"],
});
assert.deepEqual(slots.map((s) => s.key), ["p"], "the shop's own non-portrait SKU list applies");

slots = buildPortraitSlots([item("p", "Pet Portrait", 1), item("g", "Gift Card Bundle", 2)], { nonPortraitTitles: ["gift card"] });
assert.deepEqual(slots.map((s) => s.key), ["p"], "the shop's own non-portrait title list applies");

// A lone line is always a portrait, even one titled like an add-on.
slots = buildPortraitSlots([item("only", "Rush Pet Portrait", 2)], null);
assert.deepEqual(slots.map((s) => s.key), ["only", "only:2"]);

// Every line an add-on: keep them all rather than leave the order with no slot.
slots = buildPortraitSlots([item("a1", "Rush Delivery", 1), item("a2", "Print & Ship", 1)], null);
assert.deepEqual(slots.map((s) => s.key), ["a1", "a2"]);

// No lines at all: no slots (callers treat that as a single portrait).
assert.deepEqual(buildPortraitSlots([], null), []);

// ---- perLine: the customer's proof page keeps one section per line -------
slots = buildPortraitSlots([item("a", "Dog", 2, "8x10"), item("b", "Cat", 3)], null, { perLine: true });
assert.deepEqual(slots.map((s) => [s.key, s.itemId, s.unit, s.n, s.label]), [
  ["a", "a", 1, 1, "Dog · 8x10"],
  ["b", "b", 1, 2, "Cat"],
]);
slots = buildPortraitSlots([item("a", "Dog", 2), item("addon", "Rush", 1)], null, { perLine: true });
assert.deepEqual(slots.map((s) => s.key), ["a"], "perLine still leaves add-ons out");
slots = buildPortraitSlots([item("only", "Pet Portrait", 9)], null, { perLine: true });
assert.deepEqual(slots.map((s) => [s.key, s.n, s.label]), [["only", 1, "Pet Portrait"]], "a quantity-9 line is one proof section");

// ---- Slot keys -----------------------------------------------------------
assert.equal(slotKeyOf({ orderItemId: null, portraitUnit: null }), null);
assert.equal(slotKeyOf({ orderItemId: null, portraitUnit: 2 }), null, "a unit without an item is not a slot");
assert.equal(slotKeyOf({ orderItemId: "i1", portraitUnit: null }), "i1", "NULL unit = unit 1");
assert.equal(slotKeyOf({ orderItemId: "i1", portraitUnit: 1 }), "i1");
assert.equal(slotKeyOf({ orderItemId: "i1", portraitUnit: 2 }), "i1:2");
assert.equal(slotKeyOf({ orderItemId: "i1", portraitUnit: 20 }), "i1:20");

const uuid = "0b1f4c9e-6c3a-4d2e-9a77-1c2d3e4f5a6b";
assert.deepEqual(parseSlotKey("i1"), { itemId: "i1", unit: 1 });
assert.deepEqual(parseSlotKey("i1:2"), { itemId: "i1", unit: 2 });
assert.deepEqual(parseSlotKey("i1:1"), { itemId: "i1", unit: 1 });
assert.deepEqual(parseSlotKey(uuid), { itemId: uuid, unit: 1 });
assert.deepEqual(parseSlotKey(`${uuid}:12`), { itemId: uuid, unit: 12 });
for (const junk of [
  "",
  ":2",
  "i1:",
  "i1:0",
  "i1:02",
  "i1:-2",
  "i1:2:3",
  "i1:x",
  "i1 :2",
  " i1",
  "i1\n",
  "i1:99999999999999999999",
  null,
  undefined,
  5,
  {},
  ["i1"],
] as const) {
  assert.equal(parseSlotKey(junk), null, `${JSON.stringify(junk)} is not a slot key`);
}

// A key built by the slot builder reads back to its own item and unit, and
// the columns an upload stores for it (unit 1 as NULL) rebuild the same key.
slots = buildPortraitSlots([item(uuid, "Dog", 3), item("b", "Cat", 2)], null);
assert.equal(new Set(slots.map((s) => s.key)).size, slots.length, "keys are unique across the order");
for (const s of slots) {
  assert.deepEqual(parseSlotKey(s.key), { itemId: s.itemId, unit: s.unit });
  assert.equal(slotKeyOf({ orderItemId: s.itemId, portraitUnit: s.unit === 1 ? null : s.unit }), s.key);
}

// ---- Pairing a stored row with its import line (the quantity backfill) ----
const line = (title: string, quantity: number, options: QuantityLine["options"] = []): QuantityLine => ({ title, options, quantity });
const row = (id: string, title: string | null, options: QuantityLine["options"] | null = []) => ({ id, title, options });

// The lone row of the lone line is paired outright, even retitled since import.
assert.deepEqual(matchItemQuantities([row("r1", "Renamed by a VA")], [line("Original title", 2)]), [
  { itemId: "r1", quantity: 2, how: "single" },
]);

// Two different lines match by title and options.
assert.deepEqual(
  matchItemQuantities([row("r1", "Dog"), row("r2", "Cat")], [line("Cat", 3), line("Dog", 2)]),
  [
    { itemId: "r1", quantity: 2, how: "matched" },
    { itemId: "r2", quantity: 3, how: "matched" },
  ],
);

// The same title with different options is a different line.
const small = [{ name: "Size", value: "Small" }];
const large = [{ name: "Size", value: "Large" }];
assert.deepEqual(
  matchItemQuantities([row("r1", "Print", small), row("r2", "Print", large)], [line("Print", 4, large), line("Print", 1, small)]),
  [
    { itemId: "r1", quantity: 1, how: "matched" },
    { itemId: "r2", quantity: 4, how: "matched" },
  ],
);

// Two identical lines that agree on the quantity pair with both identical rows.
assert.deepEqual(
  matchItemQuantities([row("r1", "Dog"), row("r2", "Dog")], [line("Dog", 2), line("Dog", 2)]).map((m) => [m.quantity, m.how]),
  [[2, "matched"], [2, "matched"]],
);

// Identical lines that disagree cannot be told apart: left alone, never guessed.
assert.deepEqual(
  matchItemQuantities([row("r1", "Dog"), row("r2", "Dog")], [line("Dog", 2), line("Dog", 1)]).map((m) => [m.quantity, m.how]),
  [[null, "ambiguous"], [null, "ambiguous"]],
);

// More rows than lines of the same title (a VA split a line): left alone.
assert.deepEqual(
  matchItemQuantities([row("r1", "Dog"), row("r2", "Dog")], [line("Dog", 2)]).map((m) => [m.quantity, m.how]),
  [[null, "ambiguous"], [null, "ambiguous"]],
);

// One row and one line left over after the matches are each other's pair.
assert.deepEqual(
  matchItemQuantities([row("r1", "Dog"), row("r2", "Retitled")], [line("Dog", 2), line("Cat", 3)]),
  [
    { itemId: "r1", quantity: 2, how: "matched" },
    { itemId: "r2", quantity: 3, how: "leftover" },
  ],
);

// Two rows nothing matches: no guess.
assert.deepEqual(
  matchItemQuantities([row("r1", "A"), row("r2", "B")], [line("X", 2), line("Y", 3)]).map((m) => [m.quantity, m.how]),
  [[null, "unmatched"], [null, "unmatched"]],
);

// A receipt with no lines leaves every row alone.
assert.deepEqual(matchItemQuantities([row("r1", "Dog")], []), [{ itemId: "r1", quantity: null, how: "unmatched" }]);

// Options stored as NULL read like no options.
assert.deepEqual(
  matchItemQuantities([row("r1", "Dog", null), row("r2", "Cat", null)], [line("Dog", 2), line("Cat", 1)]).map((m) => m.how),
  ["matched", "matched"],
);

console.log("portrait slots: all checks passed");
