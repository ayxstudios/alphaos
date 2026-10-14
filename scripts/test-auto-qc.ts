// Auto QC (Yousif 2026-10-14): which versions the judge looks at, when a
// check still counts for the artwork on screen, and the judge's body
// validation. Pure, no database. docs/AUTO_QC.md.
import assert from "node:assert/strict";

import { countIssues, latestSlots, parseAutoQcBody, resolutionTier, sameIds, slotAssetIds } from "../lib/qc/auto-qc";
import { fixQcOf, parseFixQcBody } from "../lib/qc/auto-qc-fix";
import type { QcVersion } from "../lib/qc/data";

const v = (id: string, portrait: number | null = null): QcVersion => ({
  id,
  url: `https://x/${id}.png`,
  type: "submission",
  uploadedBy: null,
  createdAt: "2026-10-14T00:00:00Z",
  portrait,
});

// Single portrait: newest version, previous = the one before.
let slots = latestSlots([v("a"), v("b"), v("c")], [{ key: "i1", itemId: "i1", unit: 1, n: 1, label: "" }]);
assert.equal(slots.length, 1);
assert.equal(slots[0].latest.id, "c");
assert.equal(slots[0].previous?.id, "b");
assert.equal(slots[0].portrait, null);

// No versions: nothing to judge.
assert.deepEqual(latestSlots([], []), []);

// 2+ portraits with tagged uploads: one slot per portrait, untagged on its own.
const two = [
  { key: "i1", itemId: "i1", unit: 1, n: 1, label: "Dog" },
  { key: "i2", itemId: "i2", unit: 1, n: 2, label: "Cat" },
];
slots = latestSlots([v("p1a", 1), v("p2a", 2), v("p1b", 1), v("u")], two);
assert.deepEqual(
  slots.map((s) => [s.portrait, s.latest.id, s.previous?.id ?? null]),
  [
    [1, "p1b", "p1a"],
    [2, "p2a", null],
    [null, "u", null],
  ],
);
assert.deepEqual(slotAssetIds(slots), ["p1b", "p2a", "u"]);

// 2+ portraits but nothing tagged: judged as one, like the Approve screen.
slots = latestSlots([v("x"), v("y")], two);
assert.equal(slots.length, 1);
assert.equal(slots[0].latest.id, "y");

// Current = the same set of version ids, any order.
assert.ok(sameIds(["b", "a"], ["a", "b"]));
assert.ok(!sameIds(["a"], ["a", "b"]));
assert.ok(!sameIds(null, ["a"]));

// Body validation.
const good = {
  orderId: "o1",
  assetIds: ["b", "a"],
  verdict: "issues",
  summary: "One problem.",
  portraits: [
    {
      portrait: null,
      assetId: "a",
      verdict: "issues",
      summary: "Ring missing.",
      checks: [
        { key: 2, result: "fail", note: "The wedding ring on her left hand is missing." },
        { key: 1, result: "pass", note: "" },
        { key: 3, result: "na", note: "" },
      ],
    },
  ],
  revision: { done: "partly", missed: ["darker hair"], note: "" },
  model: "fable",
};
const ok = parseAutoQcBody(good);
assert.ok(ok.ok);
if (ok.ok) {
  assert.deepEqual(ok.body.assetIds, ["a", "b"]);
  assert.deepEqual(ok.body.portraits[0].checks.map((c) => c.key), [1, 2, 3]);
  assert.equal(ok.body.portraits[0].checks[1].label, "Rings and jewellery");
  assert.equal(countIssues(ok.body.portraits), 1);
  assert.equal(ok.body.revision?.done, "partly");
}
assert.ok(!parseAutoQcBody({ ...good, verdict: "approved" }).ok, "unknown verdict refused");
assert.ok(!parseAutoQcBody({ ...good, assetIds: [] }).ok, "no asset ids refused");
assert.ok(!parseAutoQcBody({ ...good, portraits: [{ ...good.portraits[0], checks: [{ key: 99, result: "pass" }] }] }).ok, "unknown key refused");
assert.ok(!parseAutoQcBody({ ...good, portraits: [{ ...good.portraits[0], checks: [{ key: 2, result: "ok" }] }] }).ok, "unknown result refused");
assert.ok(!parseAutoQcBody({ ...good, revision: { done: "maybe" } }).ok, "bad revision refused");
assert.ok(!parseAutoQcBody(null).ok);

// Check 13, Resolution (measured by the judge): accepted, labelled, and the tiers hold either way round.
const res = parseAutoQcBody({ ...good, portraits: [{ ...good.portraits[0], checks: [{ key: 13, result: "fail", note: "1600 x 2000 px" }] }] });
assert.ok(res.ok, "check 13 accepted");
if (res.ok) assert.equal(res.body.portraits[0].checks[0].label, "Resolution");
assert.equal(resolutionTier(2400, 3000), "ok");
assert.equal(resolutionTier(3000, 2400), "ok", "landscape counts the same");
assert.equal(resolutionTier(2399, 3000), "low");
assert.equal(resolutionTier(2400, 2999), "low");
assert.equal(resolutionTier(2400, 2400), "low", "a square needs the long side too");
assert.equal(resolutionTier(3000, 3000), "ok");
assert.equal(resolutionTier(4800, 6000), "ideal");
assert.equal(resolutionTier(6000, 4800), "ideal");
assert.equal(resolutionTier(4800, 5999), "ok");
assert.equal(resolutionTier(0, 3000), null);

// Auto QC of the AI fix (Yousif 2026-10-14: the Auto QC judges the AI fix too).
const fixGood = {
  orderId: "o1",
  fixId: "f1",
  verdict: "issues",
  summary: "The repaired hand still has six fingers.",
  checks: [
    { key: 8, result: "fail", note: "Six fingers on the left hand." },
    { key: 2, result: "pass", note: "" },
    { key: 99, result: "pass", note: "" }, // unknown keys are dropped, not fatal
  ],
  model: "fable",
};
const fok = parseFixQcBody(fixGood);
assert.ok(fok.ok);
if (fok.ok) {
  assert.deepEqual(fok.body.checks.map((c) => c.key), [2, 8]);
  assert.equal(fok.body.checks[1].label, "Hands and fingers");
}
assert.ok(!parseFixQcBody({ ...fixGood, fixId: "" }).ok, "missing fixId refused");
assert.ok(!parseFixQcBody({ ...fixGood, verdict: "approved" }).ok, "unknown verdict refused");
assert.ok(!parseFixQcBody({ ...fixGood, checks: [] }).ok, "no checks on a judged fix refused");
assert.ok(parseFixQcBody({ ...fixGood, verdict: "unsure", checks: [] }).ok, "unsure may carry no checks");
assert.ok(!parseFixQcBody(null).ok);

// The stored row round-trips into the view; unjudged rows stay null.
const at = new Date("2026-10-14T10:00:00Z");
const qcView = fixQcOf({ qcVerdict: "pass", qcSummary: "Blends in.", qcChecks: [{ key: 8, label: "", result: "pass", note: "" }], qcAt: at });
assert.equal(qcView?.verdict, "pass");
assert.equal(qcView?.checks[0].label, "Hands and fingers");
assert.equal(qcView?.at, at.toISOString());
assert.equal(fixQcOf({ qcVerdict: null, qcSummary: null, qcChecks: [], qcAt: null }), null);
assert.equal(fixQcOf({ qcVerdict: "approved", qcSummary: null, qcChecks: [], qcAt: at }), null, "unknown stored verdict hidden");

console.log("auto-qc: all checks passed");
