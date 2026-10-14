// Which upload stands for which portrait, and so which files a proof email
// carries (two portraits in one email, Yousif 2026-10-14; 4199589633, where the
// dog was uploaded but only the cat showed, 2026-10-14). Models the real orders
// first, then single / tagged / loose picks, gaps, revisions, over-uploads,
// stale tags, pins, and Auto QC judging the same files the email will carry.
// Pure, no database.
import assert from "node:assert/strict";

import { buildPortraitSlots, type PortraitItem } from "../lib/orders/portraits";
import {
  pickDefaultProofFiles,
  pinnedSlots,
  portraitList,
  type ProofFilePick,
  type ProofFileRow,
} from "../lib/proofs/files";
import { latestSlots, slotAssetIds } from "../lib/qc/auto-qc";
import type { QcVersion } from "../lib/qc/data";

/** A moment `seconds` after 2026-10-14 03:00 UTC. */
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 3, 0, 0) + seconds * 1000).toISOString();
const item = (id: string, title: string | null, quantity = 1, variation: string | null = null): PortraitItem => ({
  id,
  title,
  variation,
  sku: null,
  quantity,
});
/** An upload; `line` = assets.order_item_id, `unit` = assets.portrait_unit. */
const file = (id: string, seconds: number, line: string | null = null, unit: number | null = null): ProofFileRow => ({
  id,
  type: "submission",
  createdAt: at(seconds),
  orderItemId: line,
  portraitUnit: unit,
});
const pickOf = (
  slots: ReturnType<typeof buildPortraitSlots>,
  files: ProofFileRow[],
  roundStartedAt: string | null = null,
  pinned?: Record<string, string>,
) => pickDefaultProofFiles({ slots, files, roundStartedAt, pinned });
const ids = (pick: ProofFilePick) => pick.files.map((f) => f.assetId);
const shape = (pick: ProofFilePick) => pick.files.map((f) => [f.n, f.slotKey, f.matched]);
const gaps = (pick: ProofFilePick) => pick.missing.map((m) => m.n);

// ---- The real orders ------------------------------------------------------
// 4199589633: ONE line bought twice (Number Of Pets: 1 x 2): a dog and a cat.
// Abdul uploaded both in one go (same timestamp), each tagged to the line with
// no unit (uploads made before units counted). Only the cat ever showed.
const dogCatLine = buildPortraitSlots([item("7b5d", "Custom Watercolor Pet Portrait", 2, "Number Of Pets: 1")], null);
let pick = pickOf(dogCatLine, [file("bd93-cat", 0, "7b5d"), file("16ae-dog", 0, "7b5d")]);
assert.equal(pick.mode, "slots");
assert.equal(pick.expected, 2);
assert.deepEqual(ids(pick), ["16ae-dog", "bd93-cat"], "both pets are in, ties broken by id");
assert.deepEqual(shape(pick), [[1, "7b5d", "order"], [2, "7b5d:2", "order"]]);
assert.deepEqual(gaps(pick), []);
assert.deepEqual(pick.warnings, [], "units of one line: matching by order is not a guess worth a warning");
assert.deepEqual(pick.slotOf, { "16ae-dog": 1, "bd93-cat": 2 });

// 4200816588: ONE line, quantity 2, two untagged files. Emailed 1 of 2 before.
const twoOfOne = buildPortraitSlots([item("L1", "Custom Pet Portrait", 2, "Watercolor")], null);
pick = pickOf(twoOfOne, [file("f1", 0), file("f2", 45)]);
assert.deepEqual(ids(pick), ["f1", "f2"]);
assert.deepEqual(shape(pick), [[1, "L1", "order"], [2, "L1:2", "order"]]);
assert.deepEqual(pick.warnings, []);
assert.deepEqual(pick.candidates, ["f2", "f1"], "candidates are every live file, newest first");
assert.equal(pick.roundStartedAt, null);

// 4198299787: the same shape, the files handed over newest first.
pick = pickOf(twoOfOne, [file("g2", 20), file("g1", 0)]);
assert.deepEqual(ids(pick), ["g1", "g2"], "portrait order follows upload order whatever order they load in");

