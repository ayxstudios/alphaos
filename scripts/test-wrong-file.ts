import assert from "node:assert/strict";

import { orientationOf } from "../lib/orders/same-buyer";
import { type WrongFileInput, evaluateWrongFile, wrongFileMessage, wrongFileWarnings } from "../lib/qc/wrong-file";

const base = "f0f0f0f0f0f0f0f0";
/** `base` with the lowest `n` bits flipped = hamming distance n. */
function away(n: number): string {
  const lo = (parseInt(base.slice(8), 16) ^ (n >= 32 ? 0xffffffff : (2 ** n - 1))) >>> 0;
  return base.slice(0, 8) + lo.toString(16).padStart(8, "0");
}

function main() {
  const empty: Omit<WrongFileInput, "target"> = { references: [], siblings: [], recent: [], expectedOrientation: null };

  // PC32132 incident: Saiya alone, portrait; the designer uploaded the PC32131 landscape file.
  const incident = evaluateWrongFile({
    ...empty,
    target: { assetId: "a-new", dhash: base, width: 1800, height: 1200 },
    siblings: [{ assetId: "a-31", dhash: away(3), orderNumber: "PC32131" }],
    expectedOrientation: "portrait",
  });
  assert.equal(incident.blocked, true);
  assert.equal(incident.reasons[0].kind, "other_order");
  assert.equal(incident.reasons[0].matchOrderNumber, "PC32131");
  assert.match(wrongFileMessage(incident.reasons) ?? "", /PC32131's artwork\. Upload the right file for this order\./);
  assert.ok(incident.reasons.some((r) => r.kind === "orientation"));

  // Boundary: distance 10 blocks, 11 does not.
  const edge = (d: number) =>
    evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base }, siblings: [{ assetId: "s", dhash: away(d), orderNumber: "PC1" }] });
  assert.equal(edge(10).blocked, true);
  assert.equal(edge(11).blocked, false);

  // Reference photo handed back.
  const ref = evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base }, references: [{ assetId: "r", dhash: away(0) }] });
  assert.equal(ref.blocked, true);
  assert.match(wrongFileMessage(ref.reasons) ?? "", /customer's reference photo/);

  // Recent artwork on an unrelated order.
  const rec = evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base }, recent: [{ assetId: "x", dhash: away(5), orderNumber: "PC999" }] });
  assert.equal(rec.reasons[0].kind, "recent_art");
  assert.match(wrongFileMessage(rec.reasons) ?? "", /artwork on order PC999/);

  // Orientation alone warns, never blocks.
  const warn = evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base, width: 2000, height: 1000 }, expectedOrientation: "portrait" });
  assert.equal(warn.blocked, false);
  assert.equal(wrongFileWarnings(warn.reasons).length, 1);
  assert.equal(wrongFileMessage(warn.reasons), null);
  // Matching or square shape: no warning.
  assert.equal(evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base, width: 1000, height: 1030 }, expectedOrientation: "portrait" }).reasons.length, 0);

  // No hash (PDF, HEIC, corrupt) never blocks and never matches.
  const nohash = evaluateWrongFile({
    ...empty,
    target: { assetId: "t", dhash: null },
    references: [{ assetId: "r", dhash: base }],
    siblings: [{ assetId: "s", dhash: base, orderNumber: "PC1" }],
  });
  assert.deepEqual(nohash, { blocked: false, reasons: [] });
  // Candidates without a hash are skipped.
  assert.equal(evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base }, siblings: [{ assetId: "s", dhash: null }] }).blocked, false);

  // Orientation from the ordered options.
  const line = (options: unknown) => ({ title: "Portrait", variation: null, sku: null, options, figureCount: null, style: null, quantity: 1 });
  assert.equal(orientationOf([line([{ name: "Orientation", value: "Portrait" }])] as never), "portrait");
  assert.equal(orientationOf([line([{ name: "Orientation", value: "Landscape" }])] as never), "landscape");
  assert.equal(orientationOf([line([])] as never, "please use portrait orientation"), "portrait");
  assert.equal(orientationOf([line([])] as never), null);

  console.log("wrong-file: all checks passed");
}
main();
