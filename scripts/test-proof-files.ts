// Which files a proof email carries by default (two portraits in one email,
// Yousif 2026-10-14). Models the four real orders that went out with 1 of
// their 2 portraits, then single / tagged / round picks, partial revisions,
// over-uploads, stale tags, and Auto QC judging the same files the email will
// carry. Pure, no database.
import assert from "node:assert/strict";

import { buildPortraitSlots, slotKeyOf, type PortraitItem } from "../lib/orders/portraits";
import { pickDefaultProofFiles, type ProofFilePick, type ProofFileRow } from "../lib/proofs/files";
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
const file = (id: string, seconds: number, slotKey: string | null = null, type = "submission"): ProofFileRow => ({
  id,
  type,
  createdAt: at(seconds),
  slotKey,
});
const pickOf = (slots: ReturnType<typeof buildPortraitSlots>, files: ProofFileRow[], roundStartedAt: string | null = null) =>
  pickDefaultProofFiles({ slots, files, roundStartedAt });
const ids = (pick: ProofFilePick) => pick.files.map((f) => f.assetId);
const shape = (pick: ProofFilePick) => pick.files.map((f) => [f.n, f.label, f.slotKey]);

// ---- The four real orders ------------------------------------------------
// 4200816588: ONE line, quantity 2, two untagged designer files. Emailed 1 of 2 before.
const twoOfOne = buildPortraitSlots([item("L1", "Custom Pet Portrait", 2, "Watercolor")], null);
let pick = pickOf(twoOfOne, [file("f1", 0), file("f2", 45)]);
assert.equal(pick.mode, "round");
assert.equal(pick.expected, 2);
assert.deepEqual(ids(pick), ["f1", "f2"]);
assert.deepEqual(shape(pick), [[1, "Portrait 1", null], [2, "Portrait 2", null]]);
assert.deepEqual(pick.warnings, []);
assert.deepEqual(pick.candidates, ["f2", "f1"], "candidates are every live file, newest first");
assert.equal(pick.roundStartedAt, null);

// 4198299787: the same shape, the files handed over newest first.
pick = pickOf(twoOfOne, [file("g2", 20), file("g1", 0)]);
assert.equal(pick.mode, "round");
assert.deepEqual(ids(pick), ["g1", "g2"], "the email lists the files oldest first whatever order they load in");
assert.deepEqual(pick.warnings, []);

// 4201015378: two lines (Loki, Pisuca) of quantity 1, two untagged files 6 s apart.
const lokiPisuca = buildPortraitSlots([item("LA", "Loki", 1), item("LB", "Pisuca", 1)], null);
pick = pickOf(lokiPisuca, [file("h1", 0), file("h2", 6)]);
assert.equal(pick.mode, "round");
assert.deepEqual(ids(pick), ["h1", "h2"]);
assert.deepEqual(shape(pick), [[1, "Portrait 1", null], [2, "Portrait 2", null]]);
assert.deepEqual(pick.warnings, []);

