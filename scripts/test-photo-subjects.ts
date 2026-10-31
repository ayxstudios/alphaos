/**
 * The pet slots (Yousif 2026-10-31; Delaney 4200623137: Rambo was drawn from a
 * guess because none of her photos showed his face). The pure rules first,
 * then on a throwaway business of its own ("Photo Slots Test <stamp>"), which
 * is deleted again at the end. Proves:
 *   1. a photo check about photos that changed since it was read is refused;
 *   2. a designer cannot hand in while a pet has no clear face photo, not even
 *      with a reason;
 *   3. only staff can mark the photo fine; that closes the team card, is
 *      logged once, and survives the next check of the same photos;
 *   4. a photo that came in after the check: the refusal says it is being
 *      checked, and staff can still hand it in with a reason (logged);
 *   5. the check's queue: unchecked and changed orders, most urgent first,
 *      photos numbered in upload order;
 *   6. the agent asks a new order's buyer once, by name (a draft here); an
 *      order from before the ask started goes to the team with no email.
 * Never run against production.
 */
import "./load-env";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { runAgentTick } from "../lib/agent/autopilot";
import { openExceptionTx } from "../lib/agent/exceptions";
import { withSystemContext, withUserContext, type RequestUser } from "../lib/db";
import * as schema from "../lib/db/schema";
import {
  activityLog,
  assets,
  assignments,
  businesses,
  customers,
  designerBusinesses,
  exceptions,
  messages,
  orderItems,
  orders,
  shops,
  users,
} from "../lib/db/schema";
import { installMockTransport } from "../lib/mock/transport";
import { activityDetail, activityLabel } from "../lib/orders/activity-label";
import { OrderTransitionError, transition, type OrderStatus } from "../lib/orders/transitions";
import { buyerName, holdingSubjects, joinNames, subjectAskVars, type PhotoSubject, type PhotoSubjects } from "../lib/photos/subject-types";
import {
  PHOTO_SUBJECT_CLEARED_ACTION,
  PHOTO_SUBJECTS_CHECKED_ACTION,
  PHOTO_SUBJECTS_OVERRIDE_ACTION,
  buildSubjectJob,
  cleanSubjectCheck,
  clearPhotoSubject,
  keepStaffClears,
  listSubjectQueue,
  photoSigOf,
  photoSubjectsMessage,
  saveSubjectCheck,
} from "../lib/photos/subjects";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

const slot = (s: Partial<PhotoSubject>): PhotoSubject => ({
  key: "rambo",
  name: "Rambo",
  kind: "pet",
  description: null,
  face: "unclear",
  bestAssetId: null,
  assetIds: [],
  note: null,
  ...s,
});
const slots = (subjects: PhotoSubject[]): PhotoSubjects => ({ checkedAt: "", photoSig: "x", model: null, subjects, photos: {}, extra: [] });