// 4201015378: two lines (Loki, Pisuca) of quantity 1, two untagged files 6 s apart.
const lokiPisuca = buildPortraitSlots([item("LA", "Loki", 1), item("LB", "Pisuca", 1)], null);
pick = pickOf(lokiPisuca, [file("h1", 0), file("h2", 6)]);
assert.deepEqual(ids(pick), ["h1", "h2"]);
assert.deepEqual(shape(pick), [[1, "LA", "order"], [2, "LB", "order"]]);
assert.deepEqual(pick.warnings, [
  "Portraits 1 and 2 were matched to their files by upload order. Check each file is the right portrait.",
]);

// 4200343312: ONE line, quantity 9, nine untagged files in the same second.
const nine = buildPortraitSlots([item("N9", "Family Cartoon", 9)], null);
const nineIds = ["e9", "a1", "c3", "b2", "i9", "d4", "h8", "f6", "g7"];
pick = pickOf(nine, nineIds.map((id) => file(id, 0)));
assert.deepEqual(ids(pick), [...nineIds].sort(), "a batch keeps one stable order (id) for its 9 portraits");
assert.deepEqual(gaps(pick), []);
assert.deepEqual(pick.warnings, []);

// ---- Single portrait: today's choice, unchanged ---------------------------
const solo = buildPortraitSlots([item("S1", "Pet Portrait", 1, "8x10")], null);
pick = pickOf(solo, [file("v1", 0), file("v3", 20), file("v2", 10)]);
assert.equal(pick.mode, "single");
assert.deepEqual(ids(pick), ["v3"], "the newest upload, nothing else");
assert.deepEqual(shape(pick), [[1, null, "order"]], "an untagged file on a one-portrait order");
assert.deepEqual(pick.missing, [], "single orders leave gaps to the upload rule");
assert.deepEqual(pick.slotOf, {});
pick = pickOf(solo, [file("v1", 0, "S1"), file("v2", 10, "S1", 1)]);
assert.deepEqual(shape(pick), [[1, "S1", "tag"]]);
pick = pickOf(solo, []);
assert.deepEqual(pick.files, []);
assert.deepEqual(pick.warnings, ["No artwork uploaded yet."]);
pick = pickOf([], [file("x", 0)]);
assert.equal(pick.mode, "single", "an order with no portrait line still emails its newest file");
assert.deepEqual(ids(pick), ["x"]);

// ---- Tagged: newest per portrait ------------------------------------------
const dogCat = buildPortraitSlots([item("D", "Dog", 1), item("C", "Cat", 1)], null);
pick = pickOf(dogCat, [file("d0", 0, "D"), file("c1", 10, "C"), file("d1", 20, "D")]);
assert.deepEqual(ids(pick), ["d1", "c1"]);
assert.deepEqual(shape(pick), [[1, "D", "tag"], [2, "C", "tag"]]);
assert.deepEqual(pick.slotOf, { d0: 1, c1: 2, d1: 1 }, "every version knows its portrait, for the history strip");
assert.deepEqual(pick.warnings, []);

// Explicit units on a line bought twice; a newer unit-2 file replaces the old one.
pick = pickOf(twoOfOne, [file("u1", 0, "L1", 1), file("u2", 5, "L1", 2), file("u2b", 50, "L1", 2)]);
assert.deepEqual(ids(pick), ["u1", "u2b"]);
assert.deepEqual(shape(pick), [[1, "L1", "tag"], [2, "L1:2", "tag"]]);

