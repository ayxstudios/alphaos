import assert from "node:assert/strict";

import {
  etsyImportItems,
  inferProductCategory,
  missingReviewFields,
  parseEtsyReceiptReview,
  reviewDefaults,
} from "../lib/integrations/etsy/receipt-review";

const referenceReceipt = {
  receipt_id: 4131910948,
  name: "Janelle Racine",
  buyer_email: null,
  created_timestamp: 1785556472,
  message_from_buyer: null,
  transactions: [
    {
      transaction_id: 5165842444,
      title: "Custom Pet Portrait Mug | Pet Cartoon Drawing from Photo | Dog & Cat Face Picture Cup | Animal Lover Gift | Pet Gift",
      quantity: 1,
      is_digital: false,
      expected_ship_date: 1785600000,
      variations: [
        {
          formatted_name: "Number of Pets",
          formatted_value: "2",
        },
        {
          formatted_name: "Mug Size",
          formatted_value: "11 oz",
        },
        {
          formatted_name: "Personalization",
          formatted_value: "Baker (male) & Maui (female), sage plain background",
        },
      ],
    },
  ],
};

const parsed = parseEtsyReceiptReview(referenceReceipt);
assert.equal(parsed.receiptNumber, "4131910948");
assert.equal(parsed.buyerName, "Janelle Racine");
assert.equal(parsed.transactions.length, 1);
assert.equal(parsed.transactions[0].quantity, 1);
assert.equal(parsed.transactions[0].fulfillment, "physical");
assert.equal(parsed.inferredFigureCount, 2);
assert.equal(parsed.inferredProductCategory, "Mug");
assert.equal(parsed.transactions[0].productAttributes.some((v) => v.label === "Mug Size" && v.value === "11 oz"), true);
assert.equal(parsed.combinedPersonalization, "Baker (male) & Maui (female), sage plain background");
assert.equal(parsed.buyerNote, null);

const defaults = reviewDefaults(parsed);
assert.equal(defaults.customerName, "Janelle Racine");
assert.equal(defaults.customerEmail, "");
assert.equal(defaults.figureCount, "2");
assert.equal(defaults.productTitle, "Mug");
assert.equal(defaults.productType, "physical");
assert.notEqual(defaults.productTitle, "Physical");
assert.equal(defaults.notes, "Baker (male) & Maui (female), sage plain background");

const savedDefaults = reviewDefaults(parsed, {
  customerName: "Saved Name",
  customerEmail: "saved@example.com",
  figureCount: 3,
  style: "Watercolor",
  productTitle: "Saved Product",
  productType: "digital",
  notes: "Saved notes",
});
assert.deepEqual(savedDefaults, {
  customerName: "Saved Name",
  customerEmail: "saved@example.com",
  figureCount: "3",
  style: "Watercolor",
  productTitle: "Saved Product",
  productType: "digital",
  notes: "Saved notes",
});

const multi = parseEtsyReceiptReview({
  receipt_id: 1,
  transactions: [
    {
      title: "Custom Mug",
      quantity: "1",
      is_digital: false,
      variations: [
        { formatted_name: "Figures", formatted_value: "2 pets" },
      ],
    },
    {
      title: "Digital portrait",
      quantity: 2,
      is_digital: true,
      variations: [
        { formatted_name: "Number of People", formatted_value: "1" },
        { formatted_name: "personalization", formatted_value: "Second item" },
      ],
    },
  ],
});
assert.equal(multi.transactions.length, 2);
assert.equal(multi.inferredFigureCount, null);
assert.equal(multi.inferredFulfillment, "physical");
assert.equal(multi.combinedPersonalization, "Second item");

// No product kind in the listing: the listing title itself prefills Product.
const plainTitle = parseEtsyReceiptReview({
  receipt_id: 2,
  transactions: [{ title: "Custom Family Portrait, Cartoon Drawing From Photo", quantity: 1, variations: [] }],
});
assert.equal(plainTitle.inferredProductCategory, null);
assert.equal(reviewDefaults(plainTitle).productTitle, "Custom Family Portrait, Cartoon Drawing From Photo");
assert.equal(reviewDefaults(plainTitle, { productTitle: "Saved" }).productTitle, "Saved");

const malformed = parseEtsyReceiptReview({
  receipt_id: "bad",
  transactions: [
    null,
    {
      title: 12,
      quantity: "not a number",
      variations: [
        { formatted_name: "", formatted_value: "2" },
        { formatted_name: "Number of Figures", formatted_value: "no number" },
      ],
    },
  ],
});
assert.equal(malformed.receiptNumber, null);
assert.equal(malformed.transactions.length, 1);
assert.equal(malformed.transactions[0].variations.length, 1);
assert.equal(malformed.transactions[0].figureCount, null);

assert.equal(inferProductCategory("Portrait Mug", []), "Mug");
assert.equal(inferProductCategory("Physical portrait", []), null);
assert.deepEqual(missingReviewFields({ customerEmail: "", style: "", photoCount: 0 }), [
  "Customer email",
  "Style",
  "Reference photos",
]);
assert.deepEqual(missingReviewFields({ customerEmail: "a@example.com", style: "Pixar", photoCount: 1 }), []);

// etsyImportItems: one item row per transaction, buyer variations as options,
// digital/physical from the same rule the review uses, physical on conflict.
const importItems = etsyImportItems({
  receipt_id: 3,
  transactions: [
    {
      transaction_id: 11,
      title: "Custom Cartoon Pet Portrait",
      sku: "PET-CARTOON",
      quantity: 1,
      is_digital: false,
      variations: [
        { formatted_name: "Background:", formatted_value: "Snow" },
        { formatted_name: "Personalization", formatted_value: "Ammut" },
      ],
    },
    {
      transaction_id: 12,
      title: "Digital add-on",
      sku: null,
      quantity: 1,
      is_digital: true,
      variations: [],
    },
  ],
});
assert.equal(importItems.length, 2);
assert.equal(importItems[0].title, "Custom Cartoon Pet Portrait");
assert.equal(importItems[0].sku, "PET-CARTOON");
assert.deepEqual(importItems[0].options, [
  { name: "Background", value: "Snow" },
  { name: "Personalization", value: "Ammut" },
]);
assert.equal(importItems[0].productType, "physical");
assert.equal(importItems[1].productType, "digital");
assert.deepEqual(importItems[1].options, []);
// A conflicted listing (download flagged digital but a Canvas option) defaults
// physical, matching reviewDefaults' fallback; malformed input yields nothing.
const conflicted = etsyImportItems({
  transactions: [{
    is_digital: true,
    variations: [{ formatted_name: "Print on", formatted_value: "Canvas" }],
  }],
});
assert.equal(conflicted.length, 1);
assert.equal(conflicted[0].productType, "physical");
assert.deepEqual(etsyImportItems(null), []);
assert.deepEqual(etsyImportItems({ transactions: [null, 4] }), []);

console.log("test-etsy-review passed");
