// Buyer mood on the All Seeing Eye, checked against real buyer replies (names kept to first names).
// Run: npx tsx scripts/test-eye-sentiment.ts
import assert from "node:assert/strict";
import { buyerSentiment, plain } from "../lib/eye/data";

const cases: [string, number, string][] = [
  ["Sounds great, thanks for the update! On Fri, Oct 16, 2026 at 12:36 AM The Custom Portrait Shop wrote: we need a refund form", 3, "happy"],
  ["Absolutely beautiful! It is so perfect. Thank you SO much! Maya :) On Mon, Oct 12, 2026 at 8:04 AM The Custom Portrait Shop wrote:", 3, "happy"],
  ["Thanks, I approved it! Sent from my iPhone On Oct 11, 2026, at 10:07 PM, The Custom Portrait Shop &lt;orders@x.com&gt; wrote:", 3, "happy"],
  ["Good news indeed. Thank you! Yahoo Mail: Search, Organize, Conquer", 0, "happy"],
  ["That looks perfect!", 0, "happy"],
  ["Hi Mel, Would it be okay to try the eyes for the baby again? They still look a bit off", 5, "attention"],
  ["Hello, Thank you so much for sharing this draft. I have a few adjustments I would like to make.", 6, "attention"],
  ["Yes that's fine Can you send express? What is the expected delivery time? Sent from Outlook for iOS", 0, "attention"],
  ["This is not what I ordered, I want a refund", 0, "unhappy"],
  ["I am still waiting for my order and it has been weeks", 0, "unhappy"],
  ["Honestly not great, the face looks wrong", 1, "unhappy"],
  ["", 4, "attention"],
  ["", 0, "neutral"],
];
let n = 0;
for (const [raw, rev, want] of cases) {
  const got = buyerSentiment(plain(raw), [], rev, false);
  assert.equal(got, want, `"${raw.slice(0, 60)}" rev=${rev}: got ${got}, want ${want}`);
  n++;
}
assert.equal(buyerSentiment("", [{ kind: "refund_request", summary: "" }], 0, false), "unhappy");
assert.equal(buyerSentiment("", [], 0, true), "happy");
// snippets: the quoted thread, entities and phone signatures are gone
assert.equal(plain("It&#39;s lovely! On Mon, Oct 12, 2026 at 8:04 AM Shop wrote: old text"), "It's lovely!");
assert.equal(plain("Thank you! Sent from my iPhone"), "Thank you!");
assert.equal(plain("Put it on 2 canvases please"), "Put it on 2 canvases please");
console.log(`eye sentiment: ${n + 5} checks passed`);