// ---- Gaps -----------------------------------------------------------------
pick = pickOf(twoOfOne, [file("only", 0)]);
assert.deepEqual(ids(pick), ["only"]);
assert.deepEqual(gaps(pick), [2]);
assert.deepEqual(pick.missing[0], { n: 2, key: "L1:2", label: "Custom Pet Portrait · Watercolor · 2 of 2" });
assert.deepEqual(pick.warnings, ["Portrait 2 has no file yet."]);
pick = pickOf(nine, [file("a", 0, "N9", 1), file("b", 0, "N9", 4)]);
assert.deepEqual(gaps(pick), [2, 3, 5, 6, 7, 8, 9]);
assert.equal(pick.warnings[0], "Portraits 2, 3, 5, 6, 7, 8 and 9 have no file yet.");
pick = pickOf(twoOfOne, []);
assert.deepEqual(gaps(pick), [1, 2]);
assert.deepEqual(pick.warnings, ["No artwork uploaded yet."]);
pick = pickOf(dogCat, [file("d1", 0, "D"), file("d2", 9, "D")]);
assert.deepEqual(ids(pick), ["d2"], "two dog versions never cover the cat");
assert.deepEqual(gaps(pick), [2]);

// A unit tag wins its portrait; a no-unit file of the same line fills the other.
pick = pickOf(twoOfOne, [file("legacy", 0, "L1"), file("tagged2", 30, "L1", 2)]);
assert.deepEqual(shape(pick), [[1, "L1", "order"], [2, "L1:2", "tag"]]);
assert.deepEqual(ids(pick), ["legacy", "tagged2"]);
// A line-tagged loose file never fills another line's portrait; untagged ones may.
const twoLines = buildPortraitSlots([item("A", "Dog", 2), item("B", "Cat", 1)], null);
pick = pickOf(twoLines, [file("a-loose", 0, "A"), file("free", 5)]);
assert.deepEqual(shape(pick), [[1, "A", "order"], [2, "A:2", "order"]]);
assert.deepEqual(gaps(pick), [3]);

// ---- Rounds ---------------------------------------------------------------
// Legacy (untagged) full redo after a send-back: the new round wins.
pick = pickOf(twoOfOne, [file("o1", 0), file("o2", 10), file("n1", 130), file("n2", 140)], at(100));
assert.deepEqual(ids(pick), ["n1", "n2"]);
assert.equal(pick.roundStartedAt, at(100));
assert.deepEqual(pick.warnings, [], "older-round files are superseded, not 'left out'");
// Tagged partial revision: only portrait 2 was redone.
pick = pickOf(twoOfOne, [file("a1", 0, "L1", 1), file("b1", 0, "L1", 2), file("b2", 130, "L1", 2)], at(100));
assert.deepEqual(ids(pick), ["a1", "b2"]);
assert.deepEqual(gaps(pick), []);
// Untagged partial redo: the new file plus the newest older one (a guess the pins below remove).
pick = pickOf(twoOfOne, [file("o1", 0), file("o2", 10), file("n2", 130)], at(100));
assert.deepEqual(ids(pick), ["o2", "n2"]);

// ---- Over-uploads, stale tags, pins ---------------------------------------
pick = pickOf(twoOfOne, [file("x1", 0), file("x2", 10), file("x3", 20)]);
assert.deepEqual(ids(pick), ["x2", "x3"], "the newest two of the round");
assert.deepEqual(pick.warnings, ["1 more untagged file is not in this email."]);
pick = pickOf(dogCat, [file("d", 0, "D"), file("c", 5, "C"), file("late", 60)]);
assert.deepEqual(ids(pick), ["d", "c"], "a tag beats a newer untagged file");
assert.deepEqual(pick.warnings, ["1 more untagged file is not in this email."]);
// A tag to a line that is not a portrait (an add-on, a deleted line) is loose.
pick = pickOf(dogCat, [file("d", 0, "D"), file("odd", 5, "ADDON")]);
assert.deepEqual(shape(pick), [[1, "D", "tag"], [2, "C", "order"]]);
// A unit beyond the line's quantity (quantity lowered later) stays on its line.
pick = pickOf(twoOfOne, [file("u3", 0, "L1", 3), file("u1", 5, "L1", 1)]);
assert.deepEqual(shape(pick), [[1, "L1", "tag"], [2, "L1:2", "order"]]);
assert.deepEqual(ids(pick), ["u1", "u3"]);
// Pins from the last proof email turn untagged files into tagged ones.
pick = pickOf(twoOfOne, [file("o1", 0), file("o2", 10), file("n1", 130, "L1", 1)], at(100), { o1: "L1:2", o2: "L1" });
assert.deepEqual(ids(pick), ["n1", "o1"], "portrait 1 redone, portrait 2 keeps the file it was emailed as");
assert.deepEqual(shape(pick), [[1, "L1", "tag"], [2, "L1:2", "tag"]]);
pick = pickOf(dogCat, [file("x", 0, "D")], null, { x: "C" });
assert.deepEqual(shape(pick), [[1, "D", "tag"]], "a pin never moves a file off the line it is tagged to");
assert.deepEqual(pinnedSlots([{ assetId: "a", label: "x", slotKey: "L1:2" }, { assetId: "b", label: "y" }, null, "z"]), { a: "L1:2" });
assert.equal(pinnedSlots(null), undefined);
assert.equal(pinnedSlots([{ assetId: "a", label: "x" }]), undefined);

