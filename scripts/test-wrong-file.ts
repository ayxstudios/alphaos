import assert from "node:assert/strict";

import { orientationOf } from "../lib/orders/same-buyer";
import { FINE_H, FINE_W, fineSigFromGray, inkDifference } from "../lib/qc/image-hash";
import {
  type SlotFile,
  type WrongFileInput,
  designerHeadsUpMessage,
  evaluateWrongFile,
  isDesignerHeadsUp,
  retiredByRedraw,
  wentToCustomer,
  wrongFileMessage,
  wrongFileWarnings,
} from "../lib/qc/wrong-file";

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

  // 27 Oct, Jerome: Alyssa's portrait (4213333468) also put on Erin's 4204560873, neither sent yet.
  // The match is there, but a designer's hand-in goes through on it with a heads-up naming the other order.
  const mixup = evaluateWrongFile({
    ...empty,
    target: { assetId: "alyssa", dhash: base, fineSig: A },
    recent: [{ assetId: "on-erin", dhash: away(0), fineSig: A, orderNumber: "4204560873", sent: false }],
  });
  assert.equal(mixup.blocked, true);
  assert.equal(mixup.reasons[0].matchSent, false);
  assert.ok(mixup.reasons.every(isDesignerHeadsUp));
  assert.match(designerHeadsUpMessage(mixup.reasons) ?? "", /also on order 4204560873\. If it does not belong there, upload that order's own portrait/);
  // QC (staff) still stops on it, with words that fit: neither copy has gone out.
  assert.match(wrongFileMessage(mixup.reasons) ?? "", /also on order 4204560873, where it has not gone to the customer yet/);
  // Unknown standing counts as sent: never a heads-up.
  assert.equal(rec.reasons.some(isDesignerHeadsUp), false);
  assert.equal(designerHeadsUpMessage(rec.reasons), null);

  // A sent match outranks a closer unsent one, so the hand-in is stopped on the sent one.
  const both = evaluateWrongFile({
    ...empty,
    target: { assetId: "t", dhash: base, fineSig: drawing(1, 2) },
    recent: [
      { assetId: "unsent-copy", dhash: away(0), fineSig: drawing(1, 2), orderNumber: "PC7", sent: false },
      { assetId: "sent-copy", dhash: away(4), fineSig: drawing(1, 1), orderNumber: "PC8", sent: true },
    ],
  });
  assert.equal(both.reasons[0].matchAssetId, "sent-copy");
  assert.equal(both.reasons.some(isDesignerHeadsUp), false);
  assert.match(wrongFileMessage(both.reasons) ?? "", /artwork on order PC8\. Upload the right file/);
  // The buyer's other order only unsent, but a sent copy on another order: the sent one still blocks.
  const sibUnsent = evaluateWrongFile({
    ...empty,
    target: { assetId: "t", dhash: base, fineSig: A },
    siblings: [{ assetId: "sib", dhash: away(0), fineSig: A, orderNumber: "PC31", sent: false }],
    recent: [{ assetId: "old", dhash: away(2), fineSig: A, orderNumber: "PC20", sent: true }],
  });
  assert.deepEqual(
    sibUnsent.reasons.map((r) => [r.kind, r.matchSent ?? "sent"]),
    [
      ["other_order", false],
      ["recent_art", "sent"],
    ],
  );
  assert.equal(sibUnsent.reasons.every(isDesignerHeadsUp), false);
  assert.match(wrongFileMessage(sibUnsent.reasons) ?? "", /artwork on order PC20/);

  // Did a file go to its own customer?
  const t = (h: number) => new Date(Date.UTC(2026, 9, 27, h));
  const file = (id: string, h: number, extra: Partial<SlotFile> = {}): SlotFile => ({ id, itemId: "i1", unit: 1, createdAt: t(h), deletedAt: null, ...extra });
  const m = { ...file("m", 10), type: "submission" };
  assert.equal(wentToCustomer({ ...m, type: "final" }, [], []), true);
  assert.equal(wentToCustomer(m, [file("m", 10)], []), false, "never passed QC");
  assert.equal(wentToCustomer(m, [file("m", 10)], [t(12)]), true, "current when its order passed QC");
  assert.equal(wentToCustomer(m, [file("m", 10)], [t(9)]), false, "QC pass before it was uploaded");
  assert.equal(wentToCustomer(m, [file("m", 10), file("n", 11)], [t(12)]), false, "replaced before the pass");
  assert.equal(wentToCustomer(m, [file("m", 10), file("n", 11, { deletedAt: t(11.5) })], [t(12)]), true, "the replacement was removed before the pass");
  assert.equal(wentToCustomer(m, [file("m", 10), file("n", 11, { unit: 2 })], [t(12)]), true, "a newer file in another portrait slot");
  assert.equal(wentToCustomer(m, [file("m", 10), file("n", 13)], [t(12)]), true, "replaced only after it went out");

  // 7 Nov, Jerome: Mabel's painting (4220775030) had been sent on 4220738504 by mistake, an order fully redrawn since.
  // That file is no longer 4220738504's art: the hand-in goes through with a heads-up, the QC pass still stops on it.
  const retiredMatch = evaluateWrongFile({
    ...empty,
    target: { assetId: "mabel", dhash: base, fineSig: A },
    recent: [{ assetId: "sent-then-redrawn", dhash: away(0), fineSig: A, orderNumber: "4220738504", sent: false, retired: true }],
  });
  assert.equal(retiredMatch.blocked, true);
  assert.equal(retiredMatch.reasons[0].matchSent, false);
  assert.equal(retiredMatch.reasons[0].matchRetired, true);
  assert.ok(retiredMatch.reasons.every(isDesignerHeadsUp));
  assert.match(designerHeadsUpMessage(retiredMatch.reasons) ?? "", /also on order 4220738504\. If it does not belong there, upload that order's own portrait/);
  assert.match(wrongFileMessage(retiredMatch.reasons) ?? "", /sent on order 4220738504, which has been redrawn since\. Check which order it belongs to/);
  // A plain unsent match keeps its own wording and carries no retired flag.
  assert.equal(mixup.reasons[0].matchRetired, undefined);
  // A sent match on a third order still outranks the retired one: the hand-in is stopped on the sent copy.
  const retiredAndSent = evaluateWrongFile({
    ...empty,
    target: { assetId: "t", dhash: base, fineSig: A },
    recent: [
      { assetId: "gone", dhash: away(0), fineSig: A, orderNumber: "PC40", sent: false, retired: true },
      { assetId: "out", dhash: away(3), fineSig: A, orderNumber: "PC41", sent: true },
    ],
  });
  assert.equal(retiredAndSent.reasons[0].matchAssetId, "out");
  assert.equal(retiredAndSent.reasons.some(isDesignerHeadsUp), false);

  // Was a sent file replaced in its own slot by a DIFFERENT picture? The ink decides.
  const sig = (f: SlotFile, fineSig: string | null): SlotFile & { fineSig: string | null } => ({ ...f, fineSig });
  const sentA = sig(file("sent", 10), A);
  assert.equal(retiredByRedraw(sentA, [sentA, sig(file("redraw", 13), B)]), true, "a full redraw: another picture in the same slot");
  assert.equal(retiredByRedraw(sig(file("sent", 10), drawing(1, 1)), [sentA, sig(file("name", 13), drawing(1, 2))]), false, "a new name band is a touch-up, not a redraw");
  assert.equal(retiredByRedraw(sentA, [sentA, sig(file("again", 13), A)]), false, "the same picture re-exported");
  assert.equal(retiredByRedraw(sentA, [sentA]), false, "nothing newer in the slot");
  assert.equal(retiredByRedraw(sentA, [sentA, sig(file("older", 8), B)]), false, "an older file is not a replacement");
  assert.equal(retiredByRedraw(sentA, [sentA, sig(file("other-slot", 13, { unit: 2 }), B)]), false, "a different picture in another portrait slot");
  assert.equal(retiredByRedraw(sentA, [sentA, sig(file("other-item", 13, { itemId: "i2" }), B)]), false, "a different picture on another line item");
  assert.equal(retiredByRedraw(sentA, [sentA, sig(file("removed", 13, { deletedAt: t(14) }), B)]), false, "the replacement was removed");
  assert.equal(retiredByRedraw(sentA, [sentA, sig(file("unhashed", 13), null)]), false, "no fine signature on the replacement: never on a guess");
  assert.equal(retiredByRedraw(sig(file("sent", 10), null), [sig(file("sent", 10), null), sig(file("redraw", 13), B)]), false, "no fine signature on the sent file");
  assert.equal(retiredByRedraw(sig(file("sent", 10), blank), [sig(file("sent", 10), blank), sig(file("redraw", 13), blank)]), false, "two blank pages have no ink to compare");
  // The newest file in the slot is the one that counts: a redraw that was put back to the sent picture is not a redraw.
  assert.equal(retiredByRedraw(sentA, [sentA, sig(file("mid", 13), B), sig(file("last", 15), A)]), false, "the newest file is the sent picture again");
  assert.equal(retiredByRedraw(sentA, [sentA, sig(file("mid", 13), A), sig(file("last", 15), B)]), true, "the newest file is a different picture");

  console.log("wrong-file: all checks passed");
}
main();
