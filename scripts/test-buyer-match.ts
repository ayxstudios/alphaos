/**
 * The customer on an order must be the person who bought it (pure, no db).
 * The three real mix-ups from the VA touchups are pinned as mismatches, and the
 * ways one person's name legitimately differs (middle name, case, spacing,
 * accents, initials) must still match so a VA is not nagged for nothing.
 */
import assert from "node:assert/strict";

import {
  buyerMismatchMessage,
  buyerMismatchNotice,
  buyerSourceLabel,
  greetingFirstName,
  namesMatch,
  nameTokens,
  receiptBuyerName,
} from "../lib/orders/buyer-match";

// ---------------------------------------------------------------------------
// namesMatch: the real incidents are mismatches, both ways round
// ---------------------------------------------------------------------------
const incidents: [string, string][] = [
  ["Audrea Sanchez", "Colleen Luczak"], // order 4198274617 completed with order 4196536586's customer
  ["Amanda Rinehart", "Maya Scopin"], // order 4199520716: Maya got "Hi Amanda"
  ["shellie suhar", "Mary Kate Sheppard"], // order 4180150396 / 4197194057: "Hi shellie!"
];
for (const [a, b] of incidents) {
  assert.equal(namesMatch(a, b), "mismatch", `${a} vs ${b}`);
  assert.equal(namesMatch(b, a), "mismatch", `${b} vs ${a}`);
}

// ---------------------------------------------------------------------------
// namesMatch: the same person written differently
// ---------------------------------------------------------------------------
const same: [string, string][] = [
  ["Mary Kate Sheppard", "Mary Sheppard"], // middle name dropped
  ["Mary Kate Sheppard", "Mary Kate Sheppard"],
  ["Maya", "Maya Scopin"], // first name only
  ["Scopin", "Maya Scopin"], // surname only
  ["Kate Sheppard", "Mary Kate Sheppard"], // middle name used as first
  ["Mary Anne Smith", "Mary Jo Smith"], // first and last agree, middle differs
  ["Mary Kate  Sheppard ", "mary kate sheppard"], // odd spacing and case from Etsy
  ["  SHELLIE   SUHAR", "Shellie Suhar"],
  ["José García", "Jose Garcia"], // accents
  ["Zoë O'Brien", "zoe obrien"], // apostrophe
  ["Mary-Kate Sheppard", "Mary Kate Sheppard"], // hyphen
  ["Sheppard, Mary Kate", "Mary Kate Sheppard"], // surname first
  ["J. Smith", "John Smith"], // initial
  ["Mrs. Mary Sheppard", "Mary Sheppard"], // title
  ["Robert Downey Jr.", "Robert Downey"], // suffix
  ["Amélie Poulain", "Amelie  Poulain"],
];
for (const [a, b] of same) {
  assert.equal(namesMatch(a, b), "match", `${a} vs ${b}`);
  assert.equal(namesMatch(b, a), "match", `${b} vs ${a}`);
}

// ---------------------------------------------------------------------------
// namesMatch: different people who share a word are still different people
// ---------------------------------------------------------------------------
const different: [string, string][] = [
  ["Sarah Johnson", "Sarah Miller"], // same first name only
  ["Sarah Johnson", "Michael Johnson"], // same surname only
  ["Colleen", "Audrea"],
  ["A Smith", "Colleen Luczak"],
  ["Mary Kate Sheppard", "Kate Winslet"],
  ["Amanda", "Maya Scopin"],
];
for (const [a, b] of different) {
  assert.equal(namesMatch(a, b), "mismatch", `${a} vs ${b}`);
  assert.equal(namesMatch(b, a), "mismatch", `${b} vs ${a}`);
}

// ---------------------------------------------------------------------------
// namesMatch: unknown when either side has no name
// ---------------------------------------------------------------------------
for (const empty of ["", "   ", null, undefined, "---", "'"]) {
  assert.equal(namesMatch(empty, "Maya Scopin"), "unknown", `empty ${String(empty)} left`);
  assert.equal(namesMatch("Maya Scopin", empty), "unknown", `empty ${String(empty)} right`);
}
assert.equal(namesMatch(null, undefined), "unknown");
assert.equal(namesMatch("", ""), "unknown");

assert.deepEqual(nameTokens("  Mary-Kate  O'Brien "), ["mary", "kate", "obrien"]);
assert.deepEqual(nameTokens("Dr. Jane Doe Jr"), ["jane", "doe"]);
assert.deepEqual(nameTokens(null), []);

