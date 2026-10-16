import assert from "node:assert/strict";
import {
  MENTION_ACTION,
  buyerOrdersForReply,
  mentionNoteMetadata,
  namedOrdersAdvice,
  orderNumbersPhrase,
  type ContextRunner,
} from "../lib/agent/buyer-orders";
import { activityDetail, activityLabel } from "../lib/orders/activity-label";
import {
  BUYER_ORDERS_RULE,
  buyerOrdersPromptBlock,
  buyerUserIdOf,
  designerSafeSiblings,
  detectMentionedOrders,
  giftRecipient,
  isDeliveredLike,
  mergeSiblings,
  orderNumberKey,
  orderNumberOf,
  orderNumbersMentioned,
  productLineOf,
  sameBuyerSentence,
  shipToName,
  siblingLink,
  siblingsFromNote,
  type BuyerAnchor,
  type CandidateIdentity,
  type SameBuyerContext,
  type SameBuyerOrder,
} from "../lib/orders/same-buyer";

// Pure checks only: no database, no network. The query itself is exercised by
// the read-only real-data check, not here.

// ---------------------------------------------------------------------------
// Order numbers
// ---------------------------------------------------------------------------
assert.equal(orderNumberOf({ platformOrderName: "PC32132", platformOrderId: "legacy-PC32132" }), "PC32132", "the shop's name wins");
assert.equal(orderNumberOf({ platformOrderName: "  #CPS10282 ", platformOrderId: "x" }), "#CPS10282", "trimmed");
assert.equal(orderNumberOf({ platformOrderName: "   ", platformOrderId: "4201339918" }), "4201339918", "blank name falls back to the platform id");
assert.equal(orderNumberOf({ platformOrderName: null, platformOrderId: "4201339918" }), "4201339918");

assert.equal(orderNumberKey("#cps10282"), "CPS10282");
assert.equal(orderNumberKey("#CPS10282"), orderNumberKey("CPS10282"), "the leading # does not matter");
assert.equal(orderNumberKey("LEGACY-3933552614-B"), "3933552614", "legacy prefix and suffix are stripped");
assert.equal(orderNumberKey(" pc32132 "), "PC32132");
assert.equal(orderNumberKey("4201339918"), "4201339918");

assert.ok(isDeliveredLike("approved") && isDeliveredLike("shipped") && isDeliveredLike("complete"));
assert.ok(!isDeliveredLike("in_design") && !isDeliveredLike("awaiting_approval") && !isDeliveredLike(null));

assert.equal(buyerUserIdOf(" 123456 "), "123456");
assert.equal(buyerUserIdOf(987), "987");
assert.equal(buyerUserIdOf("0"), null, "0 is not a buyer");
assert.equal(buyerUserIdOf("null"), null);
assert.equal(buyerUserIdOf(""), null);
assert.equal(buyerUserIdOf(undefined), null);

// ---------------------------------------------------------------------------
// Notes mentions: the 16 Oct 2026 incident
// ---------------------------------------------------------------------------
const incidentNotes =
  "SAIYA ALONE, PORTRAIT ORIENTATION (taller than wide, 16x20 canvas). Same customer also bought PC32131 = Parker & Saiya together, landscape, already delivered: never upload or send that file for this order.\n\nURGENT REDO (owner order 14 Oct). Daniel Lamont's canvas PC32132 shows a Saiya that does not match the Saiya in Julie's PC32131 canvas.";
const incident = orderNumbersMentioned(incidentNotes, "PC32132");
assert.equal(incident.length, 1, "PC32131 found once, the order's own PC32132 left out");
assert.equal(incident[0].number, "PC32131");
assert.equal(incident[0].key, "PC32131");
assert.equal(incident[0].shape, "pc");
assert.equal(incident[0].strong, true, "a PC number is certain even with no order in AlphaOS");
assert.equal(incident[0].hint, "Parker & Saiya together, landscape, already delivered");
assert.ok(!orderNumbersMentioned(incidentNotes, "PC32131").some((m) => m.number === "PC32131"), "an order is never its own sibling");

assert.deepEqual(orderNumbersMentioned("see 3933552614 for the first one", "LEGACY-3933552614-B"), [], "the receipt inside the own legacy number is the own order");
assert.deepEqual(orderNumbersMentioned("", "PC1"), []);
assert.deepEqual(orderNumbersMentioned(null, "PC1"), []);