function pureTests() {
  const refs = ["a1", "a2", "a3"];
  const clean = cleanSubjectCheck(
    {
      subjects: [
        { name: "Jax", kind: "pet", face: "clear", bestAssetId: "a1", assetIds: ["a1", "a2", "zz"], description: "  black   lab " },
        { name: "Rambo", kind: "pet", face: "clear", assetIds: [], note: "only the back of his head" },
        { name: "Jax", face: "clear", assetIds: ["a3"] },
        { name: "Mum", kind: "person", face: "none", assetIds: ["a2"] },
        { name: "Dad", kind: "person", face: "smiling", bestAssetId: "a3" },
      ],
      extra: ["  a   second dog  ", "", 5],
    },
    refs,
  );
  if ("error" in clean) {
    check("check: a good answer is accepted", false, clean.error);
    return;
  }
  const [jax, rambo, jax2, mum, dad] = clean.subjects;
  check("check: keys come from names, a repeat gets -2", [jax.key, rambo.key, jax2.key].join() === "jax,rambo,jax-2", [jax.key, rambo.key, jax2.key].join());
  check("check: a photo that is not on the order is dropped", jax.assetIds.join() === "a1,a2" && jax.description === "black lab");
  check("check: 'clear' with no photo at all is not clear", rambo.face === "unclear" && rambo.bestAssetId === null && rambo.note === "only the back of his head");
  check("check: 'clear' with no best photo draws from its first one", jax2.face === "clear" && jax2.bestAssetId === "a3" && jax2.kind === "other");
  check("check: in a photo but 'none' is 'unclear'", mum.face === "unclear" && mum.kind === "person");
  check("check: an unknown face is 'unclear', its best photo is one of its photos", dad.face === "unclear" && dad.assetIds.join() === "a3");
  check(
    "check: which photo shows whom comes from the subjects",
    clean.photos.a1.join() === "jax" && clean.photos.a2.join() === "jax,mum" && clean.photos.a3.join() === "jax-2,dad",
    JSON.stringify(clean.photos),
  );
  check("check: extra squashed, blanks dropped", JSON.stringify(clean.extra) === JSON.stringify(["a second dog"]), JSON.stringify(clean.extra));
  const err = (input: { subjects?: unknown }) => {
    const r = cleanSubjectCheck(input, refs);
    return "error" in r ? r.error : "(accepted)";
  };
  check("check: refuses a non-list", err({ subjects: "Jax" }) === "subjects must be a list");
  check("check: refuses more than 24", err({ subjects: Array.from({ length: 25 }, (_, i) => ({ name: `Pet ${i}` })) }) === "at most 24 subjects");
  check("check: refuses a non-object", err({ subjects: [null] }) === "every subject must be an object");
  check("check: refuses a nameless one", err({ subjects: [{ name: "   " }] }) === "every subject needs a name");

  const cleared = { by: "u1", byName: "Vic", at: "2026-10-31T00:00:00.000Z", reason: "She has no other photo" };
  const prev = slots([slot({ cleared })]);
  const kept = keepStaffClears(prev, [slot({ key: "rambo-dog", name: "the Rambo" }), slot({ key: "jax", name: "Jax" })]);
  check("staff clear: kept for the same pet under another key", kept[0].cleared?.reason === cleared.reason);
  check("staff clear: never moves to another pet", !kept[1].cleared);
  check("staff clear: a clear face needs none", !keepStaffClears(prev, [slot({ face: "clear", bestAssetId: "a1", assetIds: ["a1"] })])[0].cleared);

  const mixed = slots([
    slot({ key: "jax", name: "Jax", face: "clear", bestAssetId: "a1", assetIds: ["a1"] }),
    slot({ cleared }),
    slot({ key: "bella", name: "Bella", face: "none" }),
  ]);
  check("holding: only the uncleared ones with no clear face", holdingSubjects(mixed).map((s) => s.name).join() === "Bella");
  check("holding: an order never checked holds nothing", holdingSubjects(null).length === 0);
  check("names: joined the way people say them", joinNames([]) === "" && joinNames(["Jax"]) === "Jax" && joinNames(["Jax", "Rambo", "Bella"]) === "Jax, Rambo and Bella");

  check("ask: a pet with no name is 'your ...'", buyerName({ name: "the black lab", kind: "pet" }) === "your black lab");
  check("ask: a person keeps her words", buyerName({ name: "The Twins", kind: "person" }) === "The Twins");
  const one = subjectAskVars([{ name: "Jax", kind: "pet" }, { name: "Rambo", kind: "pet" }], [{ name: "Rambo", kind: "pet" }]);
  check(
    "ask: one face missing",
    one.subject_names === "Jax and Rambo" &&
      one.subject_missing_faces === "a clear photo of Rambo's face" &&
      one.subject_add_line === "If you have one, you can add it here:",
    JSON.stringify(one),
  );
  const two = subjectAskVars([{ name: "Boots", kind: "pet" }, { name: "Jax", kind: "pet" }], [{ name: "Boots", kind: "pet" }, { name: "Jax", kind: "pet" }]);
  check(
    "ask: two faces missing",
    two.subject_missing_faces === "clear photos of Boots' and Jax's faces" && two.subject_add_line === "If you have them, you can add them here:",
    JSON.stringify(two),
  );
  const thing = subjectAskVars([{ name: "the house", kind: "other" }], [{ name: "the house", kind: "other" }]);
  check("ask: a thing has no face", thing.subject_missing_faces === "a clear photo of your house", thing.subject_missing_faces);

  const fresh = photoSubjectsMessage([{ name: "Rambo" }], "4200623137", true);
  check(
    "refusal: names the pet and the order",
    fresh ===
      "Order 4200623137: There is no clear face photo of Rambo yet, so it cannot go to QC. We are getting one from the buyer, and it lands on the card as soon as she sends it.",
    fresh,
  );
  const stale = photoSubjectsMessage([{ name: "Jax" }, { name: "Rambo" }], null, false);
  check("refusal: a photo being checked says when to try again", stale.startsWith("There is no clear face photo of Jax and Rambo yet") && stale.includes("try again in about 20 minutes"), stale);
  check("sig: the same photos in any order give the same sig", photoSigOf(["b", "a", "a"]) === photoSigOf(["a", "b"]) && photoSigOf(["a"]) !== photoSigOf(["a", "b"]));

  check(
    "history: the check names who is missing",
    activityDetail("order.photo_subjects_checked", { subjects: [{ name: "Jax" }, { name: "Rambo" }], holding: ["Rambo"] }) === "No clear face photo of Rambo yet.",
  );
  check(
    "history: the check when every face is clear",
    activityDetail("order.photo_subjects_checked", { subjects: [{ name: "Jax" }], holding: [] }) === "Every pet and person has a clear face photo.",
  );
  check("history: a check with nobody in it says nothing", activityDetail("order.photo_subjects_checked", { subjects: [], holding: [] }) === null);
  check(
    "history: marked fine",
    activityLabel("order.photo_subject_cleared") === "Photo marked fine" &&
      activityDetail("order.photo_subject_cleared", { name: "Rambo", reason: "She has no other photo" }) === "Rambo: She has no other photo",
  );
  check(
    "history: handed in without one",
    activityDetail("order.photo_subjects_override", { subjects: ["Jax", "Rambo"], reason: "owner checked" }) === "Jax and Rambo: owner checked",
  );
  check(
    "history: the one ask",
    activityDetail("agent.photo_shortfall_drafted", { via: "photo_subjects", subjects: ["Rambo"] }) === "Asked her once for a clear face photo of Rambo.",
  );
  check("history: the photo-count ask keeps its plain label", activityDetail("agent.photo_shortfall_drafted", { have: 1, need: 2 }) === null);
}

