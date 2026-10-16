// No limbo (docs/NO_LIMBO.md): the pure rules first, then every pass against a
// throwaway business of its own ("Limbo Test <stamp>": owner, three designers,
// one shop), which is deleted again at the end. Never run against production.
import "./load-env";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { runAgentTick } from "../lib/agent/autopilot";
import { classifyUnmatchedMail, clearUnmatchedReplies, orderNumbersIn } from "../lib/agent/junk-mail";
import {
  AGENT_DECISION_DAYS,
  autoCloseStaleExceptions,
  decisionHolds,
  getLimboCensus,
  handFailedAiToDesigners,
  handoverDueHours,
  isReactionOnly,
  ownerOf,
  pickOverflowDesigner,
  staleReason,
  stuckWords,
  styleQuotaLimit,
  styleSimilarity,
  watchWaitingStates,
  type ExceptionFacts,
  type OrderFacts,
} from "../lib/agent/limbo";
import {
  MAX_LINES,
  buyerWords,
  digestText,
  EMAIL_ONLY_WORDS,
  isDue,
  lineFor,
  mergeLines,
  onlyEmailMissing,
  plainWords,
  sendOwnerDigest,
  stripOrderPrefix,
  type DigestLine,
} from "../lib/agent/owner-digest";
import { closeNothingLeft, decideByAgent, listNeedsYou, noteByAgent, raiseToOwner, resolveByAgent, takeForAgent } from "../lib/agent/needs-you-desk";
import { resolveException } from "../lib/agent/exceptions";
import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import {
  activityLog,
  alphaEvents,
  assignments,
  businesses,
  customers,
  designerBusinesses,
  designerProfiles,
  emailSenderIgnores,
  exceptions,
  messages,
  orderItems,
  orders,
  shops,
  users,
} from "../lib/db/schema";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const HOUR = 3_600_000;
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