const cps = orderNumbersMentioned("Buyer also has #cps10282 and CPS10282 again", "#CPS10314");
assert.equal(cps.length, 1, "the same number twice is one mention");
assert.equal(cps[0].number, "#CPS10282");
assert.equal(cps[0].shape, "cps");
assert.equal(cps[0].strong, true);
assert.deepEqual(orderNumbersMentioned("they ordered #CPS10314", "#CPS10314"), [], "own CPS number left out whatever the #");

const weak = orderNumbersMentioned("Etsy convo 1727484289 and receipt 4201339918", "4201353202");
assert.equal(weak.length, 2);
assert.ok(weak.every((m) => !m.strong), "10 digits with no cue word are not certain");
const cue = orderNumbersMentioned("Same customer also bought 4201339918, thread 1727484289", "4201353202");
assert.equal(cue.find((m) => m.number === "4201339918")?.strong, true, "a cue word makes an Etsy receipt certain");
assert.equal(cue.find((m) => m.number === "1727484289")?.strong, false, "a 17xxxxxxxx conversation id is never certain");
assert.equal(cue.find((m) => m.number === "1727484289")?.shape, "other");

assert.deepEqual(orderNumbersMentioned("ref 12345678901 and AB4201339918 and 4201339918x", "PC1"), [], "longer runs and glued letters are not order numbers");
assert.deepEqual(orderNumbersMentioned("CPS 10282 with a space", "PC1"), [], "no whitespace inside a number");

// Hints are plain words only: never an address, a phone or a link.
assert.equal(orderNumbersMentioned("also PC32131 = julie@example.com", "PC32132")[0].hint, null, "email never becomes a hint");
assert.equal(orderNumbersMentioned("also PC32131 = call 0412345678 please", "PC32132")[0].hint, null, "phone digits never become a hint");
assert.equal(orderNumbersMentioned("also PC32131 (see https://x.example/y)", "PC32132")[0].hint, null, "links never become a hint");
assert.equal(orderNumbersMentioned("also PC32131 - two dogs, landscape. Then more.", "PC32132")[0].hint, "two dogs, landscape");
assert.equal(orderNumbersMentioned("also PC32131 and something else", "PC32132")[0].hint, null, "no separator, no hint");

// ---------------------------------------------------------------------------
// Ship-to: only a gift shows
// ---------------------------------------------------------------------------
assert.equal(shipToName({ name: " Daniel  Lamont ", firstName: null, lastName: null }), "Daniel Lamont");
assert.equal(shipToName({ name: null, firstName: "Daniel", lastName: "Lamont" }), "Daniel Lamont", "first and last when there is no full name");
assert.equal(shipToName({ name: "", firstName: " ", lastName: null }), null);
assert.equal(shipToName(null), null);

const julie = { firstName: "Julie", lastName: "Shantz" };
assert.equal(giftRecipient(julie, { name: null, firstName: "Daniel", lastName: "Lamont" }), "Daniel Lamont", "the incident: shipping to Daniel Lamont is a gift");
assert.equal(giftRecipient(julie, { name: "Julie Shantz", firstName: null, lastName: null }), null, "shipping to the buyer is not a gift");
assert.equal(giftRecipient(julie, { name: "julie  SHANTZ", firstName: null, lastName: null }), null, "case and spaces ignored");
assert.equal(giftRecipient(julie, { name: "Julie A. Shantz", firstName: null, lastName: null }), null, "a middle name does not make a gift");
assert.equal(giftRecipient({ firstName: "Jose", lastName: "Perez" }, { name: "Jos\u00e9 P\u00e9rez", firstName: null, lastName: null }), null, "accents ignored");
assert.equal(giftRecipient(julie, { name: "Julie Smith", firstName: null, lastName: null }), "Julie Smith", "same first name, different surname is a gift");
assert.equal(giftRecipient({ firstName: "Julie", lastName: null }, { name: "Julie Shantz", firstName: null, lastName: null }), null, "buyer with no surname: same first name is the buyer");
assert.equal(giftRecipient(julie, { name: null, firstName: null, lastName: null }), null, "no ship-to name");
assert.equal(giftRecipient({ firstName: null, lastName: null }, { name: "Daniel Lamont", firstName: null, lastName: null }), null, "unknown buyer name: cannot call it a gift");
assert.equal(giftRecipient(null, { name: "Daniel Lamont", firstName: null, lastName: null }), null);

