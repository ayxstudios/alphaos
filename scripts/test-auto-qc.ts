// Auto QC (Yousif 2026-10-14): which versions the judge looks at, when a
// check still counts for the artwork on screen, and the judge's body
// validation. Pure, no database. docs/AUTO_QC.md.
import assert from "node:assert/strict";

import { countIssues, latestSlots, parseAutoQcBody, sameIds, slotAssetIds } from "../lib/qc/auto-qc";
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
let slots = latestSlots([v("a"), v("b"), v("c")], [{ id: "i1", n: 1, label: "" }]);
assert.equal(slots.length, 1);
assert.equal(slots[0].latest.id, "c");
assert.equal(slots[0].previous?.id, "b");
assert.equal(slots[0].portrait, null);

// No versions: nothing to judge.
assert.deepEqual(latestSlots([], []), []);

// 2+ portraits with tagged uploads: one slot per portrait, untagged on its own.
const two = [
  { id: "i1", n: 1, label: "Dog" },
  { id: "i2", n: 2, label: "Cat" },
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
assert.ok(!parseAutoQcBody({ ...good, portraits: [{ ...good.portraits[0], checks: [{ key: 12, result: "pass" }] }] }).ok, "unknown key refused");
assert.ok(!parseAutoQcBody({ ...good, portraits: [{ ...good.portraits[0], checks: [{ key: 2, result: "ok" }] }] }).ok, "unknown result refused");
assert.ok(!parseAutoQcBody({ ...good, revision: { done: "maybe" } }).ok, "bad revision refused");
assert.ok(!parseAutoQcBody(null).ok);

console.log("auto-qc: all checks passed");