// Pure: the inputs are untouched.
const slotsIn = [...dogCat];
const filesIn = [file("d1", 20, "D"), file("c1", 10, "C"), file("d0", 0, "D")];
const before = structuredClone({ slotsIn, filesIn });
pickOf(slotsIn, filesIn);
assert.deepEqual({ slotsIn, filesIn }, before);

assert.equal(portraitList([2]), "Portrait 2");
assert.equal(portraitList([1, 2]), "Portraits 1 and 2");
assert.equal(portraitList([1, 2, 5]), "Portraits 1, 2 and 5");

// ---- Auto QC judges exactly what the email carries ------------------------
const version = (id: string, seconds: number, portrait: number | null = null): QcVersion => ({
  id,
  url: null,
  type: "submission",
  uploadedBy: null,
  createdAt: at(seconds),
  portrait,
});
// The dog and the cat: two slots, both judged, each as its own portrait.
const dogCatPick = pickOf(dogCatLine, [file("bd93-cat", 0, "7b5d"), file("16ae-dog", 0, "7b5d")]);
let judged = latestSlots([version("bd93-cat", 0, 2), version("16ae-dog", 0, 1)], dogCatLine, dogCatPick);
assert.deepEqual(
  judged.map((s) => [s.portrait, s.latest.id, s.previous?.id ?? null]),
  [[1, "16ae-dog", null], [2, "bd93-cat", null]],
);
assert.deepEqual(slotAssetIds(judged), ["16ae-dog", "bd93-cat"]);
// A revision: previous = the version before it on the same portrait.
const revPick = pickOf(dogCat, [file("d0", 0, "D"), file("c0", 5, "C"), file("d1", 200, "D")], at(100));
judged = latestSlots([version("d0", 0, 1), version("c0", 5, 2), version("d1", 200, 1)], dogCat, revPick);
assert.deepEqual(judged.map((s) => [s.portrait, s.latest.id, s.previous?.id ?? null]), [[1, "d1", "d0"], [2, "c0", null]]);
// A gap is simply not judged (the pick names it; Auto QC flags it).
const gapPick = pickOf(twoOfOne, [file("only", 0)]);
judged = latestSlots([version("only", 0, 1)], twoOfOne, gapPick);
assert.deepEqual(judged.map((s) => [s.portrait, s.latest.id]), [[1, "only"]]);
// Single: the pick's file even when timestamps tie and the versions arrive in another order.
const tiePick = pickOf(solo, [file("b", 0), file("a", 0)]);
judged = latestSlots([version("b", 0), version("a", 0)], solo, tiePick);
assert.deepEqual(judged.map((s) => [s.portrait, s.latest.id, s.previous?.id ?? null]), [[null, "b", "a"]]);
// Nine in one batch: nine slots.
const ninePick = pickOf(nine, nineIds.map((id) => file(id, 0)));
judged = latestSlots(nineIds.map((id) => version(id, 0, ninePick.slotOf[id])), nine, ninePick);
assert.equal(judged.length, 9);
assert.deepEqual(judged.map((s) => s.portrait), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
// Without a pick (an old caller): grouping by tag, as before.
judged = latestSlots([version("v1", 0), version("v2", 10)], solo);
assert.deepEqual(judged.map((s) => [s.portrait, s.latest.id]), [[null, "v2"]]);

console.log("proof files: all checks passed");
