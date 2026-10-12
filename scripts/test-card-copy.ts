// The designer card's copy helpers (Jerome 2026-10-12: copy the order number,
// the personalization, the customer's requests and the QC / revision notes
// without grabbing the whole page): which options are personalization, the
// exact text a Copy press puts on the clipboard, and the QC / revision history
// read back from the card's feed. Pure, no database.
import assert from "node:assert/strict";

import { isPersonalizationOption, personalizationOf } from "../lib/orders/options-summary";
import { buildRevisionHistory, revisionCopyText, revisionNote } from "../lib/orders/revision-history";
import type { CardEvent } from "../lib/orders/card-detail";

// Option names seen on live orders (Etsy, PixArt Shopify, CPS Shopify).
for (const name of ["Personalization", "Pet Name(s)", "Personalisation/Comments", "Names", "Custom text"]) {
  assert.ok(isPersonalizationOption(name), `${name} is personalization`);
}
for (const name of [
  "Font (For Name)",
  "Number Of Pets",
  "Number Of People/Pets",
  "Upload your photo(s) here",
  "Rush Fee (12-24 Hours Digital Delivery)",
  "Need Your Order Within 72 Hours? (For Digital Portraits or Approvals *NOT SHIPPING TIME*)",
  "No. of characters (venues, people, pets, etc)",
  "Background",
  "Print On:",
  "_upload_id",
  "",
]) {
  assert.ok(!isPersonalizationOption(name), `${JSON.stringify(name)} is not personalization`);
}

// Verbatim: line breaks kept, only stray line-end spaces and blank edges go.
assert.deepEqual(
  personalizationOf([
    { name: "Number Of Pets", value: "2" },
    { name: "Personalization", value: "Our First Home \r\nCedar Falls, Iowa  \n" },
    { name: "Pet Name(s)", value: "   " },
  ]),
  [{ name: "Personalization", value: "Our First Home\nCedar Falls, Iowa" }],
);
assert.deepEqual(personalizationOf(null), []);

// Copy text: the words, then each check or issue on its own line.
assert.equal(revisionCopyText("Make the roof darker", ["Likeness", "Colours"]), "Make the roof darker\n- Likeness\n- Colours");
assert.equal(revisionCopyText(null, ["Hair not right"]), "- Hair not right");
assert.equal(revisionCopyText("  Only words ", []), "Only words");
assert.equal(revisionCopyText(null, []), "");
assert.equal(revisionNote("Wrong eye colour. Could the collar be blue?", ["Wrong eye colour"]), "Could the collar be blue?");

let seq = 0;
function ev(partial: Partial<CardEvent> & { createdAt: string }): CardEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    action: "order.in_design",
    actorId: null,
    actorName: null,
    fromState: null,
    toState: "in_design",
    body: null,
    metadata: null,
    ...partial,
  };
}

const events: CardEvent[] = [
  // First start and a resume from hold are not send-backs.
  ev({ createdAt: "2026-10-01T01:00:00Z", fromState: "ready_to_assign", actorId: "d1", actorName: "Jerome" }),
  // A QC fail: the reason and failed checks ride on the log row.
  ev({
    createdAt: "2026-10-02T01:00:00Z",
    fromState: "awaiting_qc",
    actorId: "va1",
    actorName: "Tessa",
    metadata: { edge: "awaiting_qc->in_design", reason: "Roof too light", failedItems: ["Likeness: matches the photos"], signature: "tessa" },
  }),
  ev({ createdAt: "2026-10-03T01:00:00Z", fromState: "on_hold", actorId: "va1", actorName: "Tessa" }),
  // The customer on the proof page: ticked issue repeated in front of the note, two pins.
  ev({
    createdAt: "2026-10-04T01:00:00Z",
    fromState: "awaiting_approval",
    metadata: {
      via: "proof_portal",
      revisionReason: "Wrong eye colour. Please add a hummingbird",
      revisionIssues: ["Wrong eye colour"],
      annotationCount: 2,
    },
  }),
  // A comment is not a revision note.
  ev({ createdAt: "2026-10-04T02:00:00Z", action: "comment", toState: null, body: "hi", metadata: { body: "hi" } }),
  // A send-back with nothing written: nothing to read, left out.
  ev({ createdAt: "2026-10-05T01:00:00Z", fromState: "awaiting_qc", actorId: "va1", actorName: "Tessa", metadata: { edge: "x" } }),
  // A VA passing on the customer's email as a revision.
  ev({
    createdAt: "2026-10-06T01:00:00Z",
    fromState: "complete",
    actorId: "va2",
    actorName: "Mia",
    metadata: { via: "va_created_revision", revisionReason: "Customer wants the names in gold" },
  }),
  // The agent applying the customer's email (no person).
  ev({
    createdAt: "2026-10-07T01:00:00Z",
    fromState: "awaiting_approval",
    metadata: { via: "agent_inbox", revisionReason: "Can the dog face left?" },
  }),
  // Owner's fix on an AI portrait (no person, not the customer).
  ev({
    createdAt: "2026-10-08T01:00:00Z",
    fromState: "awaiting_approval",
    metadata: { via: "owner_review_fix", revisionReason: "Softer chalk" },
  }),
];

const history = buildRevisionHistory(events);
assert.deepEqual(
  history.map((n) => [n.kind, n.who, n.note, n.items, n.pins]),
  [
    ["team", null, "Softer chalk", [], 0],
    ["customer", "The customer", "Can the dog face left?", [], 0],
    ["team", "Mia", "Customer wants the names in gold", [], 0],
    ["customer", "The customer", "Please add a hummingbird", ["Wrong eye colour"], 2],
    ["qc", "Tessa", "Roof too light", ["Likeness: matches the photos"], 0],
  ],
);
// Newest first even when the feed arrives out of order.
assert.deepEqual(
  buildRevisionHistory([...events].reverse()).map((n) => n.id),
  history.map((n) => n.id),
);
// The typed sign-off stands in when the log has no actor name.
assert.equal(
  buildRevisionHistory([
    ev({ createdAt: "2026-10-09T01:00:00Z", fromState: "awaiting_qc", metadata: { reason: "Eyes", signature: "Ana" } }),
  ])[0].who,
  "Ana",
);
assert.deepEqual(buildRevisionHistory([]), []);

console.log("test:card-copy OK");