// ---------------------------------------------------------------------------
// On a database: a throwaway business
// ---------------------------------------------------------------------------

const stamp = Date.now().toString(36);
const ids = { biz: randomUUID(), shop: randomUUID(), designer: randomUUID(), va: randomUUID(), customer: randomUUID() };
const buyerEmail = `photoslots-${stamp}@example.test`;

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({
      id: ids.biz,
      name: `Photo Slots Test ${stamp}`,
      slug: `photo-slots-test-${stamp}`,
      agentIntakeEnabled: true,
      // The ask stays a draft: nothing leaves the bench.
      agentConfig: { autoSendReplies: false },
    });
    await tx.insert(users).values([
      { id: ids.designer, email: `photoslots-designer-${stamp}@example.test`, name: "Pia Designer", role: "designer" },
      { id: ids.va, email: `photoslots-va-${stamp}@example.test`, name: "Vera VA", role: "va" },
    ]);
    await tx.insert(designerBusinesses).values({ userId: ids.designer, businessId: ids.biz });
    await tx.insert(shops).values({
      id: ids.shop,
      businessId: ids.biz,
      platform: "etsy",
      name: "Photo Slots Etsy",
      externalShopId: `photoslots-${stamp}`,
      credentials: {},
    });
    await tx.insert(customers).values({ id: ids.customer, businessId: ids.biz, email: buyerEmail, firstName: "Delia" });
  });
}

async function mkOrder(label: string, o: { status: OrderStatus; placedAt?: Date; assigned?: boolean; archived?: boolean }): Promise<string> {
  return withSystemContext(async (tx) => {
    const id = randomUUID();
    await tx.insert(orders).values({
      id,
      businessId: ids.biz,
      shopId: ids.shop,
      customerId: ids.customer,
      platformOrderId: `PS-${label}-${stamp}`,
      status: o.status,
      source: "manual",
      uploadToken: randomUUID(),
      placedAt: o.placedAt ?? new Date(),
      ...(o.archived ? { archivedAt: new Date(), archiveReason: "photo slots test" } : {}),
    });
    await tx.insert(orderItems).values({
      businessId: ids.biz,
      orderId: id,
      title: "Custom pet portrait",
      figureCount: 2,
      figureCountSource: "manual",
      productType: "digital",
    });
    if (o.assigned) {
      await tx.insert(assignments).values({ businessId: ids.biz, orderId: id, designerId: ids.designer, active: true, dueAt: new Date(Date.now() + 24 * HOUR) });
    }
    return id;
  });
}

