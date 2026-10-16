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
  ["It’s perfect! Thank you for being patient with me making so many changes. I appreciate it and love the final product! Get Outlook for iOS ________________________________", 2, "happy"],
  ["Hi, I have to say it’s absolutely amazing thank you so much I love it there’s nothing I’d like to change about it, its perfect! Thank you so much Beth Sent from my iPhone", 0, "happy"],
  ["This is beautiful!! No changes needed!! Happy are those who dream dreams", 0, "happy"],
  ["This is perfect! Thank you so much for the adjustments.", 2, "happy"],
  ["Wow, this is looking great! One thing to alter- James is looking a little too sad here.", 1, "attention"],
  ["Please can you make pocket look more realistic Thank you Tammye", 1, "attention"],
  ["I am so sorry - this does not look like the female subject. Can we try and edit? ￼￼ Best regards", 1, "unhappy"],
  ["I actually think this 2nd version looks worse. Let's focus on the attached picture.", 2, "unhappy"],
  ["Hi, I still haven’t received shipping info. Are you able to provide that. Justice", 0, "unhappy"],
  ["I should hope that there would be no cost to me. None of the issues have been a result of my actions.", 3, "unhappy"],
  ["💖 Mary Kate reacted via Gmail", 0, "happy"],
  ["** Address not found ** Your message wasn't delivered to x@gmail.comm because the domain couldn't be found.", 0, "attention"],
  ["Hi, I would prefer the original for this order which I have attached if you could lighten up the black", 0, "attention"],
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
assert.equal(plain("Love it! Get Outlook for iOS ________________________________"), "Love it!");
assert.equal(plain("Yes thank you Sent from Yahoo Mail for iPhone"), "Yes thank you");
assert.equal(plain("Perfect! I love it!! Best, Emily Sent from my iPhone On Oct 11, 2026, at 5:12 AM, The Shop"), "Perfect! I love it!! Best, Emily");
assert.equal(plain("Looks amazing, all good to go From: orders@x.co Date: September 30, 2026 at 05:34:16 CDT To: Frank"), "Looks amazing, all good to go");
console.log(`eye sentiment: ${n + 9} checks passed`);