function pureTests() {
  const facts = (f: Partial<ExceptionFacts>): ExceptionFacts => ({
    kind: "no_eligible_designer",
    hasOrder: true,
    status: "ready_to_assign",
    archived: false,
    closedAfterOpen: false,
    needsReview: false,
    activeAssignment: false,
    activeIsAgent: false,
    replySentAfter: false,
    failedMailSent: false,
    styleMapped: false,
    productOrdersHeld: false,
    ...f,
  });
  const reaction = "Jane Doe reacted via Gmail <https://www.google.com/gmail/about/?utm_source=gmail-in-product&utm_medium=et&utm_campaign=emojireactionemail#app>";

  check("L1 no designer: closes once a designer has it", staleReason(facts({ activeAssignment: true })) === "a designer has it");
  check("L1 no designer: stays open while nobody has it", staleReason(facts({})) === null);
  check("L1 intake: details complete once past intake", staleReason(facts({ kind: "intake_unparsed", status: "ready_to_assign" })) === "details complete");
  check("L1 intake: stays open while held for review", staleReason(facts({ kind: "intake_unparsed", status: "ready_to_assign", needsReview: true })) === null);
  check("L1 any kind: order closed", staleReason(facts({ kind: "intake_unparsed", status: "cancelled" })) === "order closed");
  check(
    "L1 buyer mail on a finished order stays open (new work)",
    staleReason(facts({ kind: "reply_unclear", status: "delivered", closedAfterOpen: false })) === null,
  );
  check(
    "L1 buyer mail closes when the order finished after it",
    staleReason(facts({ kind: "reply_unclear", status: "delivered", closedAfterOpen: true })) === "order closed",
  );
  check("L1 reply: the buyer was answered", staleReason(facts({ kind: "reply_unclear", status: "in_design", replySentAfter: true })) === "the buyer was answered");
  check(
    "L1 reply: an emoji reaction closes",
    staleReason(facts({ kind: "buyer_question", status: "in_design", excerpt: reaction })) === "an emoji reaction, nothing to answer",
  );
  check("L1 reply: real words stay open", staleReason(facts({ kind: "reply_unclear", status: "in_design", excerpt: "Can you make the ears lighter?" })) === null);
  check("L1 photos: went to a designer", staleReason(facts({ kind: "photo_count_mismatch", activeAssignment: true })) === "went to a designer with the photos it had");
  check("L1 add-on: linked", staleReason(facts({ kind: "addon_only", status: "fulfillment_only" })) === "linked to its portrait order");
  check("L1 email failed: went out", staleReason(facts({ kind: "email_send_failed", status: "in_design", failedMailSent: true })) === "the email went out");
  check(
    "L1 AI failed: AI still holding it stays open",
    staleReason(facts({ kind: "ai_designer_failed", status: "in_design", activeAssignment: true, activeIsAgent: true })) === null,
  );
  check(
    "L1 AI failed: a person has it",
    staleReason(facts({ kind: "ai_designer_failed", status: "in_design", activeAssignment: true, activeIsAgent: false })) === "a designer has it",
  );
  // Nicole Butterfield, CPS 4201282854 (2026-10-14): AI Studio holding an order
  // it gave up on is nobody, so her photo-count card must not close.
  const aiHold = { status: "in_design", activeAssignment: true, activeIsAgent: true, aiFailedHold: true };
  check("L1 photos: an AI hold the AI gave up on stays open", staleReason(facts({ kind: "photo_count_mismatch", ...aiHold })) === null);
  check("L1 no designer: an AI hold the AI gave up on stays open", staleReason(facts({ kind: "no_eligible_designer", ...aiHold })) === null);
  check("L1 add-on: an AI hold the AI gave up on stays open", staleReason(facts({ kind: "addon_only", ...aiHold })) === null);
  check(
    "L1 photos: AI Studio still drawing it is a designer",
    staleReason(facts({ kind: "photo_count_mismatch", status: "in_design", activeAssignment: true, activeIsAgent: true })) ===
      "went to a designer with the photos it had",
  );

  const due = { slaHours: 24, urgentHours: 3 };
  check("handover hours: the SLA when the buyer's date is far", handoverDueHours({ ...due, orderDueAt: new Date(now.getTime() + 100 * HOUR) }, now) === 24);
  check("handover hours: never past the buyer's date", handoverDueHours({ ...due, orderDueAt: new Date(now.getTime() + 10 * HOUR) }, now) === 10);
  check("handover hours: already due = the urgent SLA", handoverDueHours({ ...due, orderDueAt: ago(5) }, now) === 3);
  check("handover hours: no buyer date = the SLA", handoverDueHours({ ...due, orderDueAt: null }, now) === 24);
  check(
    "handover hours: overflow adds a day per full day of queue",
    handoverDueHours({ ...due, orderDueAt: null, overflowQueue: 7, dailyCapacity: 3 }, now) === 72,
  );

  check("reaction: Gmail emoji reaction", isReactionOnly(reaction));
  check("reaction: Outlook wording", isReactionOnly("Sam reacted to your message"));
  check("reaction: a real email is not one", !isReactionOnly("Thanks! The ears look great, can the collar be red?"));
  check("reaction: empty", !isReactionOnly(null) && !isReactionOnly(""));

  const order = (o: Partial<OrderFacts>): OrderFacts => ({
    id: "o",
    number: "1",
    status: "ready_to_assign",
    needsReview: false,
    inScope: true,
    enteredAt: ago(5),
    activeAssignment: false,
    aiFailedHold: false,
    hasContact: true,
    lastChaseAt: null,
    parentLive: false,
    openKinds: [],
    style: "Watercolor Pets",
    ...o,
  });
  const bucket = (o: Partial<OrderFacts>, opts?: { ignoreStuck?: boolean }) => ownerOf(order(o), now, opts);

  // A call a person or the agent made on the stuck row stands while nothing happens (owner, 2026-10-17).
  const holds = (d: Partial<NonNullable<OrderFacts["decision"]>>, o: Partial<OrderFacts> = {}) =>
    decisionHolds(
      order({ enteredAt: ago(30), decision: { at: ago(2), reason: "not_assigned", byAgent: true, note: "agent: drawn and approved by mail", ...d }, ...o }),
      "not_assigned",
      now,
    );
  const week = AGENT_DECISION_DAYS * 24;
  check("decision: the agent's call stands while nothing happens", holds({}));
  check("decision: no call, nothing holds", !decisionHolds(order({ enteredAt: ago(30) }), "not_assigned", now));
  check("decision: a different reason is a new problem", !holds({ reason: "details" }));
  check("decision: a call made before the order moved is moot", !holds({ at: ago(40) }));
  check("decision: something happened on the order since = raised again", !holds({}, { lastEventAt: ago(1) }));
  check("decision: what happened before the call changes nothing", holds({}, { lastEventAt: ago(3) }));
  check("decision: the agent's call is looked at again after a week", !holds({ at: ago(week + 1) }, { enteredAt: ago(week + 2) }));
  check("decision: a person's call holds past a week", holds({ at: ago(week + 1), byAgent: false }, { enteredAt: ago(week + 2) }));
  check("owner: a designer has it", bucket({ activeAssignment: true }).bucket === "designer");
  check("owner: proof with the buyer", bucket({ status: "awaiting_approval" }).bucket === "buyer");
  check("owner: QC is the pipeline", bucket({ status: "awaiting_qc" }).bucket === "pipeline");
  check("owner: raised = with the owner", bucket({ openKinds: ["no_eligible_designer"] }).bucket === "owner");
  const unassigned = bucket({});
  check("owner: nobody assigned past 2 h = limbo", unassigned.bucket === "limbo" && unassigned.reason === "not_assigned");
  check("owner: just arrived is still the pipeline", bucket({ enteredAt: ago(1) }).bucket === "pipeline");
  check("owner: photos asked for = the buyer", bucket({ status: "awaiting_photos", lastChaseAt: ago(48) }).bucket === "buyer");
  const noPhotos = bucket({ status: "awaiting_photos", lastChaseAt: ago(24 * 9) });
  check("owner: no photos a week after the reminder = limbo", noPhotos.bucket === "limbo" && noPhotos.reason === "no_photos");
  const noContact = bucket({ status: "awaiting_photos", hasContact: false, enteredAt: ago(13) });
  check("owner: no way to reach the buyer for 12 h = limbo", noContact.bucket === "limbo" && noContact.reason === "no_contact");
  check(
    "owner: details with no buyer email = the email filler still has it",
    bucket({ status: "awaiting_details", hasContact: false, enteredAt: ago(5) }).bucket === "buyer",
  );
  check(
    "owner: no buyer email yet = the email filler still has it",
    bucket({ status: "awaiting_photos", hasContact: false, enteredAt: ago(5) }).bucket === "buyer",
  );
  check("owner: add-on with its portrait order", bucket({ status: "fulfillment_only", parentLive: true }).bucket === "pipeline");
  check("owner: orphan add-on gets a day", bucket({ status: "fulfillment_only", enteredAt: ago(5) }).bucket !== "limbo");
  check("owner: orphan add-on after a day = limbo", bucket({ status: "fulfillment_only", enteredAt: ago(30) }).bucket === "limbo");
  check("owner: its own stuck row is ignored when judging it", bucket({ openKinds: ["stuck_order"] }, { ignoreStuck: true }).bucket === "limbo");
  check("owner: held for a check = limbo", bucket({ needsReview: true }).bucket === "limbo");
  const aiGaveUp = bucket({ status: "in_design", activeAssignment: true, aiFailedHold: true, enteredAt: ago(30) });
  check("owner: AI Studio holding an order it gave up on = limbo, not a designer", aiGaveUp.bucket === "limbo" && aiGaveUp.reason === "no_designer", JSON.stringify(aiGaveUp));
  check(
    "owner: the same with its AI-failed card open = with the owner",
    bucket({ status: "in_design", activeAssignment: true, aiFailedHold: true, openKinds: ["ai_designer_failed"] }).bucket === "owner",
  );
  check(
    "stuck words: an AI hold says the AI could not draw it",
    stuckWords("no_designer", { status: "in_design", lastChaseAt: null, hasContact: true, style: "Watercolor Pets", aiFailedHold: true }, null, now).summary ===
      "the AI designer could not draw it and no person has it",
  );

  const mail = (from: string, subject: string, excerpt: string) => classifyUnmatchedMail({ from, subject, excerpt });
  const pitch = mail("Growth Team <hello@scalefast.io>", "Partnership proposal for your store", "Hi there, we have an affiliate offer that can grow your sales.");
  check("mail: a partnership pitch is junk", pitch.verdict === "junk", pitch.reason);
  const reviews = mail("Reputation Desk <team@reviewfixers.co>", "Your reviews", "We can remove negative reviews from Trustpilot within days.");
  check("mail: a review-removal pitch is junk", reviews.verdict === "junk", reviews.reason);
  const fake = mail("Shopify Support <support@shopify-alerts.net>", "Action required", "Your store has been suspended. Verify your account now.");
  check("mail: a fake Shopify warning is junk", fake.verdict === "junk" && fake.reason === "pretends to be Shopify", fake.reason);
  const buyer = mail("Jane Smith <jane.smith@gmail.com>", "Re: my portrait", "Hi! Here are the photos of my dog for the portrait.");
  check("mail: a buyer is a customer", buyer.verdict === "customer", buyer.reason);
  const named = mail("Jane Smith <jane.smith@gmail.com>", "Order PC32132", "Any news?");
  check("mail: naming an order keeps it", named.verdict === "customer", named.reason);
  const bounce = mail("Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Address not found");
  check("mail: a bounce is unsure, never junk", bounce.verdict === "unsure" && bounce.reason === "an email we sent bounced", bounce.reason);
  const realShopify = mail("Shopify <mailer@shopify.com>", "Your weekly summary", "Here is how your store did.");
  check("mail: the real Shopify is a notification", realShopify.verdict === "junk", realShopify.reason);

  check("order numbers: Etsy receipt", orderNumbersIn("Re: Order #4201839306", null).includes("4201839306"));
  check("order numbers: shop prefix", orderNumbersIn("About PC32132", "and CPS10274").join(",") === "PC32132,CPS10274");
  check("order numbers: none", orderNumbersIn("Hello", "Love the shop").length === 0);

  const cand = (kind: string, hours: number, extra: { escalatedAt?: string | null; escalations?: number; emailOnly?: boolean } = {}) => ({
    kind,
    createdAt: ago(hours),
    escalatedAt: extra.escalatedAt ?? null,
    escalations: extra.escalations ?? 0,
    emailOnly: extra.emailOnly ?? false,
  });
  // Yousif 2026-10-13: a buyer's email is read off the Etsy order, never asked of a person first.
  const emailGap = { missing: ["customer email (not read from the Etsy order page yet)"] };
  check("email: an unread email alone is the filler's", onlyEmailMissing("intake_unparsed", emailGap));
  check("email: rows from before the rewording count too", onlyEmailMissing("intake_unparsed", { missing: ["customer email (Etsy did not share it)"] }));
  check("email: other gaps too = not email only", !onlyEmailMissing("intake_unparsed", { missing: [...emailGap.missing, "style"] }));
  check("email: a malformed email is not the filler's", !onlyEmailMissing("intake_unparsed", { missing: ['customer email ("a@b" does not look right)'] }));
  check("email: other kinds never", !onlyEmailMissing("stuck_order", emailGap));
  check(
    "due: an unread email waits for the filler's 12 h",
    !isDue(cand("intake_unparsed", 3, { emailOnly: true }), now) && isDue(cand("intake_unparsed", 13, { emailOnly: true }), now),
  );
  check("due: other intake gaps keep 2 h", isDue(cand("intake_unparsed", 3), now));
  check("words: an unread email never blames Etsy", !/did not share|hides?/i.test(EMAIL_ONLY_WORDS.summary + EMAIL_ONLY_WORDS.recommendation));
  check("due: no designer is raised at once", isDue(cand("no_eligible_designer", 0.1), now));
  check("due: a reply waits an hour first", !isDue(cand("reply_unclear", 0.5), now) && isDue(cand("reply_unclear", 2), now));
  check("due: photo shortfall is never raised", !isDue(cand("photo_count_mismatch", 100), now));
  check("due: not again within a day", !isDue(cand("stuck_order", 30, { escalatedAt: ago(5).toISOString(), escalations: 1 }), now));
  check("due: again after a day", isDue(cand("stuck_order", 30, { escalatedAt: ago(25).toISOString(), escalations: 1 }), now));
  check("due: three raises is the most", !isDue(cand("stuck_order", 300, { escalatedAt: ago(48).toISOString(), escalations: 3 }), now));

  check("words: no dashes, no system words", plainWords("The agent opened an exception — check it") === "I opened an issue, check it");
  check("words: shop order prefix goes", stripOrderPrefix("Etsy order #4201839306: could not resolve customer email") === "could not resolve customer email");
  check("words: plain order prefix goes", stripOrderPrefix("Order 4201: no designer") === "no designer");

  const said = buyerWords("Hi &amp; thanks! Can you make Bentley&#39;s ears lighter? <https://x.y/z>\nOn Mon, Oct 13, 2026 Shop wrote:\n> old text");
  check("quote: entities decoded, link and history dropped", said === "Hi & thanks! Can you make Bentley's ears lighter?", String(said));
  check("quote: long mail is cut short", (buyerWords("word ".repeat(80)) ?? "").endsWith("..."));
  check("quote: nothing to quote", buyerWords(null) === null && buyerWords("   ") === null);

  const line = (o: Partial<DigestLine>): DigestLine => ({
    exceptionId: randomUUID(),
    exceptionIds: [],
    groupKey: "order-1",
    businessId: "b",
    kind: "reply_unclear",
    shop: "PixArt",
    number: "4181693839",
    summary: "Buyer email on order 4181693839 needs a reply",
    recommendation: "",
    said: null,
    link: "https://alphaos.test/orders/1",
    createdAt: ago(3),
    ...o,
  });
  const a = line({ said: "first email" });
  a.exceptionIds = [a.exceptionId];
  const b = line({ createdAt: ago(2), said: "Can you make the ears lighter?" });
  b.exceptionIds = [b.exceptionId];
  const merged = mergeLines([b, a]);
  check("merge: two emails on one order = one line", merged.length === 1 && merged[0].exceptionIds.length === 2);
  check("merge: the newest email is quoted", merged[0].said === "Can you make the ears lighter?");
  const text = lineFor(merged[0]);
  check(
    "line: shop, number, count, quote, what to do, link",
    text.startsWith("• PixArt 4181693839: ") &&
      text.includes("(2 emails)") &&
      text.includes('They wrote: "Can you make the ears lighter?"') &&
      text.includes("Read the buyer's email on the order page and reply.") &&
      text.endsWith("https://alphaos.test/orders/1"),
    text,
  );
  check("line: never an em dash", !/[—–]/.test(text));
  const tagged = lineFor(line({ tags: ["upset", "refund"], exceptionIds: ["x"] }));
  check("line: what makes it the owner's leads, in bold", tagged.startsWith("• *Upset buyer, money back.* PixArt 4181693839: "), tagged);
  const legacy = lineFor(line({ kind: "legacy_order", summary: "Order not in AlphaOS yet. Check it on Trello, then confirm the details here.", exceptionIds: ["x"] }));
  check("line: an older order carries no second instruction", !legacy.includes("Find the order") && !legacy.includes("Open it and decide"), legacy);
  const many = Array.from({ length: MAX_LINES + 3 }, (_, i) => {
    const l = line({ number: String(1000 + i), groupKey: String(i) });
    l.exceptionIds = [l.exceptionId];
    return l;
  });
  const digest = digestText(many);
  check(
    "digest: header count, capped lines, the rest behind a link",
    digest.startsWith(`AlphaOS needs you (${MAX_LINES + 3})`) && digest.split("\n").length === MAX_LINES + 2 && digest.includes("+3 more: "),
  );

  check("style: close names score high", styleSimilarity("Watercolor Pets", "Minimal Watercolor Pet") >= 0.5);
  check("style: unrelated names score zero", styleSimilarity("Line Art", "Watercolor Pets") === 0);
  check("style: portrait alone says nothing", styleSimilarity("Storybook Portrait", "Cartoon Portrait") === 0);
  const limits = [{ businessId: "b1", styles: ["House", "Venue"], limit: 1, priority: 1 }];
  check("quota: covers its styles, any case", styleQuotaLimit(limits, "house", "b1") === 1);
  check("quota: other business or style = none", styleQuotaLimit(limits, "house", "b2") === null && styleQuotaLimit(limits, "Pets", "b1") === null);
  const pooled = [{ businessId: "b1", businessIds: ["b1", "b2"], styles: ["Cartoon"], limit: 6, priority: 1 }];
  check("quota: a pooled group covers every business in its pool", styleQuotaLimit(pooled, "cartoon", "b2") === 6 && styleQuotaLimit(pooled, "cartoon", "b3") === null);
  const valueGated = [{ businessId: "b1", styles: ["Cartoon"], orderTotalOver: 300, currency: "AUD", limit: 15, priority: 0 }];
  check("quota: a value-gated group is not a daily throttle", styleQuotaLimit(valueGated, "cartoon", "b1") === null);
}