// ---------------------------------------------------------------------------
// Product line
// ---------------------------------------------------------------------------
const cartoon = "Custom Hand-Drawn Cartoon Pet Portrait";
assert.equal(
  productLineOf([{ title: cartoon, options: null, figureCount: 1, style: "cartoon" }]),
  `${cartoon} \u00b7 1 pet`,
  "PC32132's own line: style is already in the title, so it is not repeated",
);
assert.equal(
  productLineOf([
    {
      title: cartoon,
      options: [
        { name: "Number of Pets:", value: "1" },
        { name: "Print On:", value: 'Canvas 16"X20" / 40X50cm' },
        { name: "Need Your Order Within 72 Hours? (For Digital Portraits or Approvals *NOT SHIPPING TIME*)", value: "No Thanks" },
        { name: "Background", value: "Light Blue" },
        { name: "Pet Name(s)", value: "Chewy" },
      ],
      figureCount: 1,
      style: "cartoon",
    },
  ]),
  `${cartoon} \u00b7 Canvas 16"X20" / 40X50cm \u00b7 1 pet: Chewy`,
  "PixArt option names: Print On is the size, Pet Name(s) the names",
);
assert.equal(
  productLineOf([
    {
      title: "Frame | Custom Hand-Drawn Cartoon Pet Portrait",
      options: [
        { name: "Number of Pets:", value: "2" },
        { name: "Size:", value: 'Black Frame  16"X20" / 40X50cm' },
        { name: "Pet Name(s)", value: "Addie & Nemo" },
      ],
      figureCount: 2,
      style: "cartoon",
    },
  ]),
  `${cartoon} \u00b7 Black Frame 16"X20" / 40X50cm \u00b7 2 pets: Addie & Nemo`,
  "a short 'Frame' prefix is skipped; two pets are plural with names",
);
assert.equal(
  productLineOf([
    {
      title: "Custom Cartoon Pet Portrait | Cat, Dog, Horse, Rabbit Portrait From Photo | Cartoon Style | Custom Gift | Digital Prints | Illustration Art",
      options: [
        { name: "Number of Pets", value: "1" },
        { name: "Background", value: "Navy" },
        { name: "Personalization", value: "1. Friday 2. Male 3. I think I want the mouth open." },
      ],
      figureCount: 1,
      style: "cartoon",
    },
  ]),
  "Custom Cartoon Pet Portrait \u00b7 1 pet",
  "a long Etsy title is cut to its first segment and free-text personalization never leaks in",
);
assert.equal(
  productLineOf([{ title: "Mug", options: [{ name: "Mug Size", value: "11 oz" }], figureCount: 1, style: null }]),
  "Mug \u00b7 11 oz \u00b7 1 figure",
);
assert.equal(productLineOf([{ title: null, options: null, figureCount: 1, style: null }]), "Portrait \u00b7 1 figure", "no title still reads");
assert.equal(
  productLineOf([{ title: cartoon, options: [{ name: "Number of Pets", value: "3" }], figureCount: null, style: null }]),
  `${cartoon} \u00b7 3 pets`,
  "falls back to the Number of Pets option",
);
assert.equal(
  productLineOf([{ title: "Family Portrait", options: [{ name: "Orientation", value: "Landscape layout" }], figureCount: 4, style: "watercolor" }]),
  "Family Portrait \u00b7 Watercolor \u00b7 landscape \u00b7 4 figures",
  "orientation only when an option carries it",
);
assert.equal(productLineOf([{ title: cartoon, options: null, figureCount: 1, style: "cartoon", quantity: 2 }]), `${cartoon} \u00b7 1 pet x2`);
assert.equal(productLineOf([]), "", "no lines, no product line");

