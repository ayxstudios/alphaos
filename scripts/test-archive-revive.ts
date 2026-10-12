/**
 * Pure test (no database) for the item rows an archived order gets back when a
 * customer revision revives it: lib/orders/archive.ts importItemsFromRawImport,
 * the thin wrapper that turns the platform payload kept in orders.raw_import
 * into the same rows the importer builds. The DB side (flag cleared, rows
 * written, activity row, one transaction) lives in scripts/test-transitions.ts.
 */
import assert from "node:assert/strict";

import { etsyImportItems } from "../lib/integrations/etsy/receipt-review";
import { importItemsFromRawImport, revivedDueAt, REVIVED_REVISION_DUE_HOURS } from "../lib/orders/archive";

// An old Etsy order the way the importer stored it: one download line and one
// printed line, each with the buyer's chosen options.
const receipt = {
  receipt_id: 4196536586,
  name: "Archive Test Buyer",
  buyer_email: "archive-test@example.com",
  transactions: [
    {
      transaction_id: 1,
      title: "Custom Pet Portrait Digital Download",
      sku: "PET-DIGITAL",
      quantity: 1,
      is_digital: true,
      variations: [{ formatted_name: "Style", formatted_value: "Watercolor" }],
    },
    {
      transaction_id: 2,
      title: "Custom Cartoon Pet Portrait",
      sku: null,
      quantity: 1,
      is_digital: false,
      variations: [
        { formatted_name: "Size", formatted_value: "8x10" },
        { formatted_name: "Personalization:", formatted_value: "Ammut" },
      ],
    },
  ],
};
const before = JSON.stringify(receipt);

// Etsy: one row per receipt transaction, options and product type as read.
const items = importItemsFromRawImport("etsy", receipt);
assert.equal(items.length, 2);
assert.deepEqual(items[0], {
  sku: "PET-DIGITAL",
  title: "Custom Pet Portrait Digital Download",
  options: [{ name: "Style", value: "Watercolor" }],
  rawVariations: [{ label: "Style", value: "Watercolor" }],
  productType: "digital",
});
assert.deepEqual(items[1], {
  sku: null,
  title: "Custom Cartoon Pet Portrait",
  options: [
    { name: "Size", value: "8x10" },
    { name: "Personalization", value: "Ammut" },
  ],
  rawVariations: [
    { label: "Size", value: "8x10" },
    { label: "Personalization", value: "Ammut" },
  ],
  productType: "physical",
});

// Exactly what the importer builds, not a second opinion on it.
assert.deepEqual(items, etsyImportItems(receipt));

// Figure count and style are never guessed: a revived order's rows carry only
// what the receipt says, so a VA resolves the figures the way they do for any
// imported order.
for (const item of items) {
  assert.deepEqual(Object.keys(item).sort(), ["options", "productType", "rawVariations", "sku", "title"]);
}

// A single-line receipt gives a single row.
assert.equal(importItemsFromRawImport("etsy", { transactions: [receipt.transactions[1]] }).length, 1);

// The payload is only read.
assert.equal(JSON.stringify(receipt), before);

// Only Etsy keeps a payload to rebuild from. Shopify writes its rows at import
// time (archived orders included) and the other sources store no transactions,
// so none of them may invent rows, whatever the payload looks like.
for (const source of ["shopify", "manual", "legacy", "trello", "gmail", "", null, undefined]) {
  assert.deepEqual(importItemsFromRawImport(source, receipt), [], `source ${String(source)}`);
}

// Etsy orders with nothing to rebuild from (stubs, empty or malformed payloads)
// give no rows, and never throw.
const nothing: unknown[] = [
  null,
  undefined,
  {},
  [],
  "receipt",
  42,
  { name: "Archive Test Buyer", buyer_email: "archive-test@example.com" },
  { transactions: [] },
  { transactions: "none" },
  { transactions: [null, 4, "x"] },
];
for (const raw of nothing) {
  assert.deepEqual(importItemsFromRawImport("etsy", raw), [], `etsy payload ${JSON.stringify(raw)}`);
}

// A revived order whose deadline passed gets a fresh revision deadline; one
// still ahead (or a future one) is left alone.
const now = new Date("2026-10-12T04:30:00Z");
const fresh = new Date(now.getTime() + REVIVED_REVISION_DUE_HOURS * 3600_000);
assert.deepEqual(revivedDueAt(new Date("2026-08-01T00:00:00Z"), now), fresh, "past deadline moves");
assert.deepEqual(revivedDueAt(null, now), fresh, "missing deadline is set");
assert.equal(revivedDueAt(new Date("2026-10-20T00:00:00Z"), now), null, "future deadline kept");

console.log("test-archive-revive passed");
