import assert from "node:assert/strict";

import { orientationOf } from "../lib/orders/same-buyer";
import { FINE_H, FINE_W, fineSigFromGray, inkDifference } from "../lib/qc/image-hash";
import { type WrongFileInput, evaluateWrongFile, wrongFileMessage, wrongFileWarnings } from "../lib/qc/wrong-file";

const base = "f0f0f0f0f0f0f0f0";
/** `base` with the lowest `n` bits flipped = hamming distance n. */
function away(n: number): string {
  const lo = (parseInt(base.slice(8), 16) ^ (n >= 32 ? 0xffffffff : (2 ** n - 1))) >>> 0;
  return base.slice(0, 8) + lo.toString(16).padStart(8, "0");
}

/** A 64x80 fine signature: cream paper, a dark block placed by `seed`, and a name band when `name` is set. */
function drawing(seed: number, name = 0): string {
  const px = new Uint8Array(FINE_W * FINE_H).fill(232);
  const x0 = 8 + ((seed * 13) % 30);
  const y0 = 8 + ((seed * 29) % 40);
  for (let y = y0; y < y0 + 30; y++) for (let x = x0; x < x0 + 24; x++) px[y * FINE_W + x] = 60;
  if (name) for (let y = 72; y < 74; y++) for (let x = 10; x < 54; x++) if ((x + name) % 3 === 0) px[y * FINE_W + x] = 40;
  return fineSigFromGray(px);
}

function main() {
  const empty: Omit<WrongFileInput, "target"> = { references: [], siblings: [], recent: [], expectedOrientation: null };
  const A = drawing(1);
  const B = drawing(2); // a different drawing on the same paper

  // PC32132 incident: Saiya alone, portrait; the designer uploaded the PC32131 landscape file (name band changed).
  const incident = evaluateWrongFile({
    ...empty,
    target: { assetId: "a-new", dhash: base, fineSig: drawing(1, 2), width: 1800, height: 1200 },
    siblings: [{ assetId: "a-31", dhash: away(3), fineSig: drawing(1, 1), orderNumber: "PC32131" }],
    expectedOrientation: "portrait",
  });
  assert.equal(incident.blocked, true);
  assert.equal(incident.reasons[0].kind, "other_order");
  assert.equal(incident.reasons[0].matchOrderNumber, "PC32131");
  assert.ok((incident.reasons[0].inkDiff ?? 1) < 0.2);
  assert.match(wrongFileMessage(incident.reasons) ?? "", /PC32131's artwork\. Upload the right file for this order\./);
  assert.ok(incident.reasons.some((r) => r.kind === "orientation"));

  // Boundary on the first look: with the same drawing, distance 10 blocks, 11 does not.
  const edge = (d: number) =>
    evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base, fineSig: A }, siblings: [{ assetId: "s", dhash: away(d), fineSig: A, orderNumber: "PC1" }] });
  assert.equal(edge(10).blocked, true);
  assert.equal(edge(11).blocked, false);

  // 16 Oct, designer Jerome: a different drawing on the same paper. The dHash says close, the ink says no.
  assert.ok((inkDifference(A, B) ?? 0) > 0.5);
  const jerome = evaluateWrongFile({
    ...empty,
    target: { assetId: "t", dhash: base, fineSig: A },
    references: [{ assetId: "r", dhash: away(0), fineSig: B }],
    siblings: [{ assetId: "s", dhash: away(2), fineSig: B, orderNumber: "PC2" }],
    recent: [{ assetId: "x", dhash: away(4), fineSig: B, orderNumber: "4196318663" }],
  });
  assert.deepEqual(jerome, { blocked: false, reasons: [] });

  // Second look missing on either side: no match (fail open), whatever the dHash says.
  assert.equal(evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base, fineSig: A }, siblings: [{ assetId: "s", dhash: base, orderNumber: "PC1" }] }).blocked, false);
  assert.equal(evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base }, siblings: [{ assetId: "s", dhash: base, fineSig: A, orderNumber: "PC1" }] }).blocked, false);
  // A blank page has no ink to compare: never a match.
  const blank = fineSigFromGray(new Uint8Array(FINE_W * FINE_H).fill(232));
  assert.equal(inkDifference(blank, blank), null);
  assert.equal(evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base, fineSig: blank }, siblings: [{ assetId: "s", dhash: base, fineSig: blank, orderNumber: "PC1" }] }).blocked, false);

  // A photo the customer sent, handed back as the artwork.
  const ref = evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base, fineSig: A }, references: [{ assetId: "r", dhash: away(0), fineSig: A }] });
  assert.equal(ref.blocked, true);
  assert.match(wrongFileMessage(ref.reasons) ?? "", /customer's reference photo/);
  // A reference staff attached (the last proof, for a revision) is never compared.
  const staffRef = evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base, fineSig: A }, references: [{ assetId: "r", dhash: away(0), fineSig: A, fromCustomer: false }] });
  assert.equal(staffRef.blocked, false);

  // Recent artwork on an unrelated order: the same drawing blocks.
  const rec = evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base, fineSig: A }, recent: [{ assetId: "x", dhash: away(5), fineSig: A, orderNumber: "PC999" }] });
  assert.equal(rec.reasons[0].kind, "recent_art");
  assert.match(wrongFileMessage(rec.reasons) ?? "", /artwork on order PC999/);
  // Several within reach: the closest drawing is the one named, not the closest dHash.
  const pick = evaluateWrongFile({
    ...empty,
    target: { assetId: "t", dhash: base, fineSig: drawing(1, 2) },
    recent: [
      { assetId: "lookalike", dhash: away(1), fineSig: B, orderNumber: "PC5" },
      { assetId: "copy", dhash: away(6), fineSig: drawing(1, 1), orderNumber: "PC6" },
    ],
  });
  assert.equal(pick.reasons[0].matchAssetId, "copy");

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
    references: [{ assetId: "r", dhash: base, fineSig: A }],
    siblings: [{ assetId: "s", dhash: base, fineSig: A, orderNumber: "PC1" }],
  });
  assert.deepEqual(nohash, { blocked: false, reasons: [] });
  // Candidates without a hash are skipped.
  assert.equal(evaluateWrongFile({ ...empty, target: { assetId: "t", dhash: base, fineSig: A }, siblings: [{ assetId: "s", dhash: null, fineSig: A }] }).blocked, false);

  // Orientation from the ordered options.
  const line = (options: unknown) => ({ title: "Portrait", variation: null, sku: null, options, figureCount: null, style: null, quantity: 1 });
  assert.equal(orientationOf([line([{ name: "Orientation", value: "Portrait" }])] as never), "portrait");
  assert.equal(orientationOf([line([{ name: "Orientation", value: "Landscape" }])] as never), "landscape");
  assert.equal(orientationOf([line([])] as never, "please use portrait orientation"), "portrait");
  assert.equal(orientationOf([line([])] as never), null);

  console.log("wrong-file: all checks passed");
}
main();
