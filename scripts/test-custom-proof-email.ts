import assert from "node:assert/strict";

import { renderTemplate, withSignOff } from "../lib/email/templates";
import {
  CUSTOM_PROOF_CLEARED,
  CUSTOM_PROOF_SET,
  type CustomProofRow,
  type ProofMessageRow,
  parseCustomProofEmail,
  pickCustomProofEmail,
} from "../lib/qc/custom-proof-email";

const at = (iso: string) => new Date(iso);
const BODY = "Hi {{first_name}},\n\nWe are so sorry.\n\nHere they are: {{proof_link}}\n\n{{sign_off}}";
const meta = { subject: "#PC1 - redrawn for you", body: BODY, why: "upset customer, full redraw" };
const set: CustomProofRow = { action: CUSTOM_PROOF_SET, metadata: meta, createdAt: at("2026-11-11T04:00:00Z") };
const after = (status: string, templateKey: string | null): ProofMessageRow => ({ createdAt: at("2026-11-12T04:00:00Z"), status, templateKey });

function main() {
  // Parsing: a subject and a body that still links the proof, or nothing.
  assert.deepEqual(parseCustomProofEmail(meta), { subject: meta.subject, body: BODY, why: meta.why });
  assert.equal(parseCustomProofEmail({ ...meta, why: undefined })?.why, null);
  assert.equal(parseCustomProofEmail({ ...meta, body: "Sorry, no link" }), null, "no {{proof_link}} = the template goes");
  assert.equal(parseCustomProofEmail({ ...meta, subject: "   " }), null);
  assert.equal(parseCustomProofEmail({ ...meta, subject: "two\nlines" }), null);
  assert.equal(parseCustomProofEmail(null), null);
  assert.equal(parseCustomProofEmail("text"), null);

  // Picking: the newest set/clear row decides.
  assert.equal(pickCustomProofEmail([], []), null, "nothing set = the template");
  assert.equal(pickCustomProofEmail([set], [])?.subject, meta.subject, "set and not sent yet = these words");
  const old: ProofMessageRow = { createdAt: at("2026-10-24T00:00:00Z"), status: "sent", templateKey: "proof_ready_physical_multi" };
  assert.ok(pickCustomProofEmail([set], [old]), "the first proof, before it was set, does not spend it");
  assert.equal(pickCustomProofEmail([set], [after("sent", "revision_received")]), null, "the QC pass sent it: spent");
  assert.equal(pickCustomProofEmail([set], [after("queued", "revision_received")]), null, "queued counts as sent");
  assert.equal(pickCustomProofEmail([set], [after("draft", "revision_received")]), null, "a held draft carries the words already");
  assert.ok(pickCustomProofEmail([set], [after("failed", "revision_received")]), "a failed send leaves it for the retry");
  assert.ok(pickCustomProofEmail([set], [after("sent", "proof_reminder")]), "a reminder does not spend it");
  assert.ok(pickCustomProofEmail([set], [after("sent", null)]), "an ad-hoc email does not spend it");

  const cleared: CustomProofRow = { action: CUSTOM_PROOF_CLEARED, metadata: null, createdAt: at("2026-11-11T05:00:00Z") };
  assert.equal(pickCustomProofEmail([set, cleared], []), null, "cleared after = the template");
  const again: CustomProofRow = { ...set, metadata: { ...meta, subject: "second words" }, createdAt: at("2026-11-11T06:00:00Z") };
  assert.equal(pickCustomProofEmail([again, cleared, set], [])?.subject, "second words", "set again after a clear, any row order");
  const broken: CustomProofRow = { ...set, metadata: { subject: "x", body: "no link" }, createdAt: at("2026-11-11T07:00:00Z") };
  assert.equal(pickCustomProofEmail([set, broken], []), null, "a broken newest set never falls back to an older one");
  const note: CustomProofRow = { action: "comment", metadata: { body: "hi" }, createdAt: at("2026-11-11T08:00:00Z") };
  assert.ok(pickCustomProofEmail([set, note], []), "other activity is ignored");

  // Rendering: the same path as a stored template (sign-off first, then the variables).
  const custom = pickCustomProofEmail([set], []);
  assert.ok(custom);
  const out = renderTemplate(withSignOff({ subject: custom.subject, body: custom.body }, "Warm regards,\nBrianna"), {
    first_name: "Blair",
    order_number: "PC1",
    business_name: "PixArt Creatives",
    proof_link: "https://example.test/p/abc",
  });
  assert.equal(out.subject, meta.subject);
  assert.equal(out.body, "Hi Blair,\n\nWe are so sorry.\n\nHere they are: https://example.test/p/abc\n\nWarm regards,\nBrianna");

  console.log("custom proof email: all checks pass");
}

main();