async function addPhoto(orderId: string, type: "reference" | "submission", hoursAgo = 0): Promise<string> {
  return withSystemContext(async (tx) => {
    const [a] = await tx
      .insert(assets)
      .values({
        businessId: ids.biz,
        orderId,
        type,
        storage: "cdn",
        url: `https://example.com/${orderId}-${randomUUID()}.jpg`,
        createdAt: new Date(Date.now() - hoursAgo * HOUR),
        ...(type === "submission" ? { width: 4800, height: 6000 } : {}),
      })
      .returning({ id: assets.id });
    return a.id;
  });
}

const slotsOf = (orderId: string) =>
  withSystemContext(async (tx) => (await tx.select({ ps: orders.photoSubjects }).from(orders).where(eq(orders.id, orderId)))[0]?.ps ?? null);
const statusOf = (orderId: string) =>
  withSystemContext(async (tx) => (await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)))[0]?.status ?? "(missing)");
const logRows = (orderId: string, action: string) =>
  withSystemContext((tx) =>
    tx
      .select({ actorId: activityLog.actorId, metadata: activityLog.metadata })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, orderId), eq(activityLog.action, action))),
  );
const outbound = (orderId: string) =>
  withSystemContext((tx) =>
    tx
      .select({ key: messages.templateKey, status: messages.status, body: messages.body })
      .from(messages)
      .where(and(eq(messages.orderId, orderId), eq(messages.direction, "outbound"))),
  );
const photoCards = (orderId: string) =>
  withSystemContext((tx) =>
    tx
      .select({ summary: exceptions.summary, status: exceptions.status })
      .from(exceptions)
      .where(and(eq(exceptions.orderId, orderId), eq(exceptions.kind, "photo_subject_missing"))),
  );

/** The transition's refusal message, or null when it went through. */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof OrderTransitionError) return e.message;
    throw e;
  }
}

/** What the agent's photo check would answer: Jax's face is clear in the first photo, Rambo only from behind. */
const answer = (refs: string[]) => ({
  model: "test-vision",
  subjects: [
    { name: "Jax", kind: "pet", description: "black lab", face: "clear", bestAssetId: refs[0], assetIds: refs },
    { name: "Rambo", kind: "pet", description: "brown and white beagle", face: "unclear", assetIds: [refs[0]], note: "only the back of his head" },
  ],
  extra: [],
});