// CPS: the option "Number Of Figures/Pets" is on every CPS listing, so the style decides the noun (real #CPS10282).
assert.equal(
  productLineOf([
    {
      title: "Watercolor Hand Drawn Custom Portrait",
      options: [
        { name: "Print on", value: 'Canvas 8"X10"/ 20X25cm' },
        { name: "Number Of Figures/Pets", value: "6+" },
        { name: "Personalisation/Comments", value: "I need to add a baby boy to the left" },
      ],
      figureCount: 6,
      style: "Watercolor People",
    },
  ]),
  'Watercolor Hand Drawn Custom Portrait \u00b7 Canvas 8"X10"/ 20X25cm \u00b7 Watercolor People \u00b7 6 figures',
  "a People style with a shared Figures/Pets option is figures, and the free-text comments never leak in",
);
assert.equal(
  productLineOf([{ title: "Watercolor Hand Drawn Custom Portrait", options: [{ name: "Number Of Figures/Pets", value: "2" }], figureCount: null, style: null }]),
  "Watercolor Hand Drawn Custom Portrait \u00b7 2 figures",
  "the Figures/Pets count is read from the option when no figure count is stored",
);
assert.equal(
  productLineOf([{ title: "Watercolor Hand Drawn Custom Portrait", options: [{ name: "Number Of Figures/Pets", value: "2" }], figureCount: 2, style: "Watercolor Pets" }]),
  "Watercolor Hand Drawn Custom Portrait \u00b7 Watercolor Pets \u00b7 2 pets",
  "a Pets style is pets",
);
// Perfetta: a house sketch has no count and the rush-fee option is not part of the product.
assert.equal(
  productLineOf([
    {
      title: "Minimalist Watercolour Sketch of Your Home | Personalized Digital House Artwork. Custom Th",
      options: [
        { name: "Rush Fee (12-24 Hours Digital Delivery)", value: "No" },
        { name: "Options", value: "House (With Yard)" },
      ],
      figureCount: null,
      style: "Perfetta Watercolor House",
    },
  ]),
  "Minimalist Watercolour Sketch of Your Home \u00b7 Perfetta Watercolor House",
  "no count means no count text",
);

const addOn = productLineOf([
  { title: cartoon, options: [{ name: "Print On:", value: 'Canvas 8"X10" / 20X25cm' }], figureCount: 1, style: "cartoon" },
  { title: "Add On - Print & Ship | Get Your Portrait Printed and Shipped", options: null, figureCount: null, style: null },
]);
assert.equal(addOn, `${cartoon} \u00b7 Canvas 8"X10" / 20X25cm \u00b7 1 pet`, "the print & ship add-on line is left out");

const many = productLineOf([
  { title: "Portrait A", options: null, figureCount: 1, style: null },
  { title: "Portrait B", options: null, figureCount: 1, style: null },
  { title: "Portrait C", options: null, figureCount: 1, style: null },
  { title: "Portrait D", options: null, figureCount: 1, style: null },
]);
assert.match(many, /Portrait A .* \+ Portrait B .* \+ 2 more$/, "two lines then '+ N more'");

// ---------------------------------------------------------------------------
// The one sentence
// ---------------------------------------------------------------------------
const thisOrder = { number: "PC32132", productLine: "Saiya alone, portrait 16x20 canvas" };
assert.equal(sameBuyerSentence(thisOrder, []), null, "no other orders, no sentence");
assert.equal(
  sameBuyerSentence(thisOrder, [{ number: "PC32131", productLine: "Parker & Saiya together, landscape", status: "delivered" }]),
  "This customer also ordered PC32131 (Parker & Saiya together, landscape, already delivered). This order is PC32132: Saiya alone, portrait 16x20 canvas. Keep them separate and never upload or send another order's file.",
);
assert.equal(
  sameBuyerSentence(thisOrder, [{ number: "PC32131", productLine: null, noteHint: "Parker & Saiya together, landscape, already delivered" }]),
  "This customer also ordered PC32131 (Parker & Saiya together, landscape, already delivered). This order is PC32132: Saiya alone, portrait 16x20 canvas. Keep them separate and never upload or send another order's file.",
  "an order only the notes name reads the same, and 'already delivered' is not said twice",
);
assert.equal(
  sameBuyerSentence({ number: "PC32132", productLine: null }, [{ number: "PC1", productLine: null }]),
  "This customer also ordered PC1. This order is PC32132. Keep them separate and never upload or send another order's file.",
  "nothing known about either product: numbers only",
);
const three = sameBuyerSentence(thisOrder, [
  { number: "A1", productLine: "One", status: "in_design" },
  { number: "B2", productLine: "Two", status: "in_design" },
  { number: "C3", productLine: "Three", status: "in_design" },
]);
assert.match(three ?? "", /^This customer also ordered A1 \(One\), B2 \(Two\) and C3 \(Three\)\./);
const five = sameBuyerSentence(thisOrder, [1, 2, 3, 4, 5].map((n) => ({ number: `X${n}`, productLine: `P${n}`, status: "in_design" })));
assert.match(five ?? "", /^This customer also ordered X1 \(P1\), X2 \(P2\), X3 \(P3\) and 2 more\./, "more than three: first three and a count");
assert.doesNotMatch(five ?? "", /[\u2013\u2014]/, "no dash characters in the sentence");
assert.doesNotMatch(BUYER_ORDERS_RULE, /[\u2013\u2014]/, "no dash characters in the rule");

