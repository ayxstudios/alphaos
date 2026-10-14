// Approve queue (Yousif 2026-10-14): queue, stop, grace fire, flush, skip. Pure, no browser.
import assert from "node:assert/strict";

import { createApprovalStore, parseSkip, type CommitResult } from "../components/qc/pending-approvals-store";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
let clock = 0;
const tasks: { at: number; fn: () => void; dead: boolean }[] = [];
const advance = async (ms: number) => {
  clock += ms;
  for (const t of tasks) if (!t.dead && t.at <= clock) { t.dead = true; t.fn(); }
  await new Promise((r) => setImmediate(r));
};
const calls: string[] = [];
let answer: CommitResult = { ok: true, title: "Sent" };
const mk = () =>
  createApprovalStore({
    commit: async (id) => (calls.push(`commit:${id}`), answer),
    beacon: async (id) => (calls.push(`beacon:${id}`), answer),
    schedule: (fn, ms) => { const t = { at: clock + ms, fn, dead: false }; tasks.push(t); return t; },
    cancel: (h) => { (h as { dead: boolean }).dead = true; },
    now: () => clock,
  });
const info = (orderId: string) => ({ orderId, orderNumber: "CPS1", customerName: "Jo Smith" });

(async () => {
  assert.deepEqual(parseSkip(`${A},bad,${B},${A}`), [A, B]);
  assert.deepEqual(parseSkip(undefined), []);

  // Stop inside the window: nothing sent.
  let s = mk();
  s.enqueue(info(A));
  assert.deepEqual(s.skipIds(), [A]);
  await advance(7000);
  assert.equal(s.stop(A), true);
  await advance(5000);
  assert.deepEqual(calls, []);
  assert.deepEqual(s.getRows(), []);

  // Grace fires: commit once, then Sent, then gone.
  s = mk();
  s.enqueue(info(A));
  await advance(8000);
  assert.deepEqual(calls, [`commit:${A}`]);
  assert.equal(s.getRows()[0].status, "sent");
  assert.deepEqual(s.skipIds(), []);
  assert.equal(s.stop(A), false);
  await advance(2000);
  assert.deepEqual(s.getRows(), []);

  // Flush commits at once and never double-commits when the timer would fire.
  calls.length = 0;
  s = mk();
  s.enqueue(info(A));
  s.enqueue(info(B));
  s.flush();
  await advance(9000);
  assert.deepEqual(calls, [`beacon:${A}`, `beacon:${B}`]);

  // Stale answer drops the row and tells the screen.
  calls.length = 0;
  answer = { ok: false, code: "stale", message: "This one was already checked." };
  s = mk();
  let stale = 0;
  s.onEvent(() => stale++);
  s.enqueue(info(A));
  await advance(8000);
  assert.equal(stale, 1);
  assert.deepEqual(s.getRows(), []);

  // Someone else had it open first (lib/qc/claims.ts): same as stale, typed.
  answer = { ok: false, code: "claimed", message: "Ayser is already checking this one." };
  s = mk();
  const seen: string[] = [];
  s.onEvent((e) => seen.push(e.type));
  s.enqueue(info(A));
  await advance(8000);
  assert.deepEqual(seen, ["claimed"]);
  assert.deepEqual(s.getRows(), []);
  assert.deepEqual(s.skipIds(), []);

  // Failure keeps the row (still skipped); Retry sends again.
  answer = { ok: false, code: "timeout", message: "No answer" };
  s = mk();
  s.enqueue(info(A));
  await advance(8000);
  assert.equal(s.getRows()[0].status, "failed");
  assert.deepEqual(s.skipIds(), [A]);
  answer = { ok: true, title: "Sent" };
  s.retry(A);
  await advance(0);
  assert.equal(s.getRows()[0].status, "sent");
  assert.equal(s.getRows()[0].delivery, "email");

  // No email on file: the row keeps that it went as an Etsy message.
  s = mk();
  answer = { ok: true, title: "Queued for Etsy", delivery: "etsy" };
  s.enqueue(info(A));
  await advance(8000);
  assert.equal(s.getRows()[0].status, "sent");
  assert.equal(s.getRows()[0].delivery, "etsy");
  console.log("approve queue: all checks passed");
})();
