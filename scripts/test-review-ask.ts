import assert from "node:assert/strict";
import { reviewAskBlocker, reviewAskBody } from "../lib/agent/review-ask";

const base = { source: "etsy", status: "approved", physical: false, happy: true, intent: "unclear" as const };
assert.equal(reviewAskBlocker(base), null, "happy digital approved etsy order asks");
assert.equal(reviewAskBlocker({ ...base, status: "complete" }), null);
assert.ok(reviewAskBlocker({ ...base, source: "shopify" }), "non-etsy never asks");
assert.ok(reviewAskBlocker({ ...base, happy: false }), "not happy never asks");
assert.ok(reviewAskBlocker({ ...base, intent: "revision_request" }), "revision never asks");
assert.ok(reviewAskBlocker({ ...base, intent: "question" }), "question never asks");
assert.ok(reviewAskBlocker({ ...base, status: "awaiting_approval" }), "unfinished digital never asks");
assert.ok(reviewAskBlocker({ ...base, physical: true, status: "approved" }), "physical waits for shipping");
assert.equal(reviewAskBlocker({ ...base, physical: true, status: "shipped" }), null, "shipped physical asks");
assert.equal(reviewAskBlocker({ ...base, physical: true, status: "delivered" }), null);

const body = reviewAskBody("Lynn", "Custom Portrait Shop");
assert.match(body, /Hi Lynn/);
assert.match(body, /review on Etsy/i);
assert.match(body, /Purchases and reviews/);
assert.doesNotMatch(body, /Ayser|Yousif|AI|bot/);
// the shop's one person signs it, never "the team" (Yousif 2026-10-28)
assert.doesNotMatch(body, /\bteam\b|\bour\b|\bwe\b/i);
assert.match(body, /Kindest Regards,\nMel$/);
assert.match(reviewAskBody("Lynn", "PixArt", "Regards,\nBrianna"), /Regards,\nBrianna$/);
console.log("test-review-ask: ok");
