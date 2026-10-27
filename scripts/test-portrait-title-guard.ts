import assert from "node:assert/strict";

import { portraitTitleToSave } from "../lib/orders/complete-details";

const dog = { id: "a", title: "Custom Watercolor Dog Portrait | Hand-Drawn Pet Illustration", sku: null };
const addOn = { id: "b", title: "Print & Ship My Order - ADD-ON LISTING", sku: null };
const items = [dog, addOn];

// CPS 4213709410: the form carried the add-on's title; the portrait line keeps its own.
assert.equal(portraitTitleToSave(addOn.title, dog, items, null), dog.title);
// An add-on title typed by hand is refused on a real portrait line too.
assert.equal(portraitTitleToSave("Rush my order", dog, items, null), dog.title);
// A real rename of the portrait line still saves.
assert.equal(portraitTitleToSave("Custom Watercolor Cat Portrait", dog, items, null), "Custom Watercolor Cat Portrait");
// One line: whatever the VA typed.
assert.equal(portraitTitleToSave(addOn.title, dog, [dog], null), addOn.title);
// Every line an add-on already: the form may repair it.
assert.equal(portraitTitleToSave(dog.title, addOn, [addOn, { id: "c", title: addOn.title }], null), dog.title);
// Nothing typed stays nothing (the caller's choice), a blank is null.
assert.equal(portraitTitleToSave("  ", dog, items, null), null);

console.log("portrait title guard: 6 checks passed");