// ---------------------------------------------------------------------------
// receiptBuyerName
// ---------------------------------------------------------------------------
assert.equal(receiptBuyerName("etsy", { name: "Mary Kate  Sheppard " }), "Mary Kate Sheppard");
assert.equal(receiptBuyerName("etsy", { name: "Se&#39;an O&amp;Brien" }), "Se'an O&Brien");
assert.equal(receiptBuyerName("etsy", { name: "shellie suhar", buyer_email: null }), "shellie suhar");
// The Gmail sale-email stub has no receipt `name`, only the parsed buyer name.
assert.equal(
  receiptBuyerName("etsy", { source: "etsy_sale_email", receiptId: "4199520716", buyerName: "Maya Scopin" }),
  "Maya Scopin",
);
assert.equal(receiptBuyerName("etsy", { name: "  ", buyerName: "Maya Scopin" }), "Maya Scopin");
assert.equal(receiptBuyerName("etsy", {}), null);
assert.equal(receiptBuyerName("etsy", { name: 42 }), null);
assert.equal(receiptBuyerName("etsy", null), null);
assert.equal(receiptBuyerName("etsy", undefined), null);
assert.equal(receiptBuyerName("etsy", "Maya Scopin"), null);
assert.equal(receiptBuyerName("etsy", ["Maya Scopin"]), null);
assert.equal(receiptBuyerName(null, { name: "Maya Scopin" }), null);

// Shopify: `name` is the order number, never the buyer.
assert.equal(receiptBuyerName("shopify", { name: "#1001" }), null);
assert.equal(receiptBuyerName("shopify", { customer: { firstName: "Ann", lastName: "Lee" } }), "Ann Lee");
assert.equal(receiptBuyerName("shopify", { customer: { first_name: "Ann", last_name: null } }), "Ann");
assert.equal(receiptBuyerName("shopify", { buyerName: "Ann Lee", name: "#1001" }), "Ann Lee");
assert.equal(receiptBuyerName("shopify", { customer: {} }), null);
assert.equal(receiptBuyerName("shopify", null), null);

// No receipt for hand-made or legacy orders.
for (const source of ["manual", "legacy", "trello"]) {
  assert.equal(receiptBuyerName(source, { name: "Maya Scopin" }), null, source);
}

assert.equal(buyerSourceLabel("etsy"), "Etsy buyer");
assert.equal(buyerSourceLabel("shopify"), "Shopify buyer");
assert.equal(buyerSourceLabel("manual"), null);
assert.equal(buyerSourceLabel(null), null);

// ---------------------------------------------------------------------------
// buyerMismatchNotice: the amber line on the order page
// ---------------------------------------------------------------------------
assert.deepEqual(
  buyerMismatchNotice({
    source: "etsy",
    rawImport: { name: "Colleen Luczak" },
    customerFirstName: "Audrea",
    customerLastName: "Sanchez",
  }),
  { label: "Etsy buyer", buyer: "Colleen Luczak" },
);
assert.deepEqual(
  buyerMismatchNotice({
    source: "shopify",
    rawImport: { buyerName: "Ann Lee" },
    customerFirstName: "Bea",
    customerLastName: "Fox",
  }),
  { label: "Shopify buyer", buyer: "Ann Lee" },
);
// Same person, no customer name, no receipt, or a source without a receipt: no line.
const noNotice = [
  { source: "etsy", rawImport: { name: "Mary Kate Sheppard" }, customerFirstName: "Mary", customerLastName: "Sheppard" },
  { source: "etsy", rawImport: { name: "Mary Kate Sheppard" }, customerFirstName: null, customerLastName: null },
  { source: "etsy", rawImport: null, customerFirstName: "Audrea", customerLastName: "Sanchez" },
  { source: "manual", rawImport: { name: "Colleen Luczak" }, customerFirstName: "Audrea", customerLastName: "Sanchez" },
];
for (const n of noNotice) assert.equal(buyerMismatchNotice(n), null);

