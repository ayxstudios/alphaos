// Approve stops and speed (Ayser 2026-10-22: "The Auto QC saying its the wrong file, wont send it, even if ive approved
// and written OK. dont override what i say"; "it takes ages to load the next one"). Pure, no database.
import assert from "node:assert/strict";

// Dummy storage settings: presigning is local maths, nothing is sent anywhere.
process.env.R2_ENDPOINT = "https://example.r2.cloudflarestorage.com";
process.env.R2_BUCKET = "test-bucket";
process.env.R2_ACCESS_KEY_ID = "test-key";
process.env.R2_SECRET_ACCESS_KEY = "test-secret";

import { createApprovalStore, OVERRIDABLE_CODES, type CommitResult } from "../components/qc/pending-approvals-store";
import type { AutoQcView } from "../lib/qc/auto-qc";
import { approveStopOf } from "../lib/qc/approve-data";
import { wrongFileNoteText } from "../lib/qc/auto-qc-text";
import { MIN_OVERRIDE_REASON, autoQcWrongFileReason } from "../lib/qc/wrong-file";
import { STABLE_GET_WINDOW_SECONDS, presignGetStable } from "../lib/storage/r2";

const A = "11111111-1111-1111-1111-111111111111";

function view(p: Partial<AutoQcView>): AutoQcView {
  return {
    id: "q1",
    verdict: "issues",
    summary: null,
    portraits: [{ portrait: null, assetId: "a1", verdict: "issues", summary: "", checks: [] }],
    revision: null,
    model: "sonnet",
    wrongFile: null,
    createdAt: new Date().toISOString(),
    current: true,
    issues: 0,
    ...p,
  };
}

