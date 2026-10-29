// Deliver together (owner, 29 Oct 2026): a buyer with 2+ portrait orders gets
// her proofs at the same time, whoever drew them, and never late. Checked:
// 1. the pure rule (lib/orders/deliver-together.ts): who counts (same buyer,
//    72 h window, real portrait orders, not delivered, cancelled, archived or
//    waiting on her photos), held siblings are ready, holdUntil is the
//    earliest due time less the margin, never late, the sweep's verdict;
// 2. on the local bench: a pass while her other order is in design keeps the
//    proof a draft (no email, a hold on the message and the order's history),
//    the other order's pass sends both in the same step, the sweep lets a
//    hold go before its due time or once the other order stops counting, an
//    Etsy-message proof is held and released as a queued row, "Send now",
//    a release never sends twice;
// 3. QC pass checks the wrong-file stop on every portrait's file, also on the
//    transition road (two untagged files used to share one slot).
// Local bench only for 2 and 3 (scripts/ci-local.sh): rows marked "dtog-" are removed at the end.
import "./load-env";
import { setTestSession } from "./ci/next-request-stub";

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { withSystemContext, type RequestUser } from "../lib/db";
import { sendHeldProofNowAction } from "../app/(app)/orders/held-proof-actions";
import { approveAndSend } from "../app/(app)/orders/outbox-actions";
import { activityLog, assets, businesses, customers, exceptions, messages, orderItems, orders, proofs, shops, users } from "../lib/db/schema";
import { installMockTransport } from "../lib/mock/transport";
import {
  deliverTogetherDecision,
  dueOf,
  holdOf,
  HELD_ACTION,
  MIN_HOLD_MS,
  numbersPhrase,
  RELEASE_MARGIN_MS,
  RELEASED_ACTION,
  releaseVerdict,
  SIBLING_RELEASED_ACTION,
  SIBLING_WAITING_ACTION,
  siblingStanding,
  togetherWaitingNote,
  type HoldState,
  type TogetherOrder,
  type TogetherSibling,
} from "../lib/orders/deliver-together";
import { heldProofFor, releaseDueDeliveryHolds, releaseHeldProof } from "../lib/orders/deliver-together-db";
import { ownerApproveCore } from "../lib/qc/owner-approve";
import { OrderTransitionError, transition } from "../lib/orders/transitions";
import { DEFAULT_CHECKLIST } from "../lib/qc/checklist";
import { FINE_H, FINE_W, fineSigFromGray } from "../lib/qc/image-hash";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const H = 3600 * 1000;