// ---------------------------------------------------------------------------
// greetingFirstName: never greet a customer by someone else's name
// ---------------------------------------------------------------------------
// Maya's email sat on a customer row named Amanda Rinehart: the greeting is "Maya".
assert.equal(
  greetingFirstName({ customerFirstName: "Amanda", customerLastName: "Rinehart", receiptBuyer: "Maya Scopin" }),
  "Maya",
);
// Mary Kate's order linked to the "shellie suhar" row: the greeting is "Mary".
assert.equal(
  greetingFirstName({ customerFirstName: "shellie", customerLastName: "suhar", receiptBuyer: "Mary Kate Sheppard" }),
  "Mary",
);
// A lower-case receipt name is title-cased when it is the one used.
assert.equal(
  greetingFirstName({ customerFirstName: "Mary Kate", customerLastName: "Sheppard", receiptBuyer: "shellie suhar" }),
  "Shellie",
);
assert.equal(
  greetingFirstName({ customerFirstName: "Mary", customerLastName: "Sheppard", receiptBuyer: "mary-kate sheppard" }),
  "Mary",
); // same person (first and last agree): the customer's own first name
assert.equal(
  greetingFirstName({ customerFirstName: "Bea", customerLastName: "Fox", receiptBuyer: "mary-kate sheppard" }),
  "Mary-Kate",
);
// Mixed or upper case receipt names are left as written.
assert.equal(
  greetingFirstName({ customerFirstName: "Bea", customerLastName: "Fox", receiptBuyer: "DeAndre Jones" }),
  "DeAndre",
);
assert.equal(
  greetingFirstName({ customerFirstName: "Bea", customerLastName: "Fox", receiptBuyer: "JOAN SMITH" }),
  "JOAN",
);
// The same person, or nothing to compare: the customer's own first name, unchanged.
assert.equal(
  greetingFirstName({ customerFirstName: "Maya", customerLastName: "Scopin", receiptBuyer: "Maya Scopin" }),
  "Maya",
);
assert.equal(
  greetingFirstName({ customerFirstName: "Maya", customerLastName: null, receiptBuyer: "Maya Scopin" }),
  "Maya",
);
assert.equal(
  greetingFirstName({ customerFirstName: "shellie", customerLastName: "suhar", receiptBuyer: null }),
  "shellie",
);
assert.equal(
  greetingFirstName({ customerFirstName: "shellie", customerLastName: "suhar", receiptBuyer: "  " }),
  "shellie",
);
// A customer with no name stays nameless (the caller says "there").
assert.equal(
  greetingFirstName({ customerFirstName: null, customerLastName: null, receiptBuyer: "Maya Scopin" }),
  null,
);
assert.equal(greetingFirstName({ customerFirstName: undefined, customerLastName: undefined, receiptBuyer: null }), null);

// ---------------------------------------------------------------------------
// buyerMismatchMessage: both people, the email and the other order, no pronouns
// ---------------------------------------------------------------------------
const msg = buyerMismatchMessage({
  receiptBuyer: "Colleen Luczak",
  otherName: "Audrea Sanchez",
  otherEmail: "audreamarie_95@hotmail.com",
  otherOrderNumber: "4196536586",
});
assert.equal(
  msg,
  "This order was bought by Colleen Luczak, but these details are for Audrea Sanchez " +
    "(audreamarie_95@hotmail.com, also on order 4196536586). " +
    "Check you are on the right order, or choose Save anyway.",
);
assert.equal(
  buyerMismatchMessage({ receiptBuyer: "Maya Scopin", otherName: "Amanda Rinehart", otherEmail: "m@x.com", otherOrderNumber: null }),
  "This order was bought by Maya Scopin, but these details are for Amanda Rinehart (m@x.com). " +
    "Check you are on the right order, or choose Save anyway.",
);
assert.equal(
  buyerMismatchMessage({ receiptBuyer: "Maya Scopin", otherName: "Amanda Rinehart", otherEmail: null, otherOrderNumber: null }),
  "This order was bought by Maya Scopin, but these details are for Amanda Rinehart. " +
    "Check you are on the right order, or choose Save anyway.",
);
// The reply-link screen names its own override button.
const linkMsg = buyerMismatchMessage({
  receiptBuyer: "Colleen Luczak",
  otherName: "Audrea Sanchez",
  otherEmail: "audreamarie_95@hotmail.com",
  otherOrderNumber: null,
  overrideLabel: "Link anyway",
});
assert.equal(
  linkMsg,
  "This order was bought by Colleen Luczak, but these details are for Audrea Sanchez (audreamarie_95@hotmail.com). " +
    "Check you are on the right order, or choose Link anyway.",
);
for (const text of [msg, linkMsg]) {
  assert.ok(!text.includes(String.fromCharCode(0x2014)) && !text.includes(String.fromCharCode(0x2013)), "no dashes in copy");
  assert.ok(!/\b(she|her|hers|he|him|his)\b/i.test(text), "no pronouns in copy");
}

console.log("test-buyer-match passed");