// ---------------------------------------------------------------------------
// Every pass against a throwaway business
// ---------------------------------------------------------------------------

const stamp = Date.now();
const ids = {
  biz: randomUUID(),
  shop: randomUUID(),
  owner: randomUUID(),
  bea: randomUUID(),
  sol: randomUUID(),
  ai: randomUUID(),
};
const STYLE = "Watercolor Pets";

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({
      id: ids.biz,
      name: `Limbo Test ${stamp}`,
      slug: `limbo-test-${stamp}`,
      agentConfig: { ownerUserId: ids.owner },
    });
    await tx.insert(users).values([
      { id: ids.owner, email: `limbotest-owner-${stamp}@example.test`, name: "Limbo Owner", role: "admin" },
      { id: ids.bea, email: `limbotest-bea-${stamp}@example.test`, name: "Bea", role: "designer" },
      { id: ids.sol, email: `limbotest-sol-${stamp}@example.test`, name: "Sol", role: "designer" },
      { id: ids.ai, email: `limbotest-ai-${stamp}@example.test`, name: "AI Studio", role: "designer" },
    ]);
    await tx.insert(designerProfiles).values([
      // Bea is the style's main designer; Sol is throttled to 1 a day (never
      // overflow); AI Studio draws it too but never takes overflow.
      { userId: ids.bea, dailyCapacity: 3, styles: [STYLE], rank: 5 },
      { userId: ids.sol, dailyCapacity: 1, styles: [STYLE], rank: 1 },
      { userId: ids.ai, dailyCapacity: 20, styles: [STYLE], rank: 0, isAgent: true },
    ]);
    await tx.insert(designerBusinesses).values([ids.bea, ids.sol, ids.ai].map((userId) => ({ userId, businessId: ids.biz })));
    await tx.insert(shops).values({
      id: ids.shop,
      businessId: ids.biz,
      platform: "etsy",
      name: "Limbo Etsy",
      externalShopId: `limbo-${stamp}`,
      credentials: {},
    });
  });
}