// ---------------------------------------------------------------------------
// 1. The pure rule
// ---------------------------------------------------------------------------
function pure() {
  const t0 = new Date("2026-10-20T00:00:00Z");
  const at = (h: number) => new Date(t0.getTime() + h * H);
  const order: TogetherOrder = { id: "a", number: "4205710209", businessId: "cps", status: "awaiting_qc", placedAt: at(0), createdAt: at(0), dueAt: at(48) };
  const sib = (over: Partial<TogetherSibling> = {}): TogetherSibling => ({
    id: "b",
    number: "4208132598",
    businessId: "cps",
    status: "in_design",
    placedAt: at(2),
    createdAt: at(2),
    dueAt: at(50),
    linkedBy: "buyer",
    archived: false,
    portraitLines: 1,
    proofOut: false,
    heldForSiblings: false,
    ...over,
  });
  const now = at(10);
  const d = (s: TogetherSibling[], n = now) => deliverTogetherDecision(order, s, n);

  const base = d([sib()]);
  check("her other order in design holds the proof", base.hold && base.waitingOn.map((w) => w.id).join() === "b", base.why);
  check("holdUntil = this order's due less the margin", base.holdUntil?.getTime() === at(48).getTime() - RELEASE_MARGIN_MS, base.holdUntil?.toISOString());
  check("the why names the other order", /#4208132598/.test(base.why), base.why);
  const earlier = d([sib({ dueAt: at(30) })]);
  check("never later than the earliest due in the group", earlier.holdUntil?.getTime() === at(30).getTime() - RELEASE_MARGIN_MS);
  const noDue = deliverTogetherDecision({ ...order, dueAt: null }, [sib({ dueAt: null })], now);
  check("no due date: placed + 48 h", noDue.holdUntil?.getTime() === at(48).getTime() - RELEASE_MARGIN_MS && dueOf({ ...order, dueAt: null }).getTime() === at(48).getTime());
  check("past holdUntil: never held (never late)", !d([sib()], at(48)).hold && /never late/.test(d([sib()], at(48)).why));
  check("already past its own due: never held", !d([sib()], at(60)).hold);
  check("within one sweep of holdUntil: goes now", !d([sib()], new Date(at(48).getTime() - RELEASE_MARGIN_MS - MIN_HOLD_MS + 60_000)).hold);
  check("just outside that: still held", d([sib()], new Date(at(48).getTime() - RELEASE_MARGIN_MS - MIN_HOLD_MS - 60_000)).hold);

  check("placed 71 h later still counts", d([sib({ placedAt: at(71), dueAt: at(119) })]).hold);
  check("placed 71 h earlier still counts", d([sib({ placedAt: at(-71), dueAt: at(60) })]).hold);
  check("placed 73 h later: not held", !d([sib({ placedAt: at(73), dueAt: at(121) })]).hold);
  check("placed 73 h earlier: not held", !d([sib({ placedAt: at(-73) })]).hold);
  check("no placed time: created time is used", !d([sib({ placedAt: null, createdAt: at(80) })]).hold);

  const skipped = (s: TogetherSibling) => {
    const st = siblingStanding(order, s);
    return st.kind === "skip" ? st.reason : st.kind;
  };
  check("an add-on receipt (fulfillment_only) never holds", skipped(sib({ status: "fulfillment_only" })) === "not a portrait order");
  check("an add-on-only order (no portrait line) never holds", skipped(sib({ portraitLines: 0 })) === "not a portrait order");
  check("triage never holds", skipped(sib({ status: "triage" })) === "not a portrait order");
  check("waiting on her photos never holds", skipped(sib({ status: "awaiting_photos" })) === "waiting on the buyer");
  check("waiting on her details never holds", skipped(sib({ status: "awaiting_details" })) === "waiting on the buyer");
  check("delivered never holds", ["approved", "printing", "shipped", "delivered", "complete"].every((st) => skipped(sib({ status: st })) === "already delivered"));
  check("cancelled / refunded never holds", skipped(sib({ status: "cancelled" })) === "cancelled or refunded");
  check("archived never holds", skipped(sib({ archived: true })) === "archived");
  check("on hold never holds", skipped(sib({ status: "on_hold" })) === "on hold");
  check("another business never holds", skipped(sib({ businessId: "perfetta" })) === "another business");
  check("named only in the notes never holds", skipped(sib({ linkedBy: "notes" })) === "only named in the notes");
  check("her proof of it already went: never holds", skipped(sib({ status: "awaiting_approval", proofOut: true })) === "its proof already went to her");
  check("a revision of an order she has seen never holds", skipped(sib({ status: "in_design", proofOut: true })) === "its proof already went to her");
  check("awaiting QC holds", skipped(sib({ status: "awaiting_qc" })) === "waiting");
  check("not started yet holds", skipped(sib({ status: "ready_to_assign" })) === "waiting");
  check("an AI proof waiting for the owner holds", skipped(sib({ status: "awaiting_approval" })) === "waiting");

  const ready = d([sib({ status: "awaiting_approval", heldForSiblings: true })]);
  check("a sibling already passed and held is ready, not waiting", !ready.hold && ready.ready.length === 1 && ready.waitingOn.length === 0, ready.why);
  const mixed = d([sib({ id: "c", number: "PC1", status: "awaiting_approval", heldForSiblings: true, dueAt: at(20) }), sib()]);
  check("ready + waiting: held for the waiting one only", mixed.hold && mixed.waitingOn.map((w) => w.id).join() === "b" && mixed.ready.map((w) => w.id).join() === "c");
  check("the ready one's due counts for holdUntil", mixed.holdUntil?.getTime() === at(20).getTime() - RELEASE_MARGIN_MS);
  const none = d([]);
  check("no other order: no hold, no holdUntil", !none.hold && none.holdUntil === null);
  check("numbers phrase", numbersPhrase([{ number: "1" }, { number: "#2" }, { number: "3" }]) === "#1, #2 and #3" && numbersPhrase([{ number: "PC9" }]) === "#PC9");

  const hold: HoldState = { heldAt: at(10).toISOString(), holdUntil: at(30).toISOString(), waitingOn: [{ id: "b", number: "x", status: "in_design" }], why: "", passedBy: "u" };
  check("verdict: still waiting, keep", !releaseVerdict(hold, d([sib()]), at(11)).release);
  const due = releaseVerdict(hold, d([sib()]), at(30));
  check("verdict: past the stored holdUntil, due", due.release && due.reason === "due");
  const lastTick = releaseVerdict(hold, d([sib()]), new Date(at(30).getTime() - MIN_HOLD_MS + 60_000));
  check("verdict: the last sweep before holdUntil lets it go", lastTick.release && lastTick.reason === "due");
  const later = releaseVerdict(hold, deliverTogetherDecision({ ...order, dueAt: at(100) }, [sib({ dueAt: at(100) })], at(31)), at(31));
  check("verdict: a fresh look never pushes holdUntil later", later.release && later.reason === "due");
  const gone = releaseVerdict(hold, d([sib({ status: "cancelled" })]), at(11));
  check("verdict: the waiting order stopped counting, let go", gone.release && gone.reason === "group_ready");
  const passed = releaseVerdict(hold, d([sib({ status: "awaiting_approval", heldForSiblings: true })]), at(11));
  check("verdict: the waiting order passed and is held, let go", passed.release && passed.reason === "group_ready");
  const asked = releaseVerdict(hold, d([sib()]), at(11), at(10.5));
  check("verdict: she wrote in after the hold, let go at once (she_asked)", asked.release && asked.reason === "she_asked");
  check("verdict: her words before the hold do not count", !releaseVerdict(hold, d([sib()]), at(11), at(9)).release);
  const askedLate = releaseVerdict(hold, d([sib()]), at(30), at(29));
  check("verdict: she_asked wins over due", askedLate.release && askedLate.reason === "she_asked");

  const sig = (action: string, metadata: Record<string, unknown>) => ({ action, metadata, createdAt: at(10) });
  const waitRow = sig(SIBLING_WAITING_ACTION, { messageId: "m1", heldOrderNumber: "PC7", holdUntil: at(30).toISOString() });
  check("board label: her other portrait waits", togetherWaitingNote([waitRow], at(11)) === "Her other portrait #PC7 is done and waits for this one, so she gets them together.");
  check("board label: gone once that proof went", togetherWaitingNote([waitRow, sig(SIBLING_RELEASED_ACTION, { messageId: "m1", reason: "group_ready" })], at(11)) === null);
  check("board label: gone after holdUntil", togetherWaitingNote([waitRow], at(31)) === null);
  const twoWaits = togetherWaitingNote([waitRow, sig(SIBLING_WAITING_ACTION, { messageId: "m2", heldOrderNumber: "PC8", holdUntil: at(30).toISOString() })], at(11));
  check("board label: two held portraits named", !!twoWaits?.includes("#PC7 and #PC8"), twoWaits ?? "");
  check("board label: nothing waits, no label", togetherWaitingNote([], at(11)) === null);
  check("hold metadata: junk reads as no hold", holdOf(null) === null && holdOf({ deliverTogether: { holdUntil: 1 } }) === null);
  check("hold metadata: reads back", holdOf({ deliverTogether: hold })?.waitingOn[0]?.id === "b");
}

// ---------------------------------------------------------------------------
// 2 + 3. The bench
// ---------------------------------------------------------------------------
const MARK = "dtog-";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A 64x80 drawing: cream paper with a dark block placed by `seed` (as in test-wrong-file-gate). */
function picture(seed: number): { dhash: string; fineSig: string } {
  const px = new Uint8Array(FINE_W * FINE_H).fill(232);
  const x0 = 8 + ((seed * 13) % 30);
  const y0 = 8 + ((seed * 29) % 40);
  for (let y = y0; y < y0 + 30; y++) for (let x = x0; x < x0 + 24; x++) px[y * FINE_W + x] = 60;
  const dhash = (seed * 0x1f3a5c7e9b).toString(16).padStart(16, "0").slice(-16);
  return { dhash, fineSig: fineSigFromGray(px) };
}

type Q = Parameters<Parameters<typeof withSystemContext>[0]>[0];
const q = <T>(fn: (tx: Q) => Promise<T>) => withSystemContext(fn);

/** The SQL the agent repo uses to list held proofs (kept here so a schema change breaks this test first). */
const HELD_PROOFS_SQL = `
select o.id as order_id,
       coalesce(nullif(o.platform_order_name, ''), o.platform_order_id) as order_number,
       m.id as message_id, m.channel,
       (m.metadata->'deliverTogether'->>'heldAt')::timestamptz as held_at,
       (m.metadata->'deliverTogether'->>'holdUntil')::timestamptz as hold_until,
       (select string_agg(w->>'number', ', ') from jsonb_array_elements(m.metadata->'deliverTogether'->'waitingOn') w) as waiting_on,
       m.metadata->'deliverTogether'->'waitingOn' as waiting_on_json
from messages m
join orders o on o.id = m.order_id
where m.direction = 'outbound' and m.status = 'draft' and m.archived_at is null
  and m.metadata ? 'qcPass' and m.metadata ? 'deliverTogether'
  and m.metadata->'deliverTogether'->>'releasedAt' is null
order by hold_until`;

async function bench() {
  installMockTransport();
  const sent: string[] = [];
  const inner = globalThis.fetch;
  const png = Buffer.from(PNG, "base64");
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://example.test/")) {
      const head = (init?.method ?? (input instanceof Request ? input.method : "GET")) === "HEAD";
      return Promise.resolve(new Response(head ? null : png, { headers: { "content-type": "image/png", "content-length": String(png.length) } }));
    }
    if (url.includes("gmail.googleapis.com") && url.includes("/messages/send")) sent.push(url);
    return inner(input, init);
  }) as typeof fetch;

  const [etsy] = await q((tx) =>
    tx
      .select({ shopId: shops.id, businessId: shops.businessId })
      .from(shops)
      .innerJoin(businesses, eq(businesses.id, shops.businessId))
      .where(and(eq(shops.platform, "etsy"), eq(businesses.emailSendingEnabled, true)))
      .limit(1),
  );
  if (!etsy) throw new Error("seed has no Etsy shop on a business with email sending on");
  const businessId = etsy.businessId;
  const [va] = await q((tx) =>
    tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, "va"), eq(users.active, true))).limit(1),
  );
  if (!va?.name) throw new Error("seed needs a named VA");
  const vaUser: RequestUser = { id: va.id, role: "va" };
  setTestSession({ user: { id: va.id, role: "va", name: va.name } });

  const stamp = Date.now();
  const orderIds: string[] = [];
  const customerIds: string[] = [];
  const now = Date.now();

  async function newCustomer(tag: string, email: boolean) {
    const [c] = await q((tx) =>
      tx
        .insert(customers)
        .values({ businessId, email: email ? `${MARK}${tag}-${stamp}@example.test` : "", firstName: "Mia", lastName: `${MARK}${stamp}` })
        .returning({ id: customers.id }),
    );
    customerIds.push(c.id);
    return c.id;
  }

  /** An order of one portrait (or `quantity`), in `status`, with the given files (seed = a picture's hashes). */
  async function newOrder(
    tag: string,
    opts: {
      customerId: string | null;
      status: (typeof orders.$inferInsert)["status"];
      placedH: number;
      dueH: number | null;
      files?: { seed: number | null; unit?: number | null; tagged?: boolean; ageMs?: number }[];
      quantity?: number;
      title?: string;
    },
  ) {
    return q(async (tx) => {
      const name = `${MARK}${tag}-${stamp}`;
      const [o] = await tx
        .insert(orders)
        .values({
          businessId,
          shopId: etsy.shopId,
          customerId: opts.customerId,
          platformOrderId: name,
          platformOrderName: name,
          status: opts.status,
          source: "manual",
          uploadToken: randomUUID(),
          placedAt: new Date(now + opts.placedH * H),
          dueAt: opts.dueH == null ? null : new Date(now + opts.dueH * H),
        })
        .returning({ id: orders.id });
      orderIds.push(o.id);
      const [item] = await tx
        .insert(orderItems)
        .values({
          businessId,
          orderId: o.id,
          title: opts.title ?? "Custom Pet Portrait",
          quantity: opts.quantity ?? 1,
          style: "cartoon",
          figureCount: 1,
          figureCountSource: "manual",
          productType: "digital",
        })
        .returning({ id: orderItems.id });
      const files = [];
      for (const [i, f] of (opts.files ?? []).entries()) {
        const pic = f.seed == null ? null : picture(f.seed);
        const [a] = await tx
          .insert(assets)
          .values({
            businessId,
            orderId: o.id,
            type: "submission",
            storage: "cdn",
            url: `https://example.test/${name}-${i}.png`,
            orderItemId: f.tagged === false ? null : item.id,
            portraitUnit: f.tagged === false ? null : (f.unit ?? null),
            createdAt: new Date(Date.now() - (f.ageMs ?? 60_000)),
            ...(pic ? { dhash: pic.dhash, fineSig: pic.fineSig, width: 4800, height: 6000 } : {}),
          })
          .returning({ id: assets.id });
        files.push(a.id);
      }
      return { id: o.id, number: name, itemId: item.id, files };
    });
  }

  const passQc = (orderId: string) => ownerApproveCore(vaUser, va.name ?? "VA", orderId);
  const qcPassMessage = (orderId: string) =>
    q((tx) =>
      tx
        .select({ id: messages.id, status: messages.status, channel: messages.channel, metadata: messages.metadata, proofId: messages.proofId })
        .from(messages)
        .where(and(eq(messages.orderId, orderId), eq(messages.direction, "outbound"), sql`${messages.metadata} ? 'qcPass'`))
        .orderBy(desc(messages.createdAt))
        .limit(1)
        .then((r) => r[0]),
    );
  const statusOf = (orderId: string) => q((tx) => tx.select({ s: orders.status }).from(orders).where(eq(orders.id, orderId)).then((r) => r[0]?.s));
  const events = (orderId: string, action: string) =>
    q((tx) =>
      tx
        .select({ metadata: activityLog.metadata })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, orderId), eq(activityLog.action, action)))
        .orderBy(desc(activityLog.createdAt)),
    );
  const proofSentAt = (proofId: string | null | undefined) =>
    proofId ? q((tx) => tx.select({ at: proofs.sentAt }).from(proofs).where(eq(proofs.id, proofId)).then((r) => r[0]?.at ?? null)) : Promise.resolve(null);
  const setInDesignToQc = (orderId: string) =>
    q(async (tx) => {
      const [item] = await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId)).limit(1);
      await tx.insert(assets).values({
        businessId,
        orderId,
        type: "submission",
        storage: "cdn",
        url: `https://example.test/${orderId}-done.png`,
        orderItemId: item.id,
        createdAt: new Date(Date.now() - 30_000),
      });
      await tx.update(orders).set({ status: "awaiting_qc" }).where(eq(orders.id, orderId));
    });

  try {
    // --- 2a. The CPS 4205710209 + 4208132598 shape: two designers, one buyer.
    const cust = await newCustomer("pair", true);
    const a = await newOrder("A", { customerId: cust, status: "awaiting_qc", placedH: -5, dueH: 40, files: [{ seed: null }] });
    const b = await newOrder("B", { customerId: cust, status: "in_design", placedH: -4, dueH: 44 });
    // Her add-on receipt and an order still waiting on her photos never hold anything.
    await newOrder("addon", { customerId: cust, status: "fulfillment_only", placedH: -4, dueH: 44, title: "Rush order add-on" });
    await newOrder("photos", { customerId: cust, status: "awaiting_photos", placedH: -3, dueH: 44 });

    const sends0 = sent.length;
    const ra = await passQc(a.id);
    check("A passes with B still in design: held", ra.ok && ra.delivery === "held", ra.ok ? `${ra.title}: ${ra.description}` : ra.message);
    check("the held message names B", ra.ok && (ra.description ?? "").includes(b.number), ra.ok ? ra.description : "");
    check("A moved on to awaiting approval", (await statusOf(a.id)) === "awaiting_approval");
    const am = await qcPassMessage(a.id);
    const ah = holdOf(am?.metadata);
    check("A's proof is still a draft: no email went", am?.status === "draft" && sent.length === sends0, `${am?.status} sends=${sent.length - sends0}`);
    check("the hold is on the message: waiting on B only", ah?.waitingOn.map((w) => w.id).join() === b.id, JSON.stringify(ah?.waitingOn));
    check(
      "holdUntil = A's due less the margin (the earlier due)",
      !!ah && Math.abs(Date.parse(ah.holdUntil) - (now + 40 * H - RELEASE_MARGIN_MS)) < 5_000,
      ah?.holdUntil,
    );
    check("the passer is kept for the release", ah?.passedBy === va.id);
    const heldEvents = await events(a.id, HELD_ACTION);
    const he = (heldEvents[0]?.metadata ?? {}) as { waitingOn?: { id: string }[]; holdUntil?: string; messageId?: string };
    check("proof.held_for_siblings on A's history", heldEvents.length === 1 && he.messageId === am?.id && he.waitingOn?.[0]?.id === b.id && he.holdUntil === ah?.holdUntil);
    check("A's proof is not marked sent", (await proofSentAt(am?.proofId)) === null);
    const listed = await q((tx) => tx.execute(sql.raw(HELD_PROOFS_SQL)));
    const rows = ((listed as unknown as { rows?: Record<string, unknown>[] }).rows ?? (listed as unknown as Record<string, unknown>[])) as Record<string, unknown>[];
    const mine = rows.find((r) => r.order_id === a.id);
    check("the agent's SQL lists A with B and holdUntil", !!mine && mine.order_number === a.number && mine.waiting_on === b.number && !!mine.hold_until, JSON.stringify(mine));
    check("the order page reads the hold", (await q((tx) => heldProofFor(tx, a.id)))?.messageId === am?.id);
    const bWait = await events(b.id, SIBLING_WAITING_ACTION);
    const bw = (bWait[0]?.metadata ?? {}) as { messageId?: string; heldOrderNumber?: string };
    check("B's card gets the quiet signal: A waits for it", bWait.length === 1 && bw.messageId === am?.id && bw.heldOrderNumber === a.number, JSON.stringify(bw));
    const bSignals = await q((tx) =>
      tx
        .select({ action: activityLog.action, metadata: activityLog.metadata, createdAt: activityLog.createdAt })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, b.id), inArray(activityLog.action, [SIBLING_WAITING_ACTION, SIBLING_RELEASED_ACTION]))),
    );
    check("B's board label names A", (togetherWaitingNote(bSignals, new Date()) ?? "").includes(a.number));

    const sweep0 = await releaseDueDeliveryHolds();
    check("the sweep keeps it while B is in design", sweep0.kept >= 1 && (await qcPassMessage(a.id))?.status === "draft" && sent.length === sends0, JSON.stringify(sweep0));

    await setInDesignToQc(b.id);
    const sends1 = sent.length;
    const rb = await passQc(b.id);
    check("B passes: sent at once", rb.ok && rb.delivery === "email", rb.ok ? `${rb.title}` : rb.message);
    const am2 = await qcPassMessage(a.id);
    check("A's held proof went in the same step", am2?.status === "sent" && sent.length === sends1 + 2, `${am2?.status} sends=${sent.length - sends1}`);
    check("A's proof is marked sent", (await proofSentAt(am2?.proofId)) !== null);
    const rel = await events(a.id, RELEASED_ACTION);
    check("proof.hold_released on A, reason group_ready", rel.length === 1 && (rel[0].metadata as { reason?: string }).reason === "group_ready");
    const aSent = await events(a.id, "email.sent");
    check("email.sent logged for A via deliver_together", aSent.some((e) => (e.metadata as { via?: string }).via === "deliver_together"));
    const sends2 = sent.length;
    await releaseDueDeliveryHolds();
    await releaseHeldProof(am2!.id, { reason: "send_now" });
    check("a second sweep or release sends nothing more", sent.length === sends2 && (await events(a.id, RELEASED_ACTION)).length === 1);
    check("B's signal is closed once A went", (await events(b.id, SIBLING_RELEASED_ACTION)).length === 1);

    // --- 2b. Not held: placed more than 72 h apart; due too soon.
    const far = await newCustomer("far", true);
    await newOrder("far-old", { customerId: far, status: "in_design", placedH: -80, dueH: 30 });
    const farNew = await newOrder("far-new", { customerId: far, status: "awaiting_qc", placedH: -2, dueH: 40, files: [{ seed: null }] });
    const sends3 = sent.length;
    const rf = await passQc(farNew.id);
    check("her other order placed 78 h before: sent at once", rf.ok && rf.delivery === "email" && sent.length === sends3 + 1, rf.ok ? rf.title : rf.message);
    const soon = await newCustomer("soon", true);
    await newOrder("soon-other", { customerId: soon, status: "in_design", placedH: -3, dueH: 30 });
    const soonOne = await newOrder("soon-one", { customerId: soon, status: "awaiting_qc", placedH: -40, dueH: 0.5, files: [{ seed: null }] });
    const sends4 = sent.length;
    const rs = await passQc(soonOne.id);
    check("due in 30 min: never held (never late)", rs.ok && rs.delivery === "email" && sent.length === sends4 + 1, rs.ok ? rs.title : rs.message);

    // --- 2c. The sweep lets a hold go before its due time; never twice.
    const due = await newCustomer("due", true);
    const f = await newOrder("F", { customerId: due, status: "awaiting_qc", placedH: -10, dueH: 20, files: [{ seed: null }] });
    await newOrder("G", { customerId: due, status: "in_design", placedH: -9, dueH: 30 });
    const rF = await passQc(f.id);
    const fh = holdOf((await qcPassMessage(f.id))?.metadata);
    check("F held while G is in design", rF.ok && rF.delivery === "held" && !!fh);
    const sends5 = sent.length;
    const lastTick = new Date(Date.parse(fh!.holdUntil) - 5 * 60_000);
    const [s1, s2] = await Promise.all([releaseDueDeliveryHolds({ now: lastTick }), releaseDueDeliveryHolds({ now: lastTick })]);
    const fm = await qcPassMessage(f.id);
    check("the last sweep before holdUntil sends it", fm?.status === "sent" && sent.length === sends5 + 1, `${fm?.status} sends=${sent.length - sends5} ${JSON.stringify([s1, s2])}`);
    const fr = await events(f.id, RELEASED_ACTION);
    check("two sweeps at once: one release, reason due", fr.length === 1 && (fr[0].metadata as { reason?: string }).reason === "due");

    // --- 2d. The waiting order stops counting (cancelled): let go on the next sweep.
    const gone = await newCustomer("gone", true);
    const h1 = await newOrder("H", { customerId: gone, status: "awaiting_qc", placedH: -6, dueH: 40, files: [{ seed: null }] });
    const i1 = await newOrder("I", { customerId: gone, status: "in_design", placedH: -6, dueH: 40 });
    const rH = await passQc(h1.id);
    check("H held while I is in design", rH.ok && rH.delivery === "held");
    await q((tx) => tx.update(orders).set({ status: "cancelled" }).where(eq(orders.id, i1.id)));
    const sends6 = sent.length;
    await releaseDueDeliveryHolds();
    const hm = await qcPassMessage(h1.id);
    check("I cancelled: H goes on the next sweep", hm?.status === "sent" && sent.length === sends6 + 1, `${hm?.status}`);
    const hr = await events(h1.id, RELEASED_ACTION);
    check("released as group_ready", hr.length === 1 && (hr[0].metadata as { reason?: string }).reason === "group_ready");

    // --- 2g. She writes in on her other order while this one is held: it goes at once.
    const chaser = await newCustomer("asked", true);
    const l1 = await newOrder("L", { customerId: chaser, status: "awaiting_qc", placedH: -5, dueH: 40, files: [{ seed: null }] });
    const m1 = await newOrder("M", { customerId: chaser, status: "in_design", placedH: -5, dueH: 40 });
    const rL = await passQc(l1.id);
    check("L held while M is in design", rL.ok && rL.delivery === "held");
    const sendsA = sent.length;
    await releaseDueDeliveryHolds();
    check("no words from her yet: kept", (await qcPassMessage(l1.id))?.status === "draft" && sent.length === sendsA);
    await q((tx) =>
      tx.insert(messages).values({
        businessId,
        orderId: m1.id,
        direction: "inbound",
        channel: "email",
        status: "received",
        subject: `${MARK}${stamp} any update`,
        address: `${MARK}asked-${stamp}@example.test`,
        body: "Hi, any update on my portraits?",
      }),
    );
    await releaseDueDeliveryHolds();
    const lm = await qcPassMessage(l1.id);
    check("she wrote in on M: L goes on the next sweep", lm?.status === "sent" && sent.length === sendsA + 1, `${lm?.status} sends=${sent.length - sendsA}`);
    const lr = await events(l1.id, RELEASED_ACTION);
    check("released as she_asked", lr.length === 1 && (lr[0].metadata as { reason?: string }).reason === "she_asked");

    // --- 2e. No email on file (Etsy message): held as a draft, Send now queues it for the shop desk.
    const etsyBuyer = await newCustomer("etsy", false);
    const j = await newOrder("J", { customerId: etsyBuyer, status: "awaiting_qc", placedH: -5, dueH: 40, files: [{ seed: null }] });
    await newOrder("K", { customerId: etsyBuyer, status: "in_design", placedH: -5, dueH: 40 });
    const sends7 = sent.length;
    const rJ = await passQc(j.id);
    const jm = await qcPassMessage(j.id);
    check("an Etsy proof is held as a draft, not queued", rJ.ok && rJ.delivery === "held" && jm?.channel === "etsy" && jm.status === "draft" && !!holdOf(jm.metadata));
    const now1 = await sendHeldProofNowAction(j.id);
    const jm2 = await qcPassMessage(j.id);
    check("Send now queues it for the shop desk", now1.ok && jm2?.status === "queued" && sent.length === sends7, now1.message);
    check("etsy.queued logged via deliver_together", (await events(j.id, "etsy.queued")).some((e) => (e.metadata as { via?: string }).via === "deliver_together"));
    const jr = await events(j.id, RELEASED_ACTION);
    check("released as send_now by the person", jr.length === 1 && (jr[0].metadata as { reason?: string }).reason === "send_now");
    const again = await sendHeldProofNowAction(j.id);
    check("Send now again: nothing held any more", !again.ok && /no held proof/.test(again.message), again.message);

    // --- 2f. A VA sends the held draft from the outbox: it goes through the release.
    const outbox = await newCustomer("outbox", true);
    const sOrder = await newOrder("S", { customerId: outbox, status: "awaiting_qc", placedH: -5, dueH: 40, files: [{ seed: null }] });
    const tOrder = await newOrder("T", { customerId: outbox, status: "in_design", placedH: -5, dueH: 40 });
    const rS = await passQc(sOrder.id);
    const sm = await qcPassMessage(sOrder.id);
    check("S held while T is in design", rS.ok && rS.delivery === "held" && sm?.status === "draft");
    // Sent back and passed again while T is still in design: the old hold never goes.
    await q(async (tx) => {
      await tx.update(orders).set({ status: "awaiting_qc" }).where(eq(orders.id, sOrder.id));
      await tx.update(messages).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(messages.id, sm!.id));
      await tx.insert(assets).values({
        businessId,
        orderId: sOrder.id,
        type: "submission",
        storage: "cdn",
        url: `https://example.test/${sOrder.number}-v2.png`,
        orderItemId: sOrder.itemId,
        createdAt: new Date(Date.now() - 10_000),
      });
    });
    const rS2 = await passQc(sOrder.id);
    const sm2 = await qcPassMessage(sOrder.id);
    const oldHold = holdOf((await q((tx) => tx.select({ m: messages.metadata }).from(messages).where(eq(messages.id, sm!.id))))[0]?.m);
    check("passed again: a new held proof", rS2.ok && rS2.delivery === "held" && sm2?.id !== sm?.id && !!holdOf(sm2?.metadata));
    check("the old hold is closed as superseded", oldHold?.releaseReason === "superseded");
    const listedS = await q((tx) => tx.execute(sql.raw(HELD_PROOFS_SQL)));
    const rowsS = ((listedS as unknown as { rows?: Record<string, unknown>[] }).rows ?? (listedS as unknown as Record<string, unknown>[])) as Record<string, unknown>[];
    check("the agent's SQL lists S once", rowsS.filter((r) => r.order_id === sOrder.id).length === 1);
    const sends9 = sent.length;
    const ob = await approveAndSend(sm2!.id);
    const sm3 = await qcPassMessage(sOrder.id);
    check("outbox Approve sends the held draft through its release", ob.ok && sm3?.status === "sent" && sent.length === sends9 + 1, ob.ok ? ob.message ?? "" : ob.message);
    check("the proof is marked sent and the hold closed", (await proofSentAt(sm3?.proofId)) !== null && !!holdOf(sm3?.metadata)?.releasedAt);
    const sends10 = sent.length;
    await releaseDueDeliveryHolds();
    const oldRow = (await q((tx) => tx.select({ s: messages.status, a: messages.archivedAt }).from(messages).where(eq(messages.id, sm!.id))))[0];
    check("the old draft never goes and leaves the outbox", sent.length === sends10 && oldRow?.s === "draft" && !!oldRow.a);
    const stale = await approveAndSend(sm!.id);
    check("outbox Approve on the old draft is refused", !stale.ok && sent.length === sends10, stale.message ?? "");
    void tOrder;

    // --- 3. Wrong-file stop on every portrait's file at QC pass.
    // Another order's current file is picture 11. This order's portrait 2 is that same picture.
    await newOrder("wf-other", { customerId: null, status: "in_design", placedH: -20, dueH: 30, files: [{ seed: 11 }] });
    const wf = await newOrder("wf", {
      customerId: null,
      status: "awaiting_qc",
      placedH: -10,
      dueH: 40,
      quantity: 2,
      files: [
        { seed: 21, unit: 1 },
        { seed: 11, unit: 2 },
      ],
    });
    const sends8 = sent.length;
    const rw = await passQc(wf.id);
    check("portrait 2 is another order's picture: the QC pass stops", !rw.ok && rw.code === "wrong_file", rw.ok ? "sent!" : rw.message);
    check("nothing went out, still in QC", sent.length === sends8 && (await statusOf(wf.id)) === "awaiting_qc");
    // The transition road: two untagged files share one slot key, and the older one (portrait 1 by upload order) is the bad one.
    const wf2 = await newOrder("wf2", {
      customerId: null,
      status: "awaiting_qc",
      placedH: -10,
      dueH: 40,
      quantity: 2,
      files: [
        { seed: 11, tagged: false, ageMs: 120_000 },
        { seed: 31, tagged: false, ageMs: 60_000 },
      ],
    });
    let stopped: OrderTransitionError | null = null;
    try {
      await transition(vaUser, {
        orderId: wf2.id,
        to: "awaiting_approval",
        expectedFrom: "awaiting_qc",
        metadata: { itemResults: Object.fromEntries(DEFAULT_CHECKLIST.map((it) => [it.key, true])), signature: va.name },
      });
    } catch (e) {
      if (e instanceof OrderTransitionError) stopped = e;
      else throw e;
    }
    check(
      "transition road: the older untagged portrait is checked too",
      !!stopped && /has not gone to the customer yet|same picture|right file/i.test(stopped.message) && (await statusOf(wf2.id)) === "awaiting_qc",
      stopped ? stopped.message : "NOT stopped",
    );
  } finally {
    setTestSession(null);
    await q(async (tx) => {
      if (orderIds.length) {
        await tx.delete(exceptions).where(inArray(exceptions.orderId, orderIds));
        await tx.delete(orders).where(inArray(orders.id, orderIds));
      }
      if (customerIds.length) await tx.delete(customers).where(inArray(customers.id, customerIds));
    });
  }
}

async function main() {
  pure();
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.log("skip bench: local bench only (run it through scripts/ci-local.sh)");
  } else {
    await bench();
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
