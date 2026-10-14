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
  autoCloseStaleExceptions,
  getLimboCensus,
  handFailedAiToDesigners,
  isReactionOnly,
  ownerOf,
  pickOverflowDesigner,
  staleReason,
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
  isDue,
  lineFor,
  mergeLines,
  plainWords,
  sendOwnerDigest,
  stripOrderPrefix,
  type DigestLine,
} from "../lib/agent/owner-digest";
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
    hasContact: true,
    lastChaseAt: null,
    parentLive: false,
    openKinds: [],
    style: "Watercolor Pets",
    ...o,
  });
  const bucket = (o: Partial<OrderFacts>, opts?: { ignoreStuck?: boolean }) => ownerOf(order(o), now, opts);
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
  const noContact = bucket({ status: "awaiting_photos", hasContact: false });
  check("owner: no way to reach the buyer = limbo", noContact.bucket === "limbo" && noContact.reason === "no_contact");
  check("owner: add-on with its portrait order", bucket({ status: "fulfillment_only", parentLive: true }).bucket === "pipeline");
  check("owner: orphan add-on gets a day", bucket({ status: "fulfillment_only", enteredAt: ago(5) }).bucket !== "limbo");
  check("owner: orphan add-on after a day = limbo", bucket({ status: "fulfillment_only", enteredAt: ago(30) }).bucket === "limbo");
  check("owner: its own stuck row is ignored when judging it", bucket({ openKinds: ["stuck_order"] }, { ignoreStuck: true }).bucket === "limbo");
  check("owner: held for a check = limbo", bucket({ needsReview: true }).bucket === "limbo");

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

  const cand = (kind: string, hours: number, extra: { escalatedAt?: string | null; escalations?: number } = {}) => ({
    kind,
    createdAt: ago(hours),
    escalatedAt: extra.escalatedAt ?? null,
    escalations: extra.escalations ?? 0,
  });
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
  const e7 = await mkException({ orderId: o6.id, kind: "ai_designer_failed", summary: `Order #${o6.number}: AI could not finish it`, detail: { reason: "photo download 404" }, hoursAgo: 5 });
  const o7 = await mkOrder({ status: "in_design", hoursAgo: 30, aiState: "failed", style: "Line Art", title: "Storybook Portrait" });
  await assign(o7.id, ids.ai);
  const e8 = await mkException({ orderId: o7.id, kind: "ai_designer_failed", summary: `Order #${o7.number}: AI could not finish it`, hoursAgo: 5 });
  const aiDry = await handFailedAiToDesigners(ids.biz, { now, dryRun: true });
  check("AI handover dry run", aiDry.handed === 1 && aiDry.kept === 1 && (await activeDesigner(o6.id)) === ids.ai, JSON.stringify(aiDry));
  const ai = await handFailedAiToDesigners(ids.biz, { now });
  check("AI handover result", ai.handed === 1 && ai.kept === 1 && ai.closedIds.join() === e7, JSON.stringify(ai));
  const [o6Row] = await withSystemContext((tx) => tx.select({ aiState: orders.aiState }).from(orders).where(eq(orders.id, o6.id)));
  check("AI handover: a person holds it, off the AI queue", (await activeDesigner(o6.id)) === ids.bea && o6Row?.aiState === null);
  const r7 = await exceptionRow(e7);
  check("AI handover: its row closes", r7.status === "resolved" && r7.note === "auto: given to Bea", String(r7.note));
  const r8 = await exceptionRow(e8);
  check(
    "AI handover: nobody draws it = what to do instead",
    r8.status === "open" && String(r8.detail.recommendation).startsWith("Nobody draws Line Art."),
    String(r8.detail.recommendation),
  );
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
  check("digest: the order nobody owns is raised", text.includes(`${o5.number}:`) && text.includes("Send the photo request"), text);
  check("digest: the AI order nobody can draw is raised", text.includes("Nobody draws Line Art"), text);
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
  const later = await sendOwnerDigest({ now: new Date(digestAt.getTime() + 2 * HOUR), dryRun: true, businessIds: [ids.biz] });
  const laterText = later.texts[0] ?? "";
  check(
    "digest: two hours on, only what became due since",
    later.sent === 1 && laterText.includes(`${o5.number}:`) && laterText.includes("photos are coming tonight") && !laterText.includes(`${o2.number}:`),
    laterText,
  );
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