let orderNo = 0;
async function mkOrder(o: {
  status: typeof orders.$inferInsert.status;
  hoursAgo: number;
  customerId?: string | null;
  style?: string | null;
  title?: string;
  aiState?: string | null;
}): Promise<{ id: string; number: string }> {
  orderNo++;
  const number = `LT${orderNo}`;
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        customerId: o.customerId ?? null,
        platformOrderId: `limbotest-${stamp}-${orderNo}`,
        platformOrderName: number,
        status: o.status,
        source: "manual",
        uploadToken: randomUUID(),
        aiState: o.aiState ?? null,
        createdAt: ago(o.hoursAgo),
      })
      .returning({ id: orders.id });
    await tx.insert(orderItems).values({
      businessId: ids.biz,
      orderId: row.id,
      title: o.title ?? "Custom pet portrait",
      figureCount: 1,
      figureCountSource: "manual",
      style: o.style === undefined ? STYLE : o.style,
      productType: "digital",
    });
    return { id: row.id, number };
  });
}

async function mkCustomer(email: string | null): Promise<string> {
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(customers)
      .values({ businessId: ids.biz, email: email ?? `limbotest-nobody-${randomUUID()}@example.invalid`, firstName: "Limbo", lastName: "Buyer" })
      .returning({ id: customers.id });
    return row.id;
  });
}

async function mkException(e: { orderId: string | null; kind: string; summary: string; detail?: Record<string, unknown>; hoursAgo: number }) {
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(exceptions)
      .values({ businessId: ids.biz, orderId: e.orderId, kind: e.kind, summary: e.summary, detail: e.detail ?? {}, createdAt: ago(e.hoursAgo) })
      .returning({ id: exceptions.id });
    return row.id;
  });
}

async function assign(orderId: string, designerId: string) {
  await withSystemContext(async (tx) => {
    await tx.update(assignments).set({ active: false }).where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
    await tx.insert(assignments).values({ businessId: ids.biz, orderId, designerId, active: true, dueAt: new Date(now.getTime() + 48 * HOUR) });
  });
}

async function mkInbound(address: string, subject: string, body: string): Promise<string> {
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({ businessId: ids.biz, direction: "inbound", channel: "email", status: "received", address, subject, body, createdAt: ago(5) })
      .returning({ id: messages.id });
    return row.id;
  });
}

const exceptionRow = (id: string) =>
  withSystemContext(async (tx) => {
    const [row] = await tx
      .select({ status: exceptions.status, note: exceptions.resolutionNote, detail: exceptions.detail })
      .from(exceptions)
      .where(eq(exceptions.id, id));
    return { ...row, detail: (row?.detail ?? {}) as Record<string, unknown> };
  });

const openOn = (orderId: string, kind: string) =>
  withSystemContext(async (tx) => {
    const [row] = await tx
      .select({ id: exceptions.id, detail: exceptions.detail })
      .from(exceptions)
      .where(and(eq(exceptions.orderId, orderId), eq(exceptions.kind, kind), eq(exceptions.status, "open")));
    return row ? { id: row.id, detail: (row.detail ?? {}) as Record<string, unknown> } : null;
  });

const activeDesigner = (orderId: string) =>
  withSystemContext(async (tx) => {
    const [row] = await tx
      .select({ designerId: assignments.designerId })
      .from(assignments)
      .where(and(eq(assignments.orderId, orderId), eq(assignments.active, true)));
    return row?.designerId ?? null;
  });

