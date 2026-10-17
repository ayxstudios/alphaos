// Invoiced add-ons (lib/agent/invoice-addons.ts, Yousif 2026-10-17): pure rules
// only, no database. A paid custom invoice the agent made rides on the order it
// adds to, never a new portrait.
import assert from "node:assert/strict";

import { hintFromRow, pickInvoiceHint, receiptListingIds, type InvoiceHint } from "../lib/agent/invoice-addons";
import { INVOICE_ADDON_OWNED_DAYS, ownerOf, type OrderFacts } from "../lib/agent/limbo";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok ${name}`);
}

const DAY = 24 * 3_600_000;
const now = new Date("2026-10-17T08:00:00Z");

const row = (over: Record<string, unknown>, at = now, orderId: string | null = "parent-1") => ({
  id: `a-${Math.random().toString(36).slice(2)}`,
  orderId,
  createdAt: at,
  metadata: {
    hintKey: "etsy:4596774861",
    match: "listing",
    listingId: "4596774861",
    lineTitle: "Upgrade to an 8x10 poster in a light wood frame (instead of the 8x10 canvas)",
    email: null,
    parentReceiptId: "4184285432",
    what: "Upgrade to an 8x10 poster in a light wood frame (instead of the 8x10 canvas)",
    physical: true,
    kind: "addon",
    ...over,
  },
});
const hint = (over: Record<string, unknown> = {}, at = now, orderId: string | null = "parent-1") => hintFromRow(row(over, at, orderId)) as InvoiceHint;

test("an Etsy hint reads back from its activity row", () => {
  const h = hint();
  assert.equal(h.match, "listing");
  assert.equal(h.listingId, "4596774861");
  assert.equal(h.parentReceiptId, "4184285432");
  assert.equal(h.parentOrderId, "parent-1");
  assert.equal(h.kind, "addon");
  assert.equal(h.physical, true);
});

test("a row with no hint key, match or receipt is not a hint", () => {
  assert.equal(hintFromRow(row({ hintKey: null })), null);
  assert.equal(hintFromRow(row({ match: "title" })), null);
  assert.equal(hintFromRow(row({ parentReceiptId: "" })), null);
});

test("a receipt id with a leading # is the same receipt", () => {
  assert.equal(hint({ parentReceiptId: "#4184285432" }).parentReceiptId, "4184285432");
});

test("listing ids come off the stored Etsy receipt, numbers or strings", () => {
  assert.deepEqual(receiptListingIds({ transactions: [{ listing_id: 4596774861 }, { listing_id: "12" }, {}] }), ["4596774861", "12"]);
  assert.deepEqual(receiptListingIds(null), []);
  assert.deepEqual(receiptListingIds({ transactions: "x" }), []);
});

test("Jennifer's paid upgrade matches its invoice by listing id", () => {
  const h = hint();
  const got = pickInvoiceHint({ listingIds: ["4596774861"], lineTitles: ["Upgrade to an 8x10 poster"], email: null }, [h]);
  assert.equal(got?.hintKey, "etsy:4596774861");
});

test("a normal Etsy order (another listing) never matches", () => {
  assert.equal(pickInvoiceHint({ listingIds: ["1231801819"], lineTitles: ["Watercolor People Portrait"], email: "a@b.com" }, [hint()]), null);
});

test("the same title alone never matches an Etsy invoice (the listing id is the key)", () => {
  const h = hint();
  assert.equal(pickInvoiceHint({ listingIds: ["999"], lineTitles: [String(h.lineTitle)], email: null }, [h]), null);
});

test("a Shopify invoice needs the line title AND the buyer's email", () => {
  const h = hint({ hintKey: "shopify:111", match: "title+email", listingId: null, lineTitle: "Poster print  8x10", email: "Ann@Example.com" });
  assert.equal(pickInvoiceHint({ listingIds: [], lineTitles: ["poster print 8x10"], email: "ann@example.com " }, [h])?.hintKey, "shopify:111");
  assert.equal(pickInvoiceHint({ listingIds: [], lineTitles: ["poster print 8x10"], email: "bob@example.com" }, [h]), null);
  assert.equal(pickInvoiceHint({ listingIds: [], lineTitles: ["poster print 8x10"], email: null }, [h]), null);
  assert.equal(pickInvoiceHint({ listingIds: [], lineTitles: ["canvas 8x10"], email: "ann@example.com" }, [h]), null);
});

test("a new piece invoiced on her order is normal intake, never linked", () => {
  const h = hint({ kind: "new", what: "A second custom portrait of her dog" });
  assert.equal(pickInvoiceHint({ listingIds: ["4596774861"], lineTitles: [], email: null }, [h]), null);
});

test("the newest matching hint wins", () => {
  const older = hint({ kind: "addon" }, new Date(now.getTime() - 3 * DAY), "old-parent");
  const newer = hint({ kind: "addon" }, now, "new-parent");
  assert.equal(pickInvoiceHint({ listingIds: ["4596774861"], lineTitles: [], email: null }, [older, newer])?.parentOrderId, "new-parent");
  const newerNew = hint({ kind: "new" }, now);
  assert.equal(pickInvoiceHint({ listingIds: ["4596774861"], lineTitles: [], email: null }, [older, newerNew]), null);
});

const facts = (over: Partial<OrderFacts>): OrderFacts => ({
  id: "o1",
  number: "4202590183",
  status: "fulfillment_only",
  needsReview: false,
  inScope: true,
  enteredAt: new Date(now.getTime() - 3 * DAY),
  activeAssignment: false,
  aiFailedHold: false,
  hasContact: true,
  lastChaseAt: null,
  parentLive: false,
  openKinds: [],
  style: null,
  ...over,
});

test("a linked invoice add-on whose order is finished and archived is the print road's", () => {
  const o = ownerOf(facts({ invoiceLinkedAt: new Date(now.getTime() - 2 * DAY) }), now);
  assert.equal(o.bucket, "pipeline");
});

test("still not printed after the window, it is limbo again with a plain reason", () => {
  const o = ownerOf(facts({ invoiceLinkedAt: new Date(now.getTime() - (INVOICE_ADDON_OWNED_DAYS + 1) * DAY) }), now);
  assert.equal(o.bucket, "limbo");
  assert.equal(o.why, "invoiced add-on still not printed");
});

test("an add-on with a live portrait order stays owned without an invoice", () => {
  assert.equal(ownerOf(facts({ parentLive: true }), now).bucket, "pipeline");
  const orphan = ownerOf(facts({}), now);
  assert.equal(orphan.bucket, "limbo");
  assert.equal(orphan.why, "add-on with no portrait order");
});

console.log(`\n${passed} invoice add-on tests passed`);
