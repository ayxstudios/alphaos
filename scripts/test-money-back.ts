// A buyer reply asking for money back is never applied or answered by the inbox agent (Yousif 2026-10-17: "say
// nothing until we confirm"); lib/email/money-back.ts decides what such a reply is.
// Run: npx tsx scripts/test-money-back.ts
import assert from "node:assert/strict";
import { moneyBackAsk } from "../lib/email/money-back";

const asks = [
  "They are wrong again. Can I just get a refund?",
  "I want my money back",
  "Please cancel my order",
  "I'd like to cancel",
  "I'll open a dispute with my bank",
  "I'll do a chargeback",
  "Can you reimburse me?",
  "cancel it please",
];
const notAsks = [
  "I don't want a refund, I just want it fixed",
  "Please do not cancel my order",
  "I never wanted my money back",
  "no need to cancel, it's fine",
  "Can you cancel the revision request?",
  "Love it, approved, please print",
  "Please make the dog's ears darker and remove the date",
  "rather than a refund could you redo it",
];
for (const s of asks) assert.ok(moneyBackAsk(s), `asks money back: ${s}`);
for (const s of notAsks) assert.equal(moneyBackAsk(s), null, `does not ask money back: ${s}`);
console.log(`money-back: ${asks.length + notAsks.length} cases pass`);