// ---------------------------------------------------------------------------
// Designer-safe projection
// ---------------------------------------------------------------------------
const sibling = (over: Partial<SameBuyerOrder>): SameBuyerOrder => ({
  id: "11111111-1111-4111-8111-111111111111",
  number: "PC32131",
  status: "delivered",
  stage: "Delivered",
  productLine: "Parker & Saiya together, landscape",
  shipTo: "Daniel Lamont",
  placedAt: new Date("2026-10-01T00:00:00Z"),
  artworkAssetId: "22222222-2222-4222-8222-222222222222",
  artwork: { id: "22222222-2222-4222-8222-222222222222", storage: "r2", url: null, r2Key: "private/key.png" },
  linkedBy: "buyer",
  noteHint: null,
  ...over,
});
const safe = designerSafeSiblings([
  sibling({}),
  sibling({ id: null, number: "PC30000", status: null, stage: "Not in AlphaOS", productLine: null, shipTo: null, artwork: null, artworkAssetId: null, notInAlphaOS: true, linkedBy: "notes", noteHint: "two dogs, landscape" }),
  sibling({ number: "PC30001", status: "cancelled", stage: "Cancelled" }),
  sibling({ number: "PC30002", status: "in_design", stage: "In design", productLine: "mail julie@example.com about it" }),
]);
assert.deepEqual(
  safe.map((s) => s.number),
  ["PC32131", "PC30000", "PC30002"],
  "a cancelled sibling is not shown to a designer",
);
assert.deepEqual(safe[0], { number: "PC32131", productLine: "Parker & Saiya together, landscape", delivered: true, noteHint: null });
assert.equal(safe[1].delivered, false);
assert.equal(safe[1].noteHint, "two dogs, landscape", "an order only the notes name keeps its hint");
assert.equal(safe[2].productLine, null, "text with an email in it is dropped");
const safeJson = JSON.stringify(safe);
assert.doesNotMatch(safeJson, /Lamont|Daniel|Shantz|@|example\.com|private\/key/, "no ship-to name, surname, email or file key reaches a designer");
for (const s of safe) assert.deepEqual(Object.keys(s).sort(), ["delivered", "noteHint", "number", "productLine"], "only these four fields");
assert.doesNotMatch(
  sameBuyerSentence(thisOrder, safe) ?? "",
  /Lamont|Daniel|Shantz|@|Not in AlphaOS/i,
  "the designer sentence never says an order is missing from AlphaOS and never names the recipient",
);

// What a persisted designer note round-trips to.
assert.deepEqual(siblingsFromNote({ sentence: "x", siblings: safe }).map((s) => s.number), ["PC32131", "PC30000", "PC30002"]);
assert.deepEqual(siblingsFromNote({ siblings: [{ number: "" }, null, 5, { number: "PC1", delivered: true }] }), [{ number: "PC1", productLine: null, delivered: true, noteHint: null }]);
assert.deepEqual(siblingsFromNote(null), []);
assert.deepEqual(siblingsFromNote({ siblings: "nope" }), []);

assert.deepEqual(
  mergeSiblings(
    [{ number: "PC32131", productLine: "first", delivered: true }],
    [{ number: "pc32131", productLine: "second", delivered: false }, { number: "#CPS1000", productLine: null, delivered: false }],
  ).map((s) => `${s.number}:${s.productLine}`),
  ["PC32131:first", "#CPS1000:null"],
  "merged by number, the first list wins",
);