async function dbTests() {
  const designer: RequestUser = { id: ids.designer, role: "designer" };
  const va: RequestUser = { id: ids.va, role: "va" };
  const submit = (user: RequestUser, orderId: string, overrideReason?: string) =>
    transition(user, { orderId, to: "awaiting_qc", expectedFrom: "in_design", overrideReason });

  console.log("=== 1. the check is stored only for the photos it saw ===");
  const order = await mkOrder("SLOTS", { status: "in_design", assigned: true });
  const r1 = await addPhoto(order, "reference", 3);
  const r2 = await addPhoto(order, "reference", 2);
  await addPhoto(order, "submission");
  const sig = photoSigOf([r1, r2]);
  const stale = await withSystemContext((tx) => saveSubjectCheck(tx, { orderId: order, photoSig: photoSigOf([r1]), ...answer([r1, r2]) }));
  check("a check about other photos is refused (409)", !stale.ok && stale.status === 409 && stale.photoSig === sig, JSON.stringify(stale));
  const bad = await withSystemContext((tx) => saveSubjectCheck(tx, { orderId: order, photoSig: sig, subjects: "Jax" }));
  check("a malformed check is refused (400)", !bad.ok && bad.status === 400, JSON.stringify(bad));
  const nowhere = await withSystemContext((tx) => saveSubjectCheck(tx, { orderId: randomUUID(), photoSig: sig, subjects: [] }));
  check("a check for no order is refused (404)", !nowhere.ok && nowhere.status === 404);
  check("a refused check stores nothing", (await slotsOf(order)) === null);
  const saved = await withSystemContext((tx) => saveSubjectCheck(tx, { orderId: order, photoSig: sig, ...answer([r1, r2]) }));
  check("the check is stored: Rambo holds it", saved.ok && saved.holding.join() === "Rambo" && saved.subjects === 2, JSON.stringify(saved));
  const ps1 = await slotsOf(order);
  check("each photo is labelled by who is in it", ps1?.photos[r1]?.join() === "jax,rambo" && ps1?.photos[r2]?.join() === "jax", JSON.stringify(ps1?.photos));
  const checked = await logRows(order, PHOTO_SUBJECTS_CHECKED_ACTION);
  check(
    "the check is on the order's history",
    checked.length === 1 && JSON.stringify((checked[0].metadata as { holding?: unknown }).holding) === '["Rambo"]',
    JSON.stringify(checked.map((c) => c.metadata)),
  );

  console.log("=== 2. the designer cannot hand it in while Rambo has no clear face photo ===");
  const no1 = await refusal(() => submit(designer, order));
  check(
    "the hand-in is refused, naming Rambo and the order",
    !!no1 && no1.includes("no clear face photo of Rambo yet") && no1.includes(`PS-SLOTS-${stamp}`) && no1.includes("We are getting one from the buyer"),
    no1 ?? "NOT refused",
  );
  const no2 = await refusal(() => submit(designer, order, "she said it is fine"));
  check("a designer's reason does not get past it", !!no2 && no2.includes("no clear face photo of Rambo"), no2 ?? "NOT refused");
  check("the order stays with the designer", (await statusOf(order)) === "in_design");

  console.log("=== 3. only staff can mark the photo fine; that closes the team card ===");
  const cardId = await withSystemContext(
    async (tx) =>
      (
        await openExceptionTx(tx, {
          businessId: ids.biz,
          orderId: order,
          kind: "photo_subject_missing",
          summary: `Order #PS-SLOTS-${stamp}: no clear face photo of Rambo`,
          detail: {},
        })
      ).id,
  );
  const byDesigner = await withUserContext(designer, (tx) => clearPhotoSubject(tx, designer, { orderId: order, key: "rambo", reason: "looks fine to me" }));
  check("a designer cannot mark it fine", !byDesigner.ok && byDesigner.error === "Only staff can mark a photo as fine.");
  const tooShort = await withUserContext(va, (tx) => clearPhotoSubject(tx, va, { orderId: order, key: "rambo", reason: " ok " }));
  check("staff must say why", !tooShort.ok && tooShort.error.startsWith("Say in a few words"));
  const wrongKey = await withUserContext(va, (tx) => clearPhotoSubject(tx, va, { orderId: order, key: "bella", reason: "She has no other photo" }));
  check("a slot that is not there asks for a reload", !wrongKey.ok && wrongKey.error.includes("Reload"));
  const reason = "She has no other photo of Rambo, draw him from photo 1";
  const fine = await withUserContext(va, (tx) => clearPhotoSubject(tx, va, { orderId: order, key: "rambo", reason }));
  check("staff mark Rambo's photo fine", fine.ok, JSON.stringify(fine));
  const ps2 = await slotsOf(order);
  const rambo2 = ps2?.subjects.find((s) => s.key === "rambo");
  check(
    "the slot keeps who (by name) and why, and stops holding",
    rambo2?.cleared?.reason === reason && rambo2.cleared.byName === "Vera VA" && holdingSubjects(ps2).length === 0,
    JSON.stringify(rambo2?.cleared),
  );
  const [card] = await withSystemContext((tx) =>
    tx.select({ status: exceptions.status, note: exceptions.resolutionNote, by: exceptions.resolvedBy }).from(exceptions).where(eq(exceptions.id, cardId)),
  );
  check("the team card closes with the reason", card?.status === "resolved" && card.note === `Photo marked fine: ${reason}` && card.by === ids.va, JSON.stringify(card));
  const twice = await withUserContext(va, (tx) => clearPhotoSubject(tx, va, { orderId: order, key: "rambo", reason: "again, to be sure" }));
  const clearedRows = await logRows(order, PHOTO_SUBJECT_CLEARED_ACTION);
  check("marking it twice logs it once", twice.ok && clearedRows.length === 1 && clearedRows[0].actorId === ids.va, `${clearedRows.length} row(s)`);
  const recheck = await withSystemContext((tx) => saveSubjectCheck(tx, { orderId: order, photoSig: sig, ...answer([r1, r2]) }));
  const rambo3 = (await slotsOf(order))?.subjects.find((s) => s.key === "rambo");
  check("a new check of the same photos keeps the staff clear", recheck.ok && recheck.holding.length === 0 && rambo3?.cleared?.reason === reason, JSON.stringify(recheck));
  const went = await submit(designer, order);
  check("then the designer hands it in", went.status === "awaiting_qc" && (await statusOf(order)) === "awaiting_qc", `status ${await statusOf(order)}`);

  console.log("=== 4. a photo that came in after the check ===");
  const late = await mkOrder("LATE", { status: "in_design", assigned: true });
  const l1 = await addPhoto(late, "reference", 3);
  await addPhoto(late, "submission");
  const lateSaved = await withSystemContext((tx) => saveSubjectCheck(tx, { orderId: late, photoSig: photoSigOf([l1]), ...answer([l1]) }));
  check("checked: Rambo holds it", lateSaved.ok && lateSaved.holding.join() === "Rambo", JSON.stringify(lateSaved));
  await addPhoto(late, "reference");
  const no3 = await refusal(() => submit(designer, late));
  check(
    "the refusal says the new photo is being checked",
    !!no3 && no3.includes("try again in about 20 minutes") && (await statusOf(late)) === "in_design",
    no3 ?? "NOT refused",
  );
  const why = "Owner checked her new photo: Rambo's face is clear";
  const staffGo = await submit(va, late, why);
  const overrides = await logRows(late, PHOTO_SUBJECTS_OVERRIDE_ACTION);
  const om = (overrides[0]?.metadata ?? {}) as { reason?: string; subjects?: string[]; via?: string };
  check(
    "staff can hand it in with a reason, logged",
    staffGo.status === "awaiting_qc" && overrides.length === 1 && overrides[0].actorId === ids.va && om.reason === why && om.subjects?.join() === "Rambo" && om.via === "submit",
    JSON.stringify(om),
  );

  console.log("=== 5. the photo check's queue ===");
  const queued = await mkOrder("QUEUE", { status: "ready_to_assign", placedAt: new Date(Date.now() - 2 * HOUR) });
  const qb = await addPhoto(queued, "reference", 1);
  const qa = await addPhoto(queued, "reference", 2);
  await withSystemContext((tx) =>
    tx.insert(messages).values({
      businessId: ids.biz,
      orderId: queued,
      customerId: ids.customer,
      direction: "inbound",
      channel: "email",
      status: "received",
      address: buyerEmail,
      body: "Rambo is the  brown one\non the left",
    }),
  );
  const approval = await mkOrder("APPROVAL", { status: "awaiting_approval" });
  await addPhoto(approval, "reference", 5);
  const noPhotos = await mkOrder("NOPHOTOS", { status: "ready_to_assign" });
  const archived = await mkOrder("ARCHIVED", { status: "ready_to_assign", archived: true });
  await addPhoto(archived, "reference", 1);
  const longAgo = await mkOrder("LONGAGO", { status: "ready_to_assign", placedAt: new Date(Date.now() - 90 * 24 * HOUR) });
  await addPhoto(longAgo, "reference", 1);
  const q1 = await listSubjectQueue({ businessIds: [ids.biz], limit: 50 });
  check("due: never checked, and photos changed since the check", q1.includes(queued) && q1.includes(late), `${q1.length} due`);
  // Drizzle writes orders.id as a bare "id" inside a one-table select's
  // subquery; that once made every checked order look photo-less and due.
  check("not due: checked on the same photos", !q1.includes(order));
  check("not due: waiting on her approval with nothing new", !q1.includes(approval));
  check("not due: no photo, archived, or placed long ago", !q1.includes(noPhotos) && !q1.includes(archived) && !q1.includes(longAgo));
  check("before anyone draws comes first", q1.indexOf(queued) < q1.indexOf(late));
  await withSystemContext((tx) =>
    tx
      .update(orders)
      .set({ photoSubjects: { checkedAt: new Date().toISOString(), photoSig: "an-older-set", model: null, subjects: [], photos: {}, extra: [] } })
      .where(eq(orders.id, approval)),
  );
  const q2 = await listSubjectQueue({ businessIds: [ids.biz], limit: 50 });
  check("waiting on her approval with a changed photo: due, after the rest", q2.includes(approval) && q2.indexOf(late) < q2.indexOf(approval));
  const job = await buildSubjectJob(queued, { md5: true });
  check(
    "the job numbers her photos in upload order",
    job?.photos.map((p) => p.assetId).join() === [qa, qb].join() && job.photos.map((p) => p.n).join() === "1,2",
    JSON.stringify(job?.photos.map((p) => [p.n, p.assetId === qa ? "older" : "newer"])),
  );
  check("the job's sig is the one a save needs", job?.photoSig === photoSigOf([qa, qb]) && job.previous === null);
  check(
    "the job carries what was bought and her words",
    job?.orderSays.items[0]?.title === "Custom pet portrait" &&
      job.orderSays.items[0]?.figureCount === 2 &&
      job.buyerWrote.length === 1 &&
      job.buyerWrote[0].text === "Rambo is the brown one on the left",
    JSON.stringify(job?.buyerWrote),
  );
  check("md5 asked for: every photo answers (null with no stored copy)", !!job && job.photos.every((p) => "md5" in p));
  check("no job for an order that is not there", (await buildSubjectJob(randomUUID())) === null);

  console.log("=== 6. the agent asks her once, by name; an older order goes to the team ===");
  installMockTransport();
  const fresh = await mkOrder("NEW", { status: "awaiting_photos" });
  const n1 = await addPhoto(fresh, "reference", 1);
  // After the legacy cut-off, before the named ask started (lib/agent/autopilot.ts SUBJECT_ASKS_FROM).
  const old = await mkOrder("OLD", { status: "awaiting_photos", placedAt: new Date("2026-10-20T09:00:00Z") });
  const o1 = await addPhoto(old, "reference", 1);
  for (const [orderId, ref] of [
    [fresh, n1],
    [old, o1],
  ]) {
    const r = await withSystemContext((tx) => saveSubjectCheck(tx, { orderId, photoSig: photoSigOf([ref]), ...answer([ref]) }));
    if (!r.ok) throw new Error(`setup: the check was not stored: ${r.error}`);
  }
  await runAgentTick({ businessId: ids.biz });
  const mail1 = await outbound(fresh);
  const ask1 = mail1.filter((m) => m.key === "photo_subject_ask");
  check(
    "a new order: one named ask, held as a draft here",
    ask1.length === 1 && ask1[0].status === "draft" && (ask1[0].body ?? "").includes("a clear photo of Rambo's face"),
    JSON.stringify(mail1.map((m) => `${m.key}:${m.status}`)),
  );
  check("a new order: no photo-count email as well", mail1.every((m) => m.key !== "photo_shortfall"));
  const marker = await logRows(fresh, "agent.photo_shortfall_drafted");
  const mk = (marker[0]?.metadata ?? {}) as { via?: string; subjects?: string[] };
  check("the ask is marked once, by name", marker.length === 1 && mk.via === "photo_subjects" && mk.subjects?.join() === "Rambo", JSON.stringify(mk));
  const oldMail = await outbound(old);
  check("an older order: nothing to the buyer", oldMail.length === 0, JSON.stringify(oldMail.map((m) => m.key)));
  const cards1 = await photoCards(old);
  check(
    "an older order: a team card naming Rambo",
    cards1.length === 1 && cards1[0].status === "open" && cards1[0].summary.includes("no clear face photo of Rambo"),
    JSON.stringify(cards1),
  );
  await runAgentTick({ businessId: ids.biz });
  check(
    "a second tick asks nobody again",
    (await outbound(fresh)).filter((m) => m.key === "photo_subject_ask").length === 1 && (await logRows(fresh, "agent.photo_shortfall_drafted")).length === 1,
  );
  check("a second tick raises no second card", (await photoCards(old)).length === 1 && (await outbound(old)).length === 0);
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
      await tx.delete(users).where(sql`${users.id} in (${ids.designer}, ${ids.va})`);
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
  console.log(failed ? `\n${failed} check(s) failed` : "\nall photo slot checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