// 4200343312: ONE line, quantity 9, nine untagged files uploaded in the same second.
const nine = buildPortraitSlots([item("N9", "Family Cartoon", 9)], null);
const nineIds = [
  "6f0e2a1c-4b7d-4a4e-9c11-0d2f5b8a7e30",
  "0a9c3e55-71d2-4f08-8b6a-2e4d9f1c6b72",
  "b3d1f7e8-0c44-49aa-a2e5-7f6c1d0e9a48",
  "2c8e4b90-5a13-4d6f-b7e2-9a0c3f5d1e86",
  "d94a0c17-8e2b-4b5d-8f3a-6c1e7b2d0a59",
  "41f6a8d3-9b0e-4c27-a5d8-3e7f2c6b1a04",
  "8e5b2d6a-3f91-4e0c-9a74-5d1c8f0b3e27",
  "f2a7c5e1-6d38-4b19-8e0f-1a9d4c7b5e63",
  "17d3b9f4-2e60-4a8c-b1f5-8c4e0a6d9b31",
];
const batch = nineIds.map((id) => file(id, 0));
const stableOrder = [...nineIds].sort();
pick = pickOf(nine, batch);
assert.equal(pick.mode, "round");
assert.equal(pick.expected, 9);
assert.deepEqual(ids(pick), stableOrder, "one batch shares a timestamp: the order falls back to the id, so it is stable");
assert.deepEqual(pick.files.map((f) => f.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.deepEqual(pick.warnings, []);
assert.equal(pick.candidates.length, 9);
for (const shuffled of [[...batch].reverse(), [...batch.slice(4), ...batch.slice(0, 4)], [batch[3], ...batch.slice(0, 3), ...batch.slice(4)]]) {
  assert.deepEqual(ids(pickOf(nine, shuffled)), stableOrder, "the same batch gives the same pick in any load order");
}
// Eight of the nine uploaded so far: the one missing portrait is flagged.
pick = pickOf(nine, batch.slice(0, 8));
assert.equal(pick.files.length, 8);
assert.deepEqual(pick.warnings, ["Only 8 of 9 portraits are new this round. Add the others below."]);

// ---- Single portrait: today's email, the newest upload -------------------
const solo = buildPortraitSlots([item("S1", "Pet Portrait", 1, "8x10")], null);
pick = pickOf(solo, [file("v1", 0), file("v2", 10), file("v3", 20)]);
assert.equal(pick.mode, "single");
assert.equal(pick.expected, 1);
assert.deepEqual(ids(pick), ["v3"]);
assert.deepEqual(shape(pick), [[1, "Pet Portrait · 8x10", null]]);
assert.deepEqual(pick.warnings, []);
assert.deepEqual(pick.candidates, ["v3", "v2", "v1"]);

// The QC email takes the newest by created_at and gives a final no preference.
assert.deepEqual(ids(pickOf(solo, [file("fin", 0, null, "final"), file("sub", 10)])), ["sub"]);
assert.deepEqual(ids(pickOf(solo, [file("sub", 0), file("fin", 10, null, "final")])), ["fin"]);

// The tag it carries is the current slot's, or none.
assert.equal(pickOf(solo, [file("t", 5, "S1")]).files[0].slotKey, "S1");
assert.equal(pickOf(solo, [file("t", 5, "another-item")]).files[0].slotKey, null);
assert.equal(pickOf(solo, [file("t", 5)]).files[0].slotKey, null);

// A send-back does not change a single portrait's pick, only what is reported.
pick = pickOf(solo, [file("old", 0)], at(100));
assert.equal(pick.mode, "single");
assert.deepEqual(ids(pick), ["old"]);
assert.deepEqual(pick.warnings, []);
assert.equal(pick.roundStartedAt, at(100));

// An order with no items still expects one portrait, labelled plainly.
pick = pickOf([], [file("only", 0)]);
assert.equal(pick.mode, "single");
assert.equal(pick.expected, 1);
assert.deepEqual(shape(pick), [[1, "Portrait", null]]);
// A slot with no label falls back to the same plain caption.
assert.deepEqual(shape(pickOf(buildPortraitSlots([item("S2", null)], null), [file("only", 0)])), [[1, "Portrait", null]]);

// ---- Tagged: one file per portrait from the designer's tags ---------------
const dogCat = buildPortraitSlots([item("D", "Dog", 1), item("C", "Cat", 1)], null);
// Two files on portrait 1, one on portrait 2: the newest of each.
pick = pickOf(dogCat, [file("d1", 0, "D"), file("c1", 10, "C"), file("d2", 20, "D")]);
assert.equal(pick.mode, "tagged");
assert.deepEqual(ids(pick), ["d2", "c1"], "slot order, each slot's newest tagged file");
assert.deepEqual(shape(pick), [[1, "Dog", "D"], [2, "Cat", "C"]]);
assert.deepEqual(pick.warnings, []);
assert.deepEqual(pick.candidates, ["d2", "c1", "d1"]);

// Slots given out of order are still read in portrait order.
assert.deepEqual(ids(pickOf([dogCat[1], dogCat[0]], [file("d1", 0, "D"), file("c1", 10, "C")])), ["d1", "c1"]);

// A line of quantity 2: tags use the item id for unit 1 and `id:2` for unit 2.
const twin = buildPortraitSlots([item("Q", "Twin Pets", 2)], null);
pick = pickOf(twin, [
  file("a", 0, slotKeyOf({ orderItemId: "Q", portraitUnit: null })),
  file("b", 5, slotKeyOf({ orderItemId: "Q", portraitUnit: 2 })),
]);
assert.equal(pick.mode, "tagged");
assert.deepEqual(shape(pick), [[1, "Twin Pets · 1 of 2", "Q"], [2, "Twin Pets · 2 of 2", "Q:2"]]);
assert.deepEqual(pick.warnings, []);

// An upload tagged before quantities counted still belongs to unit 1; unit 2 is empty.
pick = pickOf(twin, [file("legacy", 0, slotKeyOf({ orderItemId: "Q", portraitUnit: null }))]);
assert.equal(pick.mode, "tagged");
assert.deepEqual(ids(pick), ["legacy"]);
assert.deepEqual(pick.warnings, ["Twin Pets · 2 of 2 has no file yet."]);

// A portrait with no file is flagged by its label, or by its number when it has none.
assert.deepEqual(pickOf(dogCat, [file("d1", 0, "D")]).warnings, ["Cat has no file yet."]);
const dogAndBlank = buildPortraitSlots([item("D", "Dog", 1), item("B", null, 1)], null);
assert.deepEqual(pickOf(dogAndBlank, [file("d1", 0, "D")]).warnings, ["Portrait 2 has no file yet."]);

// Untagged files newer than the newest picked file are flagged, older ones are not.
pick = pickOf(dogCat, [file("d1", 0, "D"), file("c1", 10, "C"), file("u1", 20), file("u2", 30)]);
assert.deepEqual(ids(pick), ["d1", "c1"]);
assert.deepEqual(pick.warnings, ["2 newer untagged file(s) are not in this email."]);
assert.deepEqual(pickOf(dogCat, [file("u0", 5), file("d1", 0, "D"), file("c1", 10, "C")]).warnings, []);
assert.deepEqual(pickOf(dogCat, [file("d1", 0, "D"), file("c1", 10, "C"), file("same", 10)]).warnings, [], "only strictly newer counts");

// ---- A tag that names no current portrait is no tag ----------------------
// Nothing tagged to a real slot: the whole order reads as untagged (round).
pick = pickOf(twoOfOne, [file("x1", 0, "an-item-that-was-removed"), file("x2", 5, "L1:3")]);
assert.equal(pick.mode, "round");
assert.deepEqual(ids(pick), ["x1", "x2"]);
assert.deepEqual(shape(pick), [[1, "Portrait 1", null], [2, "Portrait 2", null]]);
assert.deepEqual(pick.warnings, []);
// Next to a real tag, a newer stale-tagged file counts as untagged.
pick = pickOf(dogCat, [file("d1", 0, "D"), file("c1", 10, "C"), file("z", 20, "removed-item")]);
assert.equal(pick.mode, "tagged");
assert.deepEqual(ids(pick), ["d1", "c1"]);
assert.deepEqual(pick.warnings, ["1 newer untagged file(s) are not in this email."]);
// A unit above the line's quantity is no portrait either (the quantity was lowered).
pick = pickOf(dogCat, [file("d1", 0, "D"), file("z", 10, "D:2")]);
assert.deepEqual(ids(pick), ["d1"]);
assert.deepEqual(pick.warnings, ["Cat has no file yet.", "1 newer untagged file(s) are not in this email."]);

// ---- Round: untagged files, the current round, one per portrait -----------
// Partial revision: both files went out, the customer asked for a change
// (send-back at 100 s), the designer has uploaded one new file so far.
const round1 = [file("o1", 0), file("o2", 10)];
pick = pickOf(twoOfOne, [...round1, file("n1", 130)], at(100));
assert.equal(pick.mode, "round");
assert.deepEqual(ids(pick), ["n1"]);
assert.deepEqual(pick.warnings, ["Only 1 of 2 portraits are new this round. Add the others below."]);
assert.equal(pick.roundStartedAt, at(100));
assert.deepEqual(pick.candidates, ["n1", "o2", "o1"], "older files stay available to pick by hand");
// The second new file arrives: both are picked and the warning goes away.
pick = pickOf(twoOfOne, [...round1, file("n1", 130), file("n2", 140)], at(100));
assert.deepEqual(ids(pick), ["n1", "n2"]);
assert.deepEqual(pick.warnings, []);
// Sent back but nothing uploaded yet: the earlier files are the pick (today's newest).
pick = pickOf(twoOfOne, round1, at(100));
assert.deepEqual(ids(pick), ["o1", "o2"]);
assert.deepEqual(pick.warnings, []);
// A file stamped exactly at the send-back is not new.
pick = pickOf(twoOfOne, [file("o1", 0), file("edge", 100), file("n1", 101)], at(100));
assert.deepEqual(ids(pick), ["n1"]);
assert.deepEqual(pick.warnings, ["Only 1 of 2 portraits are new this round. Add the others below."]);

// Only one of two uploaded on a first round.
pick = pickOf(twoOfOne, [file("first", 0)]);
assert.equal(pick.mode, "round");
assert.deepEqual(ids(pick), ["first"]);
assert.deepEqual(pick.warnings, ["Only 1 of 2 portraits are new this round. Add the others below."]);

// Over-upload: three files for two portraits, the newest two are picked.
pick = pickOf(twoOfOne, [file("p1", 0), file("p2", 10), file("p3", 20)]);
assert.equal(pick.mode, "round");
assert.deepEqual(ids(pick), ["p2", "p3"]);
assert.deepEqual(pick.files.map((f) => f.n), [1, 2]);
assert.deepEqual(pick.warnings, ["3 files were uploaded this round for 2 portraits. The newest 2 are picked."]);
assert.deepEqual(pick.candidates, ["p3", "p2", "p1"]);
// After a send-back only this round's files are counted.
pick = pickOf(twoOfOne, [file("old1", 0), file("old2", 5), file("p1", 110), file("p2", 120), file("p3", 130)], at(100));
assert.deepEqual(ids(pick), ["p2", "p3"]);
assert.deepEqual(pick.warnings, ["3 files were uploaded this round for 2 portraits. The newest 2 are picked."]);

// ---- No files -------------------------------------------------------------
pick = pickOf(twoOfOne, []);
assert.equal(pick.mode, "round");
assert.equal(pick.expected, 2);
assert.deepEqual(pick.files, []);
assert.deepEqual(pick.candidates, []);
assert.deepEqual(pick.warnings, ["No artwork uploaded yet."]);
pick = pickOf(solo, []);
assert.equal(pick.mode, "single");
assert.equal(pick.expected, 1);
assert.deepEqual(pick.files, []);
assert.deepEqual(pick.warnings, ["No artwork uploaded yet."]);

// ---- Odd input ------------------------------------------------------------
// An unreadable timestamp sorts as the oldest and does not throw.
pick = pickOf(twoOfOne, [{ id: "bad", type: "submission", createdAt: "not a date", slotKey: null }, file("good", 10)]);
assert.deepEqual(ids(pick), ["bad", "good"]);
// The input is never changed.
const slotsIn = [...dogCat];
const filesIn = [file("d1", 20, "D"), file("c1", 10, "C"), file("d0", 0, "D")];
const before = structuredClone({ slotsIn, filesIn });
pickOf(slotsIn, filesIn, at(5));
assert.deepEqual({ slotsIn, filesIn }, before);

// ---- Auto QC judges the same files the email carries ----------------------
const version = (id: string, portrait: number | null = null): QcVersion => ({
  id,
  url: `https://x/${id}.png`,
  type: "submission",
  uploadedBy: null,
  createdAt: at(0),
  portrait,
});

// Two untagged files on a two-portrait order (a round pick): one slot per file, email order.
const roundPick = pickOf(twoOfOne, [file("f1", 0), file("f2", 45)]);
const twoVersions = [version("f1"), version("f2")];
const judged = latestSlots(twoVersions, twoOfOne, roundPick);
assert.deepEqual(
  judged.map((s) => [s.portrait, s.latest.id, s.previous]),
  [[1, "f1", null], [2, "f2", null]],
);
assert.deepEqual(slotAssetIds(judged), ["f1", "f2"]);
// Without the pick the same order is judged on its newest file only, as before.
assert.deepEqual(latestSlots(twoVersions, twoOfOne).map((s) => [s.portrait, s.latest.id]), [[null, "f2"]]);

// The nine-portrait order: nine slots in the email's order.
const nineVersions = batch.map((f) => version(f.id));
const nineJudged = latestSlots(nineVersions, nine, pickOf(nine, batch));
assert.deepEqual(nineJudged.map((s) => s.latest.id), stableOrder);
assert.deepEqual(nineJudged.map((s) => s.portrait), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

// The pick decides the files, not the versions list: after a send-back only the new ones.
const revised = pickOf(twoOfOne, [file("o1", 0), file("o2", 10), file("n1", 130), file("n2", 140)], at(100));
const revisedJudged = latestSlots([version("o1"), version("o2"), version("n1"), version("n2")], twoOfOne, revised);
assert.deepEqual(revisedJudged.map((s) => [s.portrait, s.latest.id]), [[1, "n1"], [2, "n2"]]);

// A single pick leaves the judging exactly as it was.
const soloVersions = [version("v1"), version("v2"), version("v3")];
const soloPick = pickOf(solo, [file("v1", 0), file("v2", 10), file("v3", 20)]);
assert.deepEqual(latestSlots(soloVersions, solo, soloPick), latestSlots(soloVersions, solo));
assert.equal(latestSlots(soloVersions, solo, soloPick)[0].previous?.id, "v2");

// A tagged pick leaves it as it was too: one slot per tagged portrait.
const taggedVersions = [version("d1", 1), version("c1", 2), version("d2", 1)];
const taggedPick = pickOf(dogCat, [file("d1", 0, "D"), file("c1", 10, "C"), file("d2", 20, "D")]);
assert.deepEqual(latestSlots(taggedVersions, dogCat, taggedPick), latestSlots(taggedVersions, dogCat));
assert.deepEqual(latestSlots(taggedVersions, dogCat, taggedPick).map((s) => [s.portrait, s.latest.id, s.previous?.id ?? null]), [
  [1, "d2", "d1"],
  [2, "c1", null],
]);

// A round pick that found only one file is judged as today: the newest.
const lonePick = pickOf(twoOfOne, [file("only", 0)]);
assert.deepEqual(latestSlots([version("only")], twoOfOne, lonePick).map((s) => [s.portrait, s.latest.id]), [[null, "only"]]);

// A picked file the versions do not hold cannot be judged: fall back to today's grouping.
assert.deepEqual(latestSlots([version("f2")], twoOfOne, roundPick).map((s) => [s.portrait, s.latest.id]), [[null, "f2"]]);

console.log("proof files: all checks passed");
