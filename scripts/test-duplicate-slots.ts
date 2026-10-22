import assert from "node:assert/strict";

import { duplicateCandidates, duplicateSlotsMessage, optionDifference, sameBytes, type SlotFile } from "../lib/qc/duplicate-slots";

const opts = (bg: string, pet?: string) => [
  { name: "Number of Pets:", value: "1" },
  { name: "Print On:", value: "Digital File Only" },
  { name: "Background", value: bg },
  ...(pet ? [{ name: "Pet Name(s)", value: pet }] : []),
];
const file = (p: Partial<SlotFile> & Pick<SlotFile, "n" | "assetId">): SlotFile => ({
  itemId: null,
  dhash: null,
  fineSig: null,
  width: 2400,
  height: 3000,
  options: null,
  ...p,
});

function main() {
  // PixArt PC32228 (Shelby), 21 Oct: Lucille on Blush and on Blue, the blue file uploaded for both (same ETag in R2).
  const shelby = [
    file({ n: 1, assetId: "ce92b01d", itemId: "blush-line", dhash: "7079a87171c6ce52", fineSig: "g64x80:0tLS0tLS", options: opts("Blush", "Lucille") }),
    file({ n: 2, assetId: "f2bfadd4", itemId: "blue-line", dhash: "7079a87171c6ce52", fineSig: "g64x80:0tLS0tLS", options: opts("Blue", "Lucille") }),
  ];
  const [pair] = duplicateCandidates(shelby);
  assert.ok(pair);
  assert.equal(optionDifference(pair.a, pair.b), "Background: Blush / Blue");
  assert.equal(
    duplicateSlotsMessage(pair, "PC32228", "submit"),
    "Order PC32228: Portrait 1 and portrait 2 are the same file, but she asked for two different portraits (Background: Blush / Blue). Upload the right file for each portrait.",
  );
  assert.match(duplicateSlotsMessage(pair, "PC32228", "qc_pass"), /Fail it back to the designer, or send it anyway only if you have checked it is right\.$/);

  // PixArt PC32205 (Kara) round 1, 15 Oct: Purple and Grass + "Winnie", one file twice.
  const kara = [
    file({ n: 1, assetId: "867646eb", itemId: "purple-line", dhash: "6169b27169796c74", fineSig: "g64x80:2tra2tra", options: opts("Purple") }),
    file({ n: 2, assetId: "3d93fbbd", itemId: "grass-line", dhash: "6169b27169796c74", fineSig: "g64x80:2tra2tra", options: opts("Grass", "Winnie") }),
  ];
  const [k] = duplicateCandidates(kara);
  assert.equal(optionDifference(k.a, k.b), "Background: Purple / Grass");

  // The right pair: Lucille drawn on both colours hashes differently, nothing to stop.
  assert.deepEqual(duplicateCandidates([shelby[0], { ...shelby[1], assetId: "blue-new", dhash: "7079a87171c6ce53" }]), []);
  // No hashes on record (a PDF, not backfilled): never matched.
  assert.deepEqual(duplicateCandidates([{ ...shelby[0], dhash: null, fineSig: null }, { ...shelby[1], dhash: null, fineSig: null }]), []);
  // Two lines bought with exactly the same options are copies: one file may serve both.
  assert.deepEqual(duplicateCandidates([{ ...shelby[1], itemId: "copy-a" }, { ...shelby[1], n: 2, itemId: "copy-b", assetId: "other" }]), []);
  // The same drawing as a digital file and as a canvas: only the product options differ.
  const canvas = [{ name: "Print On:", value: 'Canvas 8"X10" / 20X25cm' }, { name: "Background", value: "Blue" }, { name: "Pet Name(s)", value: "Lucille" }];
  assert.deepEqual(duplicateCandidates([{ ...shelby[1], itemId: "digital" }, { ...shelby[1], n: 2, itemId: "canvas", assetId: "other", options: canvas }]), []);
  // Lines with no readable options are never stopped on a guess.
  assert.deepEqual(duplicateCandidates([{ ...shelby[0], options: null }, { ...shelby[1], options: null }]), []);
  // Two different pets on two frames (PC32223 shape: "Background Colour" on one line, "Background" on the other).
  const dodger = [{ name: "Size:", value: "Black Frame 16x20" }, { name: "Background Colour", value: "Blue" }, { name: "Pet Name(s)", value: "Dodger" }];
  const dakota = [{ name: "Print On:", value: "Black Frame 16x20" }, { name: "Background", value: "Purple" }, { name: "Pet Name(s)", value: "Dakota" }];
  const pets = duplicateCandidates([{ ...shelby[0], itemId: "d1", options: dodger }, { ...shelby[1], itemId: "d2", options: dakota }]);
  assert.equal(optionDifference(pets[0].a, pets[0].b), "Pet Name(s): Dodger / Dakota");
  // Two portraits on one line (units 1 and 2) are always different portraits.
  const units = duplicateCandidates([{ ...shelby[0], itemId: "pets" }, { ...shelby[1], itemId: "pets" }]);
  assert.equal(units.length, 1);
  assert.equal(optionDifference(units[0].a, units[0].b), null);
  assert.match(duplicateSlotsMessage(units[0], null, "submit"), /^Portrait 1 and portrait 2 are the same file, but she asked for two different portraits\. Upload/);
  // The very same asset in two slots she set apart.
  assert.equal(duplicateCandidates([file({ n: 1, assetId: "x", itemId: "a", options: opts("Blue") }), file({ n: 2, assetId: "x", itemId: "b", options: opts("Blush") })]).length, 1);

  // The bytes decide: the same size and ETag, nothing missing.
  assert.equal(sameBytes({ eTag: '"ccd1482f"', contentLength: 3050883 }, { eTag: '"ccd1482f"', contentLength: 3050883 }), true);
  assert.equal(sameBytes({ eTag: '"ccd1482f"', contentLength: 3050883 }, { eTag: '"e8787c58"', contentLength: 3050883 }), false);
  assert.equal(sameBytes({ eTag: '"ccd1482f"', contentLength: 3050883 }, { eTag: '"ccd1482f"', contentLength: 3050884 }), false);
  assert.equal(sameBytes({ eTag: null, contentLength: 1 }, { eTag: null, contentLength: 1 }), false);
  assert.equal(sameBytes(null, { eTag: '"a"', contentLength: 1 }), false);

  console.log("test:duplicate-slots OK");
}

main();