async function dbTests() {
  const buyerA = `limbotest-a-${stamp}@example.test`;
  const buyerB = `limbotest-b-${stamp}@example.test`;
  const custA = await mkCustomer(buyerA);
  const custB = await mkCustomer(buyerB);

  // --- L1: stale rows close themselves -------------------------------------
  const o1 = await mkOrder({ status: "ready_to_assign", hoursAgo: 5 });
  await assign(o1.id, ids.bea);
  const e1 = await mkException({ orderId: o1.id, kind: "no_eligible_designer", summary: `Order #${o1.number}: no designer can take it`, hoursAgo: 3 });
  const o2 = await mkOrder({ status: "delivered", hoursAgo: 72, customerId: custB });
  await withSystemContext((tx) =>
    tx.insert(activityLog).values({ businessId: ids.biz, orderId: o2.id, actorId: null, action: "order.status_changed", fromState: "printing", toState: "delivered", createdAt: ago(40) }),
  );
  const e2 = await mkException({
    orderId: o2.id,
    kind: "reply_unclear",
    summary: `Buyer email on order ${o2.number} needs a reply`,
    detail: { from: buyerB, excerpt: "Hi! The print arrived creased on one corner, can you send a new one?" },
    hoursAgo: 30,
  });
  const o3 = await mkOrder({ status: "awaiting_approval", hoursAgo: 20 });
  const e3 = await mkException({
    orderId: o3.id,
    kind: "reply_unclear",
    summary: `Buyer email on order ${o3.number} needs a reply`,
    detail: { excerpt: "Jane Doe reacted via Gmail <https://www.google.com/gmail/about/>" },
    hoursAgo: 5,
  });

  const dry = await autoCloseStaleExceptions(ids.biz, { now, dryRun: true });
  check("L1 dry run counts and writes nothing", dry.closed === 2 && (await exceptionRow(e1)).status === "open", JSON.stringify(dry.byReason));
  const l1 = await autoCloseStaleExceptions(ids.biz, { now });
  const r1 = await exceptionRow(e1);
  const r2 = await exceptionRow(e2);
  const r3 = await exceptionRow(e3);
  check("L1 closes: a designer has it", r1.status === "resolved" && r1.note === "auto: a designer has it", String(r1.note));
  check("L1 closes: an emoji reaction", r3.status === "resolved" && r3.note === "auto: an emoji reaction, nothing to answer", String(r3.note));
  check("L1 keeps: buyer mail about a delivered order", r2.status === "open");
  check("L1 result", l1.closed === 2 && l1.ids.length === 2, JSON.stringify(l1));
  const logged = await withSystemContext((tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(activityLog)
      .where(and(eq(activityLog.businessId, ids.biz), eq(activityLog.action, "agent.exception_auto_closed"))),
  );
  check("L1 logs one activity row per close", Number(logged[0]?.n) === 2);

  // --- L4: a live order nobody owns gets a row, and it closes once owned ----
  const o4 = await mkOrder({ status: "ready_to_assign", hoursAgo: 5 });
  const o5 = await mkOrder({ status: "awaiting_photos", hoursAgo: 30, customerId: custA });
  const before = await getLimboCensus(ids.biz, { now });
  check(
    "census: unowned orders are counted as limbo",
    before.limbo === 2 && before.limboOrders.map((o) => o.number).sort().join(",") === [o4.number, o5.number].sort().join(","),
    JSON.stringify(before),
  );
  const watched = await watchWaitingStates(ids.biz, { now });
  const s4 = await openOn(o4.id, "stuck_order");
  const s5 = await openOn(o5.id, "stuck_order");
  check("L4 opens a row for the unassigned order", watched.opened === 2 && !!s4, JSON.stringify(watched));
  check("L4 recommends the style's designer", s4?.detail.recommendation === "Give it to Bea.", String(s4?.detail.recommendation));
  check("L4 photos never asked for", s5?.detail.recommendation === "Send the photo request from the order page.", String(s5?.detail.recommendation));
  const after = await getLimboCensus(ids.biz, { now });
  check("census: raised orders leave limbo", after.limbo === 0 && after.withOwner >= 2, JSON.stringify(after));
  const again = await watchWaitingStates(ids.biz, { now });
  check("L4 a second pass opens nothing new", again.opened === 0 && again.refreshed === 0, JSON.stringify(again));
  await assign(o4.id, ids.bea);
  const owned = await watchWaitingStates(ids.biz, { now });
  const s4After = s4 ? await exceptionRow(s4.id) : null;
  check("L4 closes the row once a designer has it", owned.closed === 1 && s4After?.status === "resolved" && s4After.note === "auto: has a designer", String(s4After?.note));

  // --- L2: mail that matches no order ---------------------------------------
  const pitchFrom = "Growth Team <hello@scalefast.io>";
  const m1 = await mkInbound(pitchFrom, "Partnership proposal for your store", "Hi there, we have an affiliate offer that can grow your sales.");
  const e4 = await mkException({
    orderId: null,
    kind: "unmatched_reply",
    summary: "Email from hello@scalefast.io matches no order",
    detail: { messageId: m1, from: pitchFrom, subject: "Partnership proposal for your store" },
    hoursAgo: 5,
  });
  const m2 = await mkInbound(`Jane Smith <${buyerA}>`, "Re: your photos", "Hi, the photos are coming tonight, sorry for the wait!");
  const e5 = await mkException({ orderId: null, kind: "unmatched_reply", summary: `Email from ${buyerA} matches no order`, detail: { messageId: m2, from: buyerA }, hoursAgo: 5 });
  const m3 = await mkInbound("Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Address not found");
  const e6 = await mkException({
    orderId: null,
    kind: "unmatched_reply",
    summary: "Email from mailer-daemon@googlemail.com matches no order",
    detail: { messageId: m3, from: "mailer-daemon@googlemail.com" },
    hoursAgo: 5,
  });
  const mailDry = await clearUnmatchedReplies(ids.biz, { now, dryRun: true });
  check("L2 dry run sorts the mail", mailDry.junk === 1 && mailDry.matched === 1 && mailDry.kept === 1 && mailDry.closedIds.length === 2, JSON.stringify(mailDry));
  check("L2 dry run writes nothing", (await exceptionRow(e4)).status === "open");
  const mailRes = await clearUnmatchedReplies(ids.biz, { now });
  check("L2 result", mailRes.junk === 1 && mailRes.matched === 1 && mailRes.kept === 1, JSON.stringify(mailRes));
  const r4 = await exceptionRow(e4);
  check("L2 junk closes as not a customer", r4.status === "resolved" && r4.note === "auto: not a customer (partnership pitch)", String(r4.note));
  const [junkMsg] = await withSystemContext((tx) => tx.select({ suppressedAt: messages.suppressedAt }).from(messages).where(eq(messages.id, m1)));
  check("L2 junk email is put away", !!junkMsg?.suppressedAt);
  const ignored = await withSystemContext((tx) =>
    tx
      .select({ value: emailSenderIgnores.value })
      .from(emailSenderIgnores)
      .where(and(eq(emailSenderIgnores.businessId, ids.biz), eq(emailSenderIgnores.value, "hello@scalefast.io"))),
  );
  check("L2 junk sender is ignored from now on", ignored.length === 1);
  const r5 = await exceptionRow(e5);
  check("L2 buyer email is matched to their order", r5.status === "resolved" && r5.note === `auto: matched to order ${o5.number}`, String(r5.note));
  const [linked] = await withSystemContext((tx) => tx.select({ orderId: messages.orderId }).from(messages).where(eq(messages.id, m2)));
  const reply = await openOn(o5.id, "reply_unclear");
  check("L2 the email moves onto the order with a reply card", linked?.orderId === o5.id && reply?.detail.messageId === m2);
  const r6 = await exceptionRow(e6);
  check(
    "L2 a bounce stays open with what to do",
    r6.status === "open" && r6.detail.recommendation === "Check the buyer's email address on the order this was for, fix it, and resend.",
    String(r6.detail.recommendation),
  );

  // --- L3: overflow and the AI handover -------------------------------------
  const pick = await withSystemContext((tx) => pickOverflowDesigner(tx, ids.biz, STYLE));
  check("overflow: the style's main designer (never 1 a day, never AI)", pick?.designerId === ids.bea, JSON.stringify(pick));
  check("overflow: style matched in any case", (await withSystemContext((tx) => pickOverflowDesigner(tx, ids.biz, " watercolor pets ")))?.designerId === ids.bea);
  check("overflow: nobody draws it = nobody", (await withSystemContext((tx) => pickOverflowDesigner(tx, ids.biz, "Line Art"))) === null);
  await withSystemContext((tx) =>
    tx
      .update(designerProfiles)
      .set({ styleDailyLimits: [{ businessId: ids.biz, styles: [STYLE], limit: 1, priority: 1 }] })
      .where(eq(designerProfiles.userId, ids.bea)),
  );
  check("overflow: a style quota of 1 counts as a throttle", (await withSystemContext((tx) => pickOverflowDesigner(tx, ids.biz, STYLE))) === null);
  await withSystemContext((tx) => tx.update(designerProfiles).set({ styleDailyLimits: null }).where(eq(designerProfiles.userId, ids.bea)));

  const o6 = await mkOrder({ status: "in_design", hoursAgo: 30, aiState: "failed" });
  await assign(o6.id, ids.ai);
  // The buyer's date is 6 h away: the person gets 6 h, not the 24 h SLA.
  await withSystemContext((tx) => tx.update(orders).set({ dueAt: new Date(now.getTime() + 6 * HOUR) }).where(eq(orders.id, o6.id)));
  const e7 = await mkException({ orderId: o6.id, kind: "ai_designer_failed", summary: `Order #${o6.number}: AI could not finish it`, detail: { reason: "photo download 404" }, hoursAgo: 5 });
  const o7 = await mkOrder({ status: "in_design", hoursAgo: 30, aiState: "failed", style: "Line Art", title: "Storybook Portrait" });
  await assign(o7.id, ids.ai);
  const e8 = await mkException({ orderId: o7.id, kind: "ai_designer_failed", summary: `Order #${o7.number}: AI could not finish it`, hoursAgo: 5 });
  // Nicole Butterfield's shape (CPS 4201282854, 2026-10-14): the AI gave up, a
  // person closed the AI card without moving the order, and the photo-count
  // card was closed as "went to a designer". Nobody draws its style either.
  const o9 = await mkOrder({ status: "in_design", hoursAgo: 30, aiState: "failed", style: "Charcoal Sketch", title: "Charcoal Portrait" });
  await assign(o9.id, ids.ai);
  const e9 = await mkException({ orderId: o9.id, kind: "ai_designer_failed", summary: `Order #${o9.number}: AI could not finish it`, detail: { reason: "too few photos" }, hoursAgo: 20 });
  await withSystemContext((tx) => tx.update(exceptions).set({ status: "resolved", resolvedAt: ago(19), resolutionNote: "looked at it" }).where(eq(exceptions.id, e9)));
  const limboBefore = await getLimboCensus(ids.biz, { now });
  check(
    "census: an AI hold with no card open is limbo, not with a designer",
    limboBefore.limboOrders.some((o) => o.number === o9.number && o.why.startsWith("the AI designer gave up")),
    JSON.stringify(limboBefore.limboOrders),
  );
  const e10 = await mkException({ orderId: o9.id, kind: "photo_count_mismatch", summary: `Order #${o9.number}: 2 pets, 1 photo`, hoursAgo: 20 });
  const l1Again = await autoCloseStaleExceptions(ids.biz, { now });
  check("L1 keeps the photo card on an order the AI gave up on", (await exceptionRow(e10)).status === "open" && !l1Again.ids.includes(e10), JSON.stringify(l1Again.byReason));

  const aiDry = await handFailedAiToDesigners(ids.biz, { now, dryRun: true });
  check(
    "AI handover dry run",
    aiDry.handed === 1 && aiDry.kept === 2 && aiDry.reopened === 1 && (await activeDesigner(o6.id)) === ids.ai && !(await openOn(o9.id, "ai_designer_failed")),
    JSON.stringify(aiDry),
  );
  const ai = await handFailedAiToDesigners(ids.biz, { now });
  check("AI handover result", ai.handed === 1 && ai.kept === 2 && ai.reopened === 1 && ai.closedIds.join() === e7, JSON.stringify(ai));
  const [o6Row] = await withSystemContext((tx) => tx.select({ aiState: orders.aiState }).from(orders).where(eq(orders.id, o6.id)));
  // The assigner's own ranking picks: Sol (rank 1, a free slot today) before Bea.
  check("AI handover: the assigner's pick holds it, off the AI queue", (await activeDesigner(o6.id)) === ids.sol && o6Row?.aiState === null);
  const r7 = await exceptionRow(e7);
  check("AI handover: its row closes", r7.status === "resolved" && r7.note === "auto: given to Sol", String(r7.note));
  const [handLog] = await withSystemContext((tx) =>
    tx
      .select({ metadata: activityLog.metadata })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, o6.id), eq(activityLog.action, "agent.ai_failed_handed_over"))),
  );
  const briefs = await withSystemContext((tx) =>
    tx
      .select({ id: alphaEvents.id })
      .from(alphaEvents)
      .where(and(eq(alphaEvents.orderId, o6.id), eq(alphaEvents.type, "designer.brief"), eq(alphaEvents.toUserId, ids.sol))),
  );
  const handMeta = (handLog?.metadata ?? {}) as { confirmed?: boolean; reason?: string; dueAtHours?: number };
  check(
    "AI handover: confirmed landed (Sol's brief queued), with the AI's reason",
    handMeta.confirmed === true && handMeta.reason === "photo download 404" && briefs.length === 1,
    JSON.stringify(handMeta),
  );
  const [o6Assignment] = await withSystemContext((tx) =>
    tx.select({ dueAt: assignments.dueAt }).from(assignments).where(and(eq(assignments.orderId, o6.id), eq(assignments.active, true))),
  );
  const dueGap = Math.abs((o6Assignment?.dueAt?.getTime() ?? 0) - (now.getTime() + 6 * HOUR));
  check("AI handover: the person's deadline never passes the buyer's date", dueGap < 10 * 60_000, `${Math.round(dueGap / 60_000)} min off`);
  const r8 = await exceptionRow(e8);
  check(
    "AI handover: nobody draws it = what to do instead",
    r8.status === "open" && String(r8.detail.recommendation).startsWith("Nobody draws Line Art."),
    String(r8.detail.recommendation),
  );
  const reopened = await openOn(o9.id, "ai_designer_failed");
  check(
    "AI handover: a closed AI card on an order nobody has opens again, with what to do",
    !!reopened && reopened.detail.reopened === true && reopened.detail.reason === "too few photos" && String(reopened.detail.recommendation).startsWith("Nobody draws Charcoal Sketch."),
    JSON.stringify(reopened?.detail ?? null),
  );
  const aiAgain = await handFailedAiToDesigners(ids.biz, { now });
  check("AI handover: a second pass opens nothing new", aiAgain.handed === 0 && aiAgain.kept === 2 && aiAgain.reopened === 0, JSON.stringify(aiAgain));

  const o8 = await mkOrder({ status: "in_design", hoursAgo: 3 });
  await assign(o8.id, ids.bea);
  await withSystemContext((tx) => tx.update(designerProfiles).set({ maxActiveOrders: 1 }).where(eq(designerProfiles.userId, ids.bea)));
  check("overflow: a designer at max work in flight is skipped", (await withSystemContext((tx) => pickOverflowDesigner(tx, ids.biz, STYLE))) === null);
  await withSystemContext((tx) => tx.update(designerProfiles).set({ maxActiveOrders: 0 }).where(eq(designerProfiles.userId, ids.bea)));

  // --- The tick runs the whole pass for a business with every switch off ----
  const tick = await runAgentTick({ businessId: ids.biz, dryRun: true });
  const rep = tick.businesses.find((b) => b.businessId === ids.biz);
  check("tick: the pass runs with the switches off", !!rep?.noLimbo && rep.errors.length === 0, JSON.stringify(rep?.errors ?? null));
  check("tick: census on the report", rep?.noLimbo?.census?.limbo === 0, JSON.stringify(rep?.noLimbo?.census ?? null));
  check("tick: digest worked out", !!tick.digest && !tick.digestError, String(tick.digestError ?? ""));

  // --- The owner digest ------------------------------------------------------
  // Read after the passes ran, as the tick does: rows they just opened are due.
  const digestAt = new Date();
  const sent = await sendOwnerDigest({ now: digestAt, businessIds: [ids.biz] });
  const text = sent.texts[0] ?? "";
  check("digest: one message to the owner", sent.recipients === 1 && sent.sent === 1, JSON.stringify({ ...sent, texts: undefined }));
  check("digest: buyer mail on a delivered order is raised, with their words", text.includes(`${o2.number}:`) && text.includes('They wrote: "Hi! The print arrived creased'), text);
  // NEEDS YOU (2026-10-17): everything but upset, money back and legal is the
  // agent's first; the owner hears only if nobody took it within grace + 3 h.
  check("digest: the order nobody owns is mine first, not the owner's", !text.includes(`${o5.number}:`), text);
  check("digest: an AI order nobody took in time reaches the owner", text.includes("Nobody draws Line Art"), text);
  check("digest: money back leads, in bold", (text.split("\n").find((l) => l.startsWith("•")) ?? "").startsWith("• *Money back.* "), text);
  const words = text.replace(/https?:\/\/\S+/g, "");
  check("digest: plain words", !/[—–]/.test(words) && !/\bexception|\bagent\b/i.test(words), text);
  check("digest: nothing already closed", !text.includes(`${o1.number}:`) && !text.includes(`${o3.number}:`) && !text.includes(`${o6.number}:`), text);
  const events = await withSystemContext((tx) =>
    tx
      .select({ type: alphaEvents.type, payload: alphaEvents.payload, toRole: alphaEvents.toRole })
      .from(alphaEvents)
      .where(and(eq(alphaEvents.toUserId, ids.owner), eq(alphaEvents.type, "owner.question"))),
  );
  check(
    "digest: queued for the owner only",
    events.length === 1 && events[0].toRole === null && (events[0].payload as { source?: string }).source === "no_limbo",
    JSON.stringify(events),
  );
  const stamped = await exceptionRow(e2);
  check("digest: raised rows are stamped", stamped.detail.escalations === 1 && typeof stamped.detail.escalatedAt === "string");
  const second = await sendOwnerDigest({ now: new Date(), businessIds: [ids.biz] });
  check("digest: not twice within the hour", second.sent === 0 && second.skippedRecent === 1, JSON.stringify({ ...second, texts: undefined }));
  const early = await sendOwnerDigest({ now: new Date(digestAt.getTime() + 2 * HOUR), dryRun: true, businessIds: [ids.biz] });
  check("digest: two hours on, the order nobody owns is still mine", !(early.texts[0] ?? "").includes(`${o5.number}:`), early.texts[0] ?? "");
  const later = await sendOwnerDigest({ now: new Date(digestAt.getTime() + 5 * HOUR), dryRun: true, businessIds: [ids.biz] });
  const laterText = later.texts[0] ?? "";
  check(
    "digest: five hours on, what nobody took since, and only that",
    later.sent === 1 &&
      laterText.includes(`${o5.number}:`) &&
      laterText.includes("Send the photo request") &&
      laterText.includes("photos are coming tonight") &&
      !laterText.includes(`${o2.number}:`),
    laterText,
  );

  // --- Needs you: the agent's desk (lib/agent/needs-you-desk.ts) -------------
  const o10 = await mkOrder({ status: "in_design", hoursAgo: 10 });
  const n1 = await mkException({
    orderId: o10.id,
    kind: "reply_unclear",
    summary: `Buyer reply on order ${o10.number} needs a human`,
    detail: { excerpt: "Awesome, thank you so much! On Wed, Oct 14, 2026 at 9:24 AM PixArt Creatives <shop@example.test> wrote:" },
    hoursAgo: 3,
  });
  const o11 = await mkOrder({ status: "awaiting_approval", hoursAgo: 10 });
  const n2 = await mkException({
    orderId: o11.id,
    kind: "reply_unclear",
    summary: `Buyer reply on order ${o11.number} needs a human`,
    detail: { excerpt: "Good news indeed. Thank you! Yahoo Mail: Search, Organize, Conquer" },
    hoursAgo: 3,
  });
  const o12 = await mkOrder({ status: "in_design", hoursAgo: 10 });
  const n3 = await mkException({
    orderId: o12.id,
    kind: "reply_unclear",
    summary: `Buyer reply on order ${o12.number} needs a human`,
    detail: { excerpt: "Yes that's fine Can you send express? What is the expected delivery time?" },
    hoursAgo: 3,
  });
  const o13 = await mkOrder({ status: "delivered", hoursAgo: 100 });
  const n4 = await mkException({
    orderId: o13.id,
    kind: "reply_unclear",
    summary: `Buyer reply on order ${o13.number} needs a human`,
    detail: { excerpt: "This is the worst experience I have had. I want my money back." },
    hoursAgo: 3,
  });
  const o14 = await mkOrder({ status: "in_design", hoursAgo: 10 });
  await withSystemContext((tx) => tx.update(orders).set({ revisionCount: 1 }).where(eq(orders.id, o14.id)));
  const n5 = await mkException({
    orderId: o14.id,
    kind: "stuck_order",
    summary: `Order ${o14.number}: in design but no designer holds it`,
    detail: { reason: "no_designer", recommendation: "Pick a designer on the order page." },
    hoursAgo: 1,
  });
  const o15 = await mkOrder({ status: "in_design", hoursAgo: 20 });
  const n6 = await mkException({
    orderId: o15.id,
    kind: "reply_unclear",
    summary: `Buyer reply on order ${o15.number} needs a human`,
    detail: { excerpt: "Can you change the background to blue?", agentTakes: 3, agentTakenAt: ago(3).toISOString(), agentNote: "Etsy shows no email for this buyer; asked on Etsy messages" },
    hoursAgo: 20,
  });

  const nlDry = await closeNothingLeft(ids.biz, { now, dryRun: true });
  check("needs you: dry run counts the thank-you, writes nothing", nlDry.closed === 1 && nlDry.ids[0] === n1 && (await exceptionRow(n1)).status === "open", JSON.stringify(nlDry));
  const nl = await closeNothingLeft(ids.biz, { now });
  const rn1 = await exceptionRow(n1);
  check("needs you: a thank-you closes itself", nl.closed === 1 && rn1.status === "resolved" && rn1.note === "auto: a thank-you, nothing to answer", String(rn1.note));
  check("needs you: a thank-you on a proof stays (it may be a yes)", (await exceptionRow(n2)).status === "open");

  const desk = new Map((await listNeedsYou({ businessIds: [ids.biz] })).map((i) => [i.id, i]));
  check("needs you: upset + money back is the owner's", desk.get(n4)?.road === "owner" && desk.get(n4)?.tags.join() === "upset,refund", JSON.stringify(desk.get(n4) ?? null));
  check("needs you: a revision nobody holds is the owner's", desk.get(n5)?.road === "owner" && desk.get(n5)?.tags.join() === "revision", JSON.stringify(desk.get(n5) ?? null));
  check("needs you: the creased print is money back", desk.get(e2)?.road === "owner" && !!desk.get(e2)?.tags.includes("refund"));
  check("needs you: an express question is mine, takeable", desk.get(n3)?.road === "agent" && desk.get(n3)?.takeable === true, JSON.stringify(desk.get(n3) ?? null));
  check("needs you: closed rows are not listed", !desk.has(n1));

  const taken = await takeForAgent({ businessIds: [ids.biz], limit: 50 });
  const takenIds = taken.map((i) => i.id);
  check(
    "take: mine, never the owner's, never past the most goes",
    takenIds.includes(n2) && takenIds.includes(n3) && !takenIds.includes(n4) && !takenIds.includes(n5) && !takenIds.includes(e2) && !takenIds.includes(n6),
    JSON.stringify(takenIds),
  );
  const rn3 = await exceptionRow(n3);
  check("take: stamped on the row", rn3.detail.agentTakes === 1 && typeof rn3.detail.agentTakenAt === "string", JSON.stringify(rn3.detail));
  const takenAgain = await takeForAgent({ businessIds: [ids.biz], limit: 50 });
  check("take: nothing twice within two hours", !takenAgain.some((i) => takenIds.includes(i.id)), JSON.stringify(takenAgain.map((i) => i.id)));

  const at5 = (await sendOwnerDigest({ now: new Date(Date.now() + 5 * HOUR), dryRun: true, businessIds: [ids.biz] })).texts[0] ?? "";
  check("needs you digest: upset + money back leads", (at5.split("\n").find((l) => l.startsWith("•")) ?? "").startsWith("• *Upset buyer, money back.* ") && at5.includes(`${o13.number}:`), at5);
  check("needs you digest: the revision, with whose yes", at5.includes("*Revision.*") && at5.includes("A revision moves only with your yes"), at5);
  check("needs you digest: rows I am working stay off it", !at5.includes(`${o11.number}:`) && !at5.includes(`${o12.number}:`), at5);
  check("needs you digest: tried the most times = the owner hears, with my note", at5.includes(`${o15.number}:`) && at5.includes("I tried 3 times: Etsy shows no email"), at5);
  const at7 = (await sendOwnerDigest({ now: new Date(Date.now() + 7 * HOUR), dryRun: true, businessIds: [ids.biz] })).texts[0] ?? "";
  check("needs you digest: taken and not finished in 6 hours = the owner hears", at7.includes(`${o12.number}:`), at7);

  const noted = await noteByAgent(n3, "Asked the buyer which address the express parcel goes to");
  check("note: kept on the row", noted.ok && (await exceptionRow(n3)).detail.agentNote === "Asked the buyer which address the express parcel goes to");
  const res = await resolveByAgent(n2, "Read as a yes; the print is ordered");
  const rn2 = await exceptionRow(n2);
  check("resolve: closed with my note", res.ok && res.changed === true && rn2.status === "resolved" && rn2.note === "agent: Read as a yes; the print is ordered", String(rn2.note));
  check("resolve: twice changes nothing", (await resolveByAgent(n2, "again")).changed === false);
  check("resolve: an unknown row is refused", !(await resolveByAgent(randomUUID(), "x")).ok);
  const toOwner = await raiseToOwner(n3, ["refund"], "She paid standard and wants express: I recommend she pays the US$15 difference.");
  const handedText = (await sendOwnerDigest({ now: new Date(Date.now() + 2 * HOUR), dryRun: true, businessIds: [ids.biz] })).texts[0] ?? "";
  check(
    "owner: a row I hand over is raised with my recommendation",
    toOwner.ok && handedText.includes(`${o12.number}:`) && handedText.includes("I recommend she pays the US$15 difference") && handedText.includes("*Money back.*"),
    handedText,
  );
  // decide: an unclear reply read by the agent lands on the proof like a clear one.
  const decideRow = async (status: Parameters<typeof mkOrder>[0]["status"], body: string) => {
    const o = await mkOrder({ status, hoursAgo: 10 });
    const [m] = await withSystemContext((tx) =>
      tx
        .insert(messages)
        .values({ businessId: ids.biz, orderId: o.id, direction: "inbound", channel: "email", status: "received", address: `buyer-${o.number}@example.test`, subject: "Re: your proof", body, createdAt: ago(2) })
        .returning({ id: messages.id }),
    );
    const id = await mkException({ orderId: o.id, kind: "reply_unclear", summary: `Buyer reply on order ${o.number} needs a human`, detail: { excerpt: body, messageId: m.id }, hoursAgo: 2 });
    return { o, id };
  };
  const orderStatus = async (orderId: string) => (await withSystemContext((tx) => tx.select({ s: orders.status }).from(orders).where(eq(orders.id, orderId))))[0]?.s;
  const yes = await decideRow("awaiting_approval", "Yes that's fine");
  const dy = await decideByAgent(yes.id, "approved", "She said yes to the proof");
  const ry = await exceptionRow(yes.id);
  check("decide: her yes approves the proof and closes the row", dy.ok && (await orderStatus(yes.o.id)) === "approved" && ry.status === "resolved" && ry.note === "agent: She said yes to the proof", JSON.stringify({ dy, s: await orderStatus(yes.o.id), ry }));
  const late = await decideRow("in_design", "Yes that's fine");
  const dl = await decideByAgent(late.id, "approved", "x");
  check("decide: refused when no proof is out, row left open", !dl.ok && (await exceptionRow(late.id)).status === "open" && (await orderStatus(late.o.id)) === "in_design", JSON.stringify(dl));
  check("decide: only a buyer reply row", !(await decideByAgent(n5, "approved", "x")).ok);
  const deskLog = await withSystemContext((tx) =>
    tx
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.businessId, ids.biz), sql`${activityLog.action} in ('agent.exception_resolved', 'agent.exception_to_owner')`)),
  );
  check("desk: one activity row per resolve, decision and hand-over", deskLog.length === 3, JSON.stringify(deskLog));

  // --- L4: a row a person or the agent resolved is not opened again while nothing happens (owner, 2026-10-17:
  // PC32029 "ignore this one" and PC32186 "drawn and approved by mail" came back two minutes later) ---
  const d1 = await mkOrder({ status: "ready_to_assign", hoursAgo: 5 });
  const d2 = await mkOrder({ status: "ready_to_assign", hoursAgo: 5 });
  const d3 = await mkOrder({ status: "ready_to_assign", hoursAgo: 5 });
  await watchWaitingStates(ids.biz, { now: new Date() });
  const [x1, x2, x3] = await Promise.all([d1, d2, d3].map((d) => openOn(d.id, "stuck_order")));
  check("decision: three rows to decide on", !!x1 && !!x2 && !!x3);
  await resolveByAgent(x1!.id, "Drawn and approved by mail; the canvas is at the printer");
  await resolveByAgent(x2!.id, "Stale record, nothing owed");
  await resolveException({ id: x3!.id, userId: ids.owner, note: "ignore this one" });
  const next = await watchWaitingStates(ids.biz, { now: new Date() });
  const none = (await Promise.all([d1, d2, d3].map((d) => openOn(d.id, "stuck_order")))).every((r) => !r);
  check("decision: the next pass opens none of them again", none && next.held >= 3, JSON.stringify(next));
  await withSystemContext((tx) =>
    tx.insert(activityLog).values({ businessId: ids.biz, orderId: d1.id, actorId: null, action: "message.received", createdAt: new Date(Date.now() + 1000) }),
  );
  await watchWaitingStates(ids.biz, { now: new Date(Date.now() + 2000) });
  const back = await openOn(d1.id, "stuck_order");
  check(
    "decision: something happens on the order = raised again, with the last call on the row",
    !!back && (back.detail.lastDecision as { note?: string } | undefined)?.note === "agent: Drawn and approved by mail; the canvas is at the printer",
    JSON.stringify(back),
  );
  await watchWaitingStates(ids.biz, { now: new Date(Date.now() + (AGENT_DECISION_DAYS * 24 + 1) * HOUR) });
  check("decision: the agent's call is looked at again after a week", !!(await openOn(d2.id, "stuck_order")));
  check("decision: a person's call still holds after a week", !(await openOn(d3.id, "stuck_order")));
}