(async () => {
  // 1. Any word is a reason: his "OK" (2 letters) was refused by the old minimum of 4.
  assert.ok("OK".trim().length >= MIN_OVERRIDE_REASON);
  assert.ok("k".length >= MIN_OVERRIDE_REASON);

  // 2. Auto QC's wrongFile holds only while the file it flagged is going out.
  const twoPortraits = [
    { portrait: 1, assetId: "p1", verdict: "pass", summary: "", checks: [] },
    { portrait: 2, assetId: "p2-old", verdict: "issues", summary: "", checks: [] },
  ];
  // 4204945315's real wording: "Portrait 2 (other_order): This file shows Katie ... uploaded in Monica's place."
  const named = { assetIds: ["p1", "p2-old"], portraits: twoPortraits, wrongFile: { kind: "other_order", note: "Portrait 2 (other_order): This file shows Katie" } };
  assert.equal(autoQcWrongFileReason(named, ["p1", "p2-old"])?.kind, "auto_qc");
  assert.equal(autoQcWrongFileReason(named, ["p2-old", "p1"])?.kind, "auto_qc"); // order does not matter
  // The designer replaced portrait 2: the old flag must not stop the fix (it did: one shared file was enough).
  assert.equal(autoQcWrongFileReason(named, ["p1", "p2-new"]), null);
  // Portrait 1 replaced, flagged portrait 2 still going out: still stopped (the reviewer's catch).
  assert.equal(autoQcWrongFileReason(named, ["p1-new", "p2-old"])?.kind, "auto_qc");
  // A note naming no portrait: exactly the judged files.
  const whole = { assetIds: ["a1"], portraits: [{ portrait: null, assetId: "a1" }], wrongFile: { kind: "other_order", note: "This is order 4209142032's drawing" } };
  assert.equal(autoQcWrongFileReason(whole, ["a1"])?.kind, "auto_qc");
  assert.equal(autoQcWrongFileReason(whole, ["a2"]), null);
  assert.equal(autoQcWrongFileReason({ assetIds: ["p1"], wrongFile: null }, ["p1"]), null);
  assert.equal(autoQcWrongFileReason(null, ["p1"]), null);

  // 3. The Approve screen shows the same finding before the tap.
  const wf = approveStopOf(view({ wrongFile: { kind: "other_order", note: "This looks like Quimby's art." } }), ["a1"]);
  assert.equal(wf?.kind, "wrong_file");
  assert.match(wf?.message ?? "", /^Auto QC thinks this is the wrong file: This looks like Quimby's art\.$/);
  assert.equal(approveStopOf(view({ wrongFile: { kind: "other_order", note: "x" }, current: false }), ["a2"]), null); // a newer upload
  const p2 = approveStopOf(
    view({ portraits: twoPortraits as AutoQcView["portraits"], current: false, wrongFile: { kind: "other_order", note: "Portrait 2 (other_order): Katie" } }),
    ["p1-new", "p2-old"],
  );
  assert.equal(p2?.kind, "wrong_file"); // same rule as the gate, though the check is no longer "current"
  // The finding's code word stays out of what the owner reads (stored text untouched: the gate reads "Portrait N").
  assert.equal(p2?.message, "Auto QC thinks this is the wrong file: Portrait 2: Katie.");
  assert.equal(wrongFileNoteText("Portrait 2 (subject_count): Still the cat. Portrait 1 (other_order): x"), "Portrait 2: Still the cat. Portrait 1: x");
  assert.equal(wrongFileNoteText("This is order 4209142032's drawing (see photo 2)"), "This is order 4209142032's drawing (see photo 2)");
  const partly = approveStopOf(view({ revision: { done: "partly", missed: ["photo booth"], note: "" } }), ["a1"]);
  assert.equal(partly?.kind, "revision_not_done");
  assert.match(partly?.message ?? "", /only partly done\. Missed: photo booth\./);
  assert.equal(approveStopOf(view({ revision: { done: "partly", missed: [], note: "" }, current: false }), ["a2"]), null);
  assert.equal(approveStopOf(view({ revision: { done: "yes", missed: [], note: "" } }), ["a1"]), null);
  assert.equal(approveStopOf(null, ["a1"]), null);

  // 4. The queue carries the owner's words to the send, and a stopped send takes them on Retry.
  let clock = 0;
  const tasks: { at: number; fn: () => void; dead: boolean }[] = [];
  const advance = async (ms: number) => {
    clock += ms;
    for (const t of tasks) if (!t.dead && t.at <= clock) { t.dead = true; t.fn(); }
    await new Promise((r) => setImmediate(r));
  };
  const calls: string[] = [];
  let answer: CommitResult = { ok: false, code: "wrong_file", message: "Auto QC says this is the wrong file: x." };
  const store = createApprovalStore({
    commit: async (id, _f, why) => (calls.push(`commit:${id}:${why ?? ""}`), answer),
    beacon: async (id, _f, why) => (calls.push(`beacon:${id}:${why ?? ""}`), answer),
    schedule: (fn, ms) => { const t = { at: clock + ms, fn, dead: false }; tasks.push(t); return t; },
    cancel: (h) => { (h as { dead: boolean }).dead = true; },
    now: () => clock,
  });
  store.enqueue({ orderId: A, orderNumber: "4206362665", customerName: "Jo" });
  await advance(8000);
  assert.deepEqual(calls, [`commit:${A}:`]);
  const failed = store.getRows()[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.code, "wrong_file");
  assert.ok(OVERRIDABLE_CODES.has(failed.code!));
  answer = { ok: true, title: "Sent" };
  store.retry(A, "  OK ");
  await advance(0);
  assert.deepEqual(calls, [`commit:${A}:`, `commit:${A}:OK`]);
  assert.equal(store.getRows()[0].status, "sent");
  assert.equal(store.getRows()[0].code, undefined);

  // Words given on the screen go with the first send, and with the flush when the page closes.
  const B = "22222222-2222-2222-2222-222222222222";
  store.enqueue({ orderId: B, orderNumber: "PC1", customerName: "Al", overrideReason: "OK" });
  store.flush();
  await advance(0);
  assert.equal(calls[calls.length - 1], `beacon:${B}:OK`);

  // 5. Screen images keep one URL for a 10-minute window, so the preloaded next artwork is the one the next screen shows.
  const t0 = Date.UTC(2026, 9, 22, 2, 0, 5);
  const u1 = await presignGetStable("orders/x/art.png", t0);
  const u2 = await presignGetStable("orders/x/art.png", t0 + 4 * 60_000);
  assert.equal(u1, u2);
  const u3 = await presignGetStable("orders/x/art.png", t0 + STABLE_GET_WINDOW_SECONDS * 1000);
  assert.notEqual(u1, u3);
  const q = new URL(u2).searchParams;
  const signedAt = Date.parse(q.get("X-Amz-Date")!.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z"));
  // Signed at the window's start, and still valid an hour after the last render in that window.
  const windowStart = Math.floor(t0 / (STABLE_GET_WINDOW_SECONDS * 1000)) * STABLE_GET_WINDOW_SECONDS * 1000;
  assert.equal(signedAt, windowStart);
  assert.ok(signedAt + Number(q.get("X-Amz-Expires")) * 1000 >= windowStart + STABLE_GET_WINDOW_SECONDS * 1000 + 3600_000);

  console.log("approve-stop: all checks passed");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