// ---------------------------------------------------------------------------
// Who counts as the same buyer
// ---------------------------------------------------------------------------
const anchor: BuyerAnchor = {
  id: "a",
  businessId: "biz",
  number: "PC32132",
  customerId: "cust-1",
  notes: incidentNotes,
  emailKey: "julie@example.com",
  buyerUserId: "777",
};
const row = (over: Partial<CandidateIdentity>): CandidateIdentity => ({
  id: "b",
  businessId: "biz",
  customerId: null,
  emailKey: null,
  buyerUserId: null,
  key: "OTHER1",
  ...over,
});
const keys = new Set(["PC32131"]);
assert.equal(siblingLink(anchor, row({ customerId: "cust-1" }), keys), "buyer", "same customer row");
assert.equal(siblingLink(anchor, row({ emailKey: "julie@example.com" }), keys), "buyer", "same email");
assert.equal(siblingLink(anchor, row({ buyerUserId: "777" }), keys), "buyer", "same Etsy buyer id");
assert.equal(siblingLink(anchor, row({ key: "PC32131" }), keys), "notes", "named in the notes");
assert.equal(siblingLink(anchor, row({ customerId: "cust-1", key: "PC32131" }), keys), "buyer", "buyer wins over notes");
assert.equal(siblingLink(anchor, row({ customerId: "cust-2" }), keys), null, "another customer");
assert.equal(siblingLink(anchor, row({ businessId: "other-biz", customerId: "cust-1" }), keys), null, "never across businesses");
assert.equal(siblingLink(anchor, row({ id: "a", customerId: "cust-1" }), keys), null, "the order is not its own sibling");
assert.equal(siblingLink({ ...anchor, customerId: null, emailKey: null, buyerUserId: null }, row({ customerId: null, emailKey: null, buyerUserId: null }), new Set()), null, "empty identities never match each other");
assert.equal(siblingLink({ ...anchor, buyerUserId: "0" }, row({ buyerUserId: "0" }), new Set()), null, "buyer id 0 is not an identity");
assert.equal(siblingLink({ ...anchor, buyerUserId: "null" }, row({ buyerUserId: "null" }), new Set()), null, "buyer id 'null' is not an identity");
assert.equal(siblingLink({ ...anchor, emailKey: "" }, row({ emailKey: "" }), new Set()), null, "blank email is not an identity");