// The app login may not delete activity_log rows (it is append-only), so the
// clean-up uses the owner connection, as the other suites do.
async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    const res = await ownerDb.execute(sql`
      select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'business_id' and c.table_name <> 'businesses'`);
    // Foreign keys decide the order: retry what a reference still blocks.
    let left = (res.rows as { table_name: string }[]).map((r) => r.table_name);
    for (let pass = 0; pass < 8 && left.length; pass++) {
      const blocked: string[] = [];
      for (const t of left) {
        try {
          await ownerDb.execute(sql`delete from ${sql.identifier(t)} where business_id = ${ids.biz}`);
        } catch {
          blocked.push(t);
        }
      }
      left = blocked;
    }
    if (left.length) console.log(`cleanup: could not clear ${left.join(", ")}`);
    await ownerDb.transaction(async (tx) => {
      await tx.delete(alphaEvents).where(eq(alphaEvents.toUserId, ids.owner));
      await tx.delete(designerProfiles).where(sql`${designerProfiles.userId} in (${ids.bea}, ${ids.sol}, ${ids.ai})`);
      await tx.delete(users).where(sql`${users.id} in (${ids.owner}, ${ids.bea}, ${ids.sol}, ${ids.ai})`);
      await tx.delete(businesses).where(eq(businesses.id, ids.biz));
    });
  } finally {
    await pool.end();
  }
}

async function main() {
  pureTests();
  await setup();
  try {
    await dbTests();
  } finally {
    await cleanup();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall limbo checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
