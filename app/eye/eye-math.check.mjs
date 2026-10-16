// Run: node --experimental-strip-types app/eye/eye-math.check.mjs
import assert from "node:assert/strict";
import { hash01, computeSectors, ringRadii, radiusAt, healthOf, matchesFilter, nearestIndex, ageText, truncate, sentimentWords } from "./eye-math.ts";

const TAU = Math.PI * 2;
// hash is stable, in range, and spreads
assert.equal(hash01("abc", 1), hash01("abc", 1));
assert.notEqual(hash01("abc", 1), hash01("abc", 2));
for (let i = 0; i < 1000; i++) { const h = hash01("o" + i); assert.ok(h >= 0 && h < 1); }
// sectors: contiguous, positive, cover the circle, min width honoured
for (const counts of [[], [5], [0, 0], [100, 1, 0], [3, 3, 3, 3, 3, 3, 3, 3]]) {
  const s = computeSectors(counts);
  assert.equal(s.s0.length, counts.length);
  let span = 0;
  s.s0.forEach((a, i) => { assert.ok(s.s1[i] > a); span += s.s1[i] - a; if (i) assert.ok(a >= s.s1[i - 1]); });
  if (counts.length) assert.ok(span <= TAU + 1e-9 && span > TAU * 0.8);
}
const lop = computeSectors([100, 1]);
assert.ok(lop.s1[1] - lop.s0[1] > 0.05 * TAU * 0.9);
// rings increase and radiusAt interpolates
const rr = ringRadii(300, false);
for (let i = 1; i < 6; i++) assert.ok(rr[i] > rr[i - 1]);
assert.equal(radiusAt(rr, 0), rr[0]); assert.equal(radiusAt(rr, 5), rr[5]);
assert.ok(Math.abs(radiusAt(rr, 2.5) - (rr[2] + rr[3]) / 2) < 1e-9);
// health priority
const base = { sentiment: "neutral", stage: { n: 1 }, delayed: false, urgent: false, waitingOnBuyer: false, stageSince: new Date().toISOString() };
assert.equal(healthOf(base), "ok");
assert.equal(healthOf({ ...base, waitingOnBuyer: true }), "violet");
assert.equal(healthOf({ ...base, waitingOnBuyer: true, urgent: true }), "amber");
assert.equal(healthOf({ ...base, delayed: true, sentiment: "unhappy" }), "unhappy");
assert.equal(healthOf({ ...base, stage: { n: 5 } }), "done");
// filters
assert.ok(matchesFilter(base, null, 0));
assert.ok(!matchesFilter(base, "delayed", 0));
assert.ok(matchesFilter({ ...base, delayed: true }, "delayed", 0));
assert.ok(matchesFilter({ ...base, stage: { n: 5 } }, "done", 0));
assert.ok(!matchesFilter({ ...base, stage: { n: 5 } }, "done", Date.now() + 1000));
// nearest, wording
assert.equal(nearestIndex([{ x: 0, y: 0 }, { x: 10, y: 10 }], 9, 9, 24), 1);
assert.equal(nearestIndex([{ x: 0, y: 0 }], 100, 100, 24), -1);
assert.equal(nearestIndex([], 1, 1, 24), -1);
assert.equal(ageText(30000), "just now"); assert.equal(ageText(125 * 60000), "2h 5m"); assert.equal(ageText(50 * 3600000), "2d 2h");
assert.equal(truncate("abcdefghij", 5), "abcd…");
assert.equal(sentimentWords("neutral"), "buyer is quiet");
console.log("eye-math: all assertions passed");