// ---------------------------------------------------------------------------
// The reply agent
// ---------------------------------------------------------------------------
assert.equal(buyerOrdersPromptBlock({ number: "PC32132", productLine: "x" }, []), "", "no other orders, nothing added to the prompt");
const block = buyerOrdersPromptBlock({ number: "PC32132", productLine: "Saiya alone, portrait 16x20 canvas", stage: "In design" }, [
  sibling({ number: "PC32131", stage: "Delivered", shipTo: "Daniel Lamont" }),
  sibling({ id: null, number: "PC30000", status: null, stage: "Not in AlphaOS", productLine: null, shipTo: null, notInAlphaOS: true, linkedBy: "notes", noteHint: "two dogs" }),
]);
assert.ok(block.includes(BUYER_ORDERS_RULE), "the rule is in the block");
assert.ok(block.includes("PC32132 (this email's order): Saiya alone, portrait 16x20 canvas; stage: In design"));
assert.ok(block.includes("PC32131: Parker & Saiya together, landscape; stage: Delivered"));
assert.ok(block.includes("PC30000: two dogs; stage: not in our system, mentioned in the notes"));
assert.doesNotMatch(block, /Lamont|Daniel|@/, "no recipient name or email in the prompt");
assert.doesNotMatch(block, /[\u2013\u2014]/, "no dash characters in the prompt");
assert.match(BUYER_ORDERS_RULE, /^This buyer has more than one order\. An email on one order's thread can be about another\./);
assert.match(BUYER_ORDERS_RULE, /never answer about one order with another's status, file or proof/);
assert.match(BUYER_ORDERS_RULE, /the team will check that order and confirm\.$/);

const others = [sibling({ number: "PC32131" }), sibling({ id: null, number: "PC30000", notInAlphaOS: true, status: null, productLine: null }), sibling({ id: "33333333-3333-4333-8333-333333333333", number: "#CPS10282", status: "awaiting_qc" })];
assert.deepEqual(
  detectMentionedOrders("Hi, is pc32131 still coming? Also what about #CPS10282 and PC30000", others).map((o) => o.number),
  ["PC32131", "#CPS10282"],
  "orders the text names that AlphaOS has; an order only the notes name has no row to write to",
);
assert.deepEqual(detectMentionedOrders("thanks, looks great!", others), []);
assert.deepEqual(detectMentionedOrders("PC32131", []), []);

// What a person reads and what the timeline row carries.
assert.equal(orderNumbersPhrase([]), "");
assert.equal(orderNumbersPhrase(["PC32131"]), "PC32131");
assert.equal(orderNumbersPhrase(["PC32131", "#CPS10282"]), "PC32131 and #CPS10282");
assert.equal(orderNumbersPhrase(["A1", "B2", "C3"]), "A1, B2 and C3");
assert.equal(
  namedOrdersAdvice([sibling({ number: "PC32131" })]),
  "The reply names PC32131, another order of this buyer. Check which order and product they mean before answering or approving.",
);
assert.match(namedOrdersAdvice([sibling({ number: "A1" }), sibling({ number: "B2" })]), /^The reply names A1 and B2, another order of this buyer\./);
assert.doesNotMatch(namedOrdersAdvice([sibling({ number: "PC32131" })]), /[\u2013\u2014]/, "no dash characters in the exception text");

assert.equal(MENTION_ACTION, "message.received", "the existing timeline entry for a message, no new action key");
assert.equal(activityLabel(MENTION_ACTION), "Message received", "the label already exists, so the row never reads as a raw key");
assert.deepEqual(mentionNoteMetadata({ id: "order-a", number: "PC32132" }, "msg-1"), {
  linkedBy: "mention",
  fromOrderId: "order-a",
  fromOrderNumber: "PC32132",
  messageId: "msg-1",
});
assert.equal(
  activityDetail(MENTION_ACTION, mentionNoteMetadata({ id: "order-a", number: "PC32132" }, "msg-1")),
  "A reply on PC32132 names this order. Check which order they mean.",
);
assert.equal(
  activityDetail(MENTION_ACTION, { linkedBy: "mention", fromOrderNumber: "   " }),
  "A reply on another order of this buyer names this order. Check which order they mean.",
  "a blank source number still reads",
);
assert.equal(activityDetail(MENTION_ACTION, { linkedBy: "thread" }), null, "an ordinary message row gets no extra line");
assert.equal(activityDetail(MENTION_ACTION, null), null);
assert.equal(activityDetail(MENTION_ACTION, undefined), null);
assert.equal(activityDetail("comment", { linkedBy: "mention", fromOrderNumber: "PC1" }), null, "only the message row");

// buyerOrdersForReply: a fake database context and a fake loader, so no connection is made.
const fakeTx = {} as Parameters<Parameters<ContextRunner>[0]>[0];
const run: ContextRunner = (fn) => fn(fakeTx);
const summary = { id: "order-a", number: "PC32132", stage: "In design", status: "in_design", productLine: "Saiya alone, portrait 16x20 canvas", shipToName: "Daniel Lamont" };
const asked: { orderId: string; opts: unknown }[] = [];
const loadWith = (context: SameBuyerContext | null) => async (_tx: unknown, orderId: string, opts?: unknown) => {
  asked.push({ orderId, opts });
  return context;
};
async function checkBuyerOrdersForReply() {
  const withSibling = await buyerOrdersForReply(run, "order-a", loadWith({ thisOrder: summary, others: [sibling({ number: "PC32131", stage: "Delivered" })] }));
  assert.ok(withSibling, "a buyer with another order gets a block");
  assert.ok(withSibling.block.includes(BUYER_ORDERS_RULE), "the rule is in the block");
  assert.ok(withSibling.block.includes("PC32132 (this email's order): Saiya alone, portrait 16x20 canvas; stage: In design"));
  assert.ok(withSibling.block.includes("PC32131: Parker & Saiya together, landscape; stage: Delivered"));
  assert.doesNotMatch(withSibling.block, /Lamont|Daniel|@/, "the recipient's name never reaches the prompt");
  assert.equal(withSibling.context.others[0].number, "PC32131");
  assert.deepEqual(asked[0], { orderId: "order-a", opts: { staff: true, artwork: false } }, "no artwork keys are read for a prompt");

  assert.equal(await buyerOrdersForReply(run, "order-a", loadWith({ thisOrder: summary, others: [] })), null, "no other order, the prompts stay exactly as they were");
  assert.equal(await buyerOrdersForReply(run, "order-a", loadWith(null)), null, "an order that cannot be read adds nothing");

  const warned: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  let failed: Awaited<ReturnType<typeof buyerOrdersForReply>> = undefined as never;
  try {
    failed = await buyerOrdersForReply(run, "order-a", async () => {
      throw new Error("connection reset");
    });
  } finally {
    console.log = realLog;
  }
  assert.equal(failed, null, "a failed lookup returns no block and never throws, so a reply is never held up by it");
  assert.equal(warned.length, 1);
  assert.match(warned[0], /"event":"reply_same_buyer_failed"/);
  assert.match(warned[0], /connection reset/);
}

checkBuyerOrdersForReply()
  .then(() => console.log("test-same-buyer: ok"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
