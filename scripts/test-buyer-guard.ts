/**
 * The wrong-customer guard on "complete order details", against a local or
 * staging database (it makes a business of its own and removes it; never run it
 * on production):
 * - a VA attaching another buyer's name and email to an order is refused with a
 *   message naming both people and the other order (Audrea Sanchez on Colleen
 *   Luczak's order), and the order is left exactly as it was;
 * - a new email typed with a name that is not the receipt buyer is refused (the
 *   "Hi Amanda" case);
 * - an email whose existing customer carries another person's name is refused,
 *   and the stored customer is never renamed (the "Hi shellie" case);
 * - Save anyway (confirmBuyerMismatch) goes through and leaves an audit trail;
 *   the system actor can never confirm, so the autopilot leaves it to a VA;
 * - the right name, manual orders and orders without a receipt name are never
 *   refused, and saving an order's own customer again never nags;
 * - mail drafted for an order whose customer is another person greets the
 *   receipt buyer, not the customer row's name.
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { and, eq, inArray, like } from "drizzle-orm";
import ws from "ws";

import { SYSTEM_ACTOR_ID, withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import {
  activityLog,
  assets,
  businesses,
  customers,
  designerProfiles,
  messages,
  notifications,
  orderItems,
  orders,
  shops,
  users,
} from "../lib/db/schema";
import { draftRevisionReceived } from "../lib/email/dispatch";
import { findBuyerMismatch } from "../lib/orders/buyer-guard";
import {
  completeOrderDetailsCore,
  type CompleteDetailsActor,
  type CompleteDetailsInput,
} from "../lib/orders/complete-details";

const MARK = "buyer-guard-";
const suffix = Date.now();
const mail = (who: string) => `${MARK}${who}-${suffix}@example.com`;

let failures = 0;
let skipped = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}
function skip(name: string, why: string) {
  console.log(`SKIP  ${name}`);
  console.log(`      ${why}`);
  skipped += 1;
}

/**
 * Moving an order to ready_to_assign runs auto-assign, which reads
 * designer_profiles.style_daily_limits. A database that is behind on migrations
 * lacks that column and fails there, whatever the buyer check did.
 */
async function autoAssignReady(): Promise<boolean> {
  try {
    await withSystemContext((tx) => tx.select({ limits: designerProfiles.styleDailyLimits }).from(designerProfiles).limit(1));
    return true;
  } catch {
    return false;
  }
}
const BEHIND = "this database is behind on migrations (designer_profiles.style_daily_limits is missing), so auto-assign cannot run";

const ids = { businessId: randomUUID(), shopId: randomUUID(), vaId: randomUUID() };
const VA: CompleteDetailsActor = { id: ids.vaId, role: "va" };
const SYS: CompleteDetailsActor = { id: SYSTEM_ACTOR_ID, role: "system" };

// Customers that already exist before the VA touches anything.
const known = {
  audrea: { id: randomUUID(), email: mail("audrea"), first: "Audrea", last: "Sanchez" },
  // The name a VA once saved under Mary Kate's email.
  shellie: { id: randomUUID(), email: mail("mkshepp"), first: "shellie", last: "suhar" },
  other: { id: randomUUID(), email: mail("other"), first: "Other", last: "Person" },
};

// Orders. `buyer` is the Etsy receipt name (raw_import.name).
const order = {
  audreaOwn: { id: randomUUID(), number: "4196536586" },
  shellieOld: { id: randomUUID(), number: "4180150396" },
  colleen: { id: randomUUID(), number: "4198274617" },
  maya: { id: randomUUID(), number: "4199520716" },
  maryKate: { id: randomUUID(), number: "4197194057" },
  dana: { id: randomUUID(), number: "4190000001" },
  danaLower: { id: randomUUID(), number: "4190000002" },
  stub: { id: randomUUID(), number: "4190000003" },
  manual: { id: randomUUID(), number: "MAN-1" },
  noReceipt: { id: randomUUID(), number: "4190000004" },
  sysWrong: { id: randomUUID(), number: "4190000005" },
  sysRight: { id: randomUUID(), number: "4190000006" },
  gina: { id: randomUUID(), number: "4190000007" },
  pia: { id: randomUUID(), number: "4190000008" },
};

type Seed = {
  id: string;
  number: string;
  status?: (typeof orders.$inferInsert)["status"];
  source?: "etsy" | "manual";
  rawImport?: unknown;
  customerId?: string | null;
};

async function setup() {
  const seeds: Seed[] = [
    { ...order.audreaOwn, status: "in_design", rawImport: { name: "Audrea Sanchez" }, customerId: known.audrea.id },
    { ...order.shellieOld, status: "complete", rawImport: { name: "shellie suhar" }, customerId: known.shellie.id },
    { ...order.colleen, rawImport: { name: "Colleen Luczak" } },
    { ...order.maya, rawImport: { name: "Maya Scopin" } },
    { ...order.maryKate, rawImport: { name: "Mary Kate Sheppard" } },
    { ...order.dana, rawImport: { name: "Dana Whitfield" } },
    { ...order.danaLower, rawImport: { name: "Dana Whitfield" } },
    { ...order.stub, rawImport: { source: "etsy_sale_email", receiptId: "4190000003", buyerName: "Sam Ortiz" } },
    { ...order.manual, source: "manual", rawImport: null },
    { ...order.noReceipt, rawImport: null },
    { ...order.sysWrong, rawImport: { name: "Fiona Gray" } },
    { ...order.sysRight, rawImport: { name: "Fiona Gray" } },
    { ...order.gina, status: "awaiting_photos", rawImport: { name: "Gina Park" }, customerId: known.other.id },
    { ...order.pia, rawImport: { name: "Pia Moreno" } },
  ];
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.businessId, name: "Buyer Guard", slug: `${MARK}${suffix}` });
    await tx.insert(users).values({ id: ids.vaId, email: mail("va"), name: "Guard VA", role: "va" });
    await tx.insert(shops).values({
      id: ids.shopId,
      businessId: ids.businessId,
      platform: "etsy",
      name: "Guard Etsy",
      externalShopId: `${MARK}${suffix}`,
      credentials: {},
    });
    await tx.insert(customers).values(
      Object.values(known).map((c) => ({
        id: c.id,
        businessId: ids.businessId,
        email: c.email,
        firstName: c.first,
        lastName: c.last,
      })),
    );
    await tx.insert(orders).values(
      seeds.map((s) => ({
        id: s.id,
        businessId: ids.businessId,
        shopId: ids.shopId,
        platformOrderId: s.number,
        platformOrderName: s.number,
        status: s.status ?? "awaiting_details",
        source: s.source ?? "etsy",
        rawImport: s.rawImport ?? null,
        customerId: s.customerId ?? null,
      })),
    );
  });
}

/** Our business, plus any a crashed earlier run left behind (matched by slug). */
async function cleanup() {
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! });
  const ownerDb = drizzle(pool, { schema });
  try {
    await ownerDb.transaction(async (tx) => {
      const biz = (
        await tx.select({ id: businesses.id }).from(businesses).where(like(businesses.slug, `${MARK}%`))
      ).map((b) => b.id);
      if (biz.length) {
        await tx.delete(notifications).where(inArray(notifications.businessId, biz));
        await tx.delete(activityLog).where(inArray(activityLog.businessId, biz));
        await tx.delete(messages).where(inArray(messages.businessId, biz));
        await tx.delete(assets).where(inArray(assets.businessId, biz));
        await tx.delete(orderItems).where(inArray(orderItems.businessId, biz));
        await tx.delete(orders).where(inArray(orders.businessId, biz));
        await tx.delete(customers).where(inArray(customers.businessId, biz));
        await tx.delete(shops).where(inArray(shops.businessId, biz));
        await tx.delete(businesses).where(inArray(businesses.id, biz));
      }
      await tx.delete(users).where(like(users.email, `${MARK}%`));
    });
  } finally {
    await pool.end();
  }
}

function complete(actor: CompleteDetailsActor, orderId: string, input: Partial<CompleteDetailsInput>) {
  return completeOrderDetailsCore(actor, { orderId, productType: "digital", ...input }, (fn) => withSystemContext(fn));
}

async function orderState(orderId: string) {
  return withSystemContext(async (tx) => {
    const [o] = await tx
      .select({ status: orders.status, customerId: orders.customerId })
      .from(orders)
      .where(eq(orders.id, orderId));
    const log = await tx
      .select({ action: activityLog.action, actorId: activityLog.actorId, metadata: activityLog.metadata })
      .from(activityLog)
      .where(eq(activityLog.orderId, orderId))
      .orderBy(activityLog.createdAt);
    const items = await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId));
    return { status: o?.status, customerId: o?.customerId ?? null, log, items: items.length };
  });
}

async function customerByEmail(email: string) {
  return withSystemContext(async (tx) => {
    const [c] = await tx
      .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName })
      .from(customers)
      .where(and(eq(customers.businessId, ids.businessId), eq(customers.email, email)));
    return c ?? null;
  });
}

type LogRow = Awaited<ReturnType<typeof orderState>>["log"][number];
const meta = (row: LogRow | undefined) => (row?.metadata ?? {}) as Record<string, unknown>;

/** The first greeting word of a revision_received draft for this order's customer. */
async function draftedGreeting(o: { id: string; number: string }) {
  return withSystemContext(async (tx) => {
    const [row] = await tx.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, o.id));
    await draftRevisionReceived(tx, {
      id: o.id,
      businessId: ids.businessId,
      customerId: row?.customerId ?? null,
      platformOrderId: o.number,
      platformOrderName: o.number,
    });
    const [m] = await tx
      .select({ body: messages.body, address: messages.address, status: messages.status })
      .from(messages)
      .where(and(eq(messages.orderId, o.id), eq(messages.templateKey, "revision_received")));
    return m ? { ...m, body: m.body ?? "" } : null;
  });
}

async function main() {
  await cleanup();
  await setup();
  try {
    /* (a) Colleen's order, a VA types Audrea's name and email */
    const a1 = await complete(VA, order.colleen.id, {
      customerName: "Audrea Sanchez",
      customerEmail: known.audrea.email,
    });
    const a1Msg = a1.ok ? "" : a1.message;
    const a1State = await orderState(order.colleen.id);
    report(
      "(a) Audrea's details on Colleen's order are refused as buyer_mismatch",
      !a1.ok && a1.code === "buyer_mismatch",
      JSON.stringify(a1),
    );
    report(
      "(a) the message names both people, the email and the other order",
      a1Msg.includes("Colleen Luczak") &&
        a1Msg.includes("Audrea Sanchez") &&
        a1Msg.includes(known.audrea.email) &&
        a1Msg.includes(order.audreaOwn.number) &&
        a1Msg.includes("Save anyway"),
      a1Msg,
    );
    report(
      "(a) the refused order is untouched: still awaiting_details, no customer, no item, no log",
      a1State.status === "awaiting_details" && a1State.customerId === null && a1State.items === 0 && a1State.log.length === 0,
      JSON.stringify(a1State),
    );

    const a2 = await complete(VA, order.colleen.id, {
      customerName: "Audrea Sanchez",
      customerEmail: known.audrea.email,
      confirmBuyerMismatch: true,
    });
    const a2State = await orderState(order.colleen.id);
    const a2Row = a2State.log.find((l) => l.action === "order.awaiting_photos");
    report(
      "(a) Save anyway goes through and the order moves on",
      a2.ok && a2State.status === "awaiting_photos" && a2State.customerId === known.audrea.id,
      JSON.stringify({ a2, status: a2State.status }),
    );
    report(
      "(a) the audit row records the confirmation, the buyer and the name entered",
      meta(a2Row).buyerMismatchConfirmed === true &&
        meta(a2Row).receiptBuyer === "Colleen Luczak" &&
        meta(a2Row).enteredName === "Audrea Sanchez" &&
        meta(a2Row).enteredEmail === known.audrea.email &&
        a2Row?.actorId === ids.vaId,
      JSON.stringify(a2Row),
    );
    const greetA = await draftedGreeting(order.colleen);
    report(
      "(a) mail to that order greets the buyer (Colleen), not the customer row (Audrea)",
      !!greetA && /^Hi Colleen\b/.test(greetA.body) && greetA.address === known.audrea.email,
      JSON.stringify(greetA?.body.split("\n")[0]),
    );

    /* (b) Maya's order, a VA types Amanda Rinehart with Maya's email */
    const mayaEmail = mail("maya");
    const b1 = await complete(VA, order.maya.id, { customerName: "Amanda Rinehart", customerEmail: mayaEmail });
    const b1Msg = b1.ok ? "" : b1.message;
    const b1State = await orderState(order.maya.id);
    report(
      "(b) a new email under another name is refused as buyer_mismatch",
      !b1.ok && b1.code === "buyer_mismatch",
      JSON.stringify(b1),
    );
    report(
      "(b) the message names Maya Scopin and Amanda Rinehart, with no other order",
      b1Msg.includes("Maya Scopin") && b1Msg.includes("Amanda Rinehart") && !b1Msg.includes("also on order"),
      b1Msg,
    );
    report(
      "(b) nothing was written: no customer for that email, order untouched",
      (await customerByEmail(mayaEmail)) === null && b1State.status === "awaiting_details" && b1State.log.length === 0,
      JSON.stringify(b1State),
    );
    const b2 = await complete(VA, order.maya.id, {
      customerName: "Amanda Rinehart",
      customerEmail: mayaEmail,
      confirmBuyerMismatch: true,
    });
    const greetB = await draftedGreeting(order.maya);
    report(
      "(b) after Save anyway the greeting is still Maya, not Amanda",
      b2.ok && !!greetB && /^Hi Maya\b/.test(greetB.body) && !greetB.body.includes("Amanda"),
      JSON.stringify(greetB?.body.split("\n")[0]),
    );

    /* (c) Mary Kate's order, whose email already sits on a customer named shellie suhar */
    const c1 = await complete(VA, order.maryKate.id, {
      customerName: "Mary Kate Sheppard",
      customerEmail: known.shellie.email,
    });
    const c1Msg = c1.ok ? "" : c1.message;
    report(
      "(c) typing the right name does not hide an email that belongs to another customer",
      !c1.ok && c1.code === "buyer_mismatch",
      JSON.stringify(c1),
    );
    report(
      "(c) the message names Mary Kate Sheppard, shellie suhar and the other order",
      c1Msg.includes("Mary Kate Sheppard") && c1Msg.includes("shellie suhar") && c1Msg.includes(order.shellieOld.number),
      c1Msg,
    );
    const c2 = await complete(VA, order.maryKate.id, {
      customerName: "Mary Kate Sheppard",
      customerEmail: known.shellie.email,
      confirmBuyerMismatch: true,
    });
    const shellieRow = await customerByEmail(known.shellie.email);
    const greetC = await draftedGreeting(order.maryKate);
    report(
      "(c) Save anyway links the order, and the stored customer is never renamed",
      c2.ok && shellieRow?.firstName === "shellie" && shellieRow?.lastName === "suhar",
      JSON.stringify({ c2, shellieRow }),
    );
    report(
      "(c) mail to Mary Kate's order says Hi Mary, never Hi shellie",
      !!greetC && /^Hi Mary\b/.test(greetC.body) && !/shellie/i.test(greetC.body),
      JSON.stringify(greetC?.body.split("\n")[0]),
    );
    const greetShellieOld = await draftedGreeting(order.shellieOld);
    report(
      "(c) the order whose buyer really is shellie suhar still greets as shellie",
      !!greetShellieOld && /^Hi shellie\b/.test(greetShellieOld.body),
      JSON.stringify(greetShellieOld?.body.split("\n")[0]),
    );

    /* The right name is never refused */
    const danaEmail = mail("dana");
    const d1 = await complete(VA, order.dana.id, { customerName: "Dana Whitfield", customerEmail: danaEmail });
    const d1State = await orderState(order.dana.id);
    const d1Row = d1State.log.find((l) => l.action === "order.awaiting_photos");
    const danaCustomer = await customerByEmail(danaEmail);
    report(
      "the buyer's own name and a new email go straight through, with no mismatch flag in the log",
      d1.ok &&
        d1State.status === "awaiting_photos" &&
        danaCustomer?.firstName === "Dana" &&
        danaCustomer?.lastName === "Whitfield" &&
        meta(d1Row).buyerMismatchConfirmed === undefined &&
        meta(d1Row).via === "manual_complete",
      JSON.stringify({ d1, row: d1Row }),
    );
    const greetD = await draftedGreeting(order.dana);
    report("mail to that order greets the customer by their own first name", !!greetD && /^Hi Dana\b/.test(greetD.body), JSON.stringify(greetD?.body.split("\n")[0]));
    const d2 = await complete(VA, order.danaLower.id, { customerName: "dana whitfield", customerEmail: mail("dana2") });
    report("a different capitalisation of the buyer's name is not refused", d2.ok, JSON.stringify(d2));

    /* A sale-email stub keeps its buyer under buyerName */
    const stub1 = await complete(VA, order.stub.id, { customerName: "Someone Else", customerEmail: mail("stub") });
    report(
      "an order made from a sale email checks the buyer name it stored",
      !stub1.ok && stub1.code === "buyer_mismatch" && stub1.message.includes("Sam Ortiz"),
      JSON.stringify(stub1),
    );

    /* Nothing to check against */
    const m1 = await complete(VA, order.manual.id, { customerName: "Anyone At All", customerEmail: mail("manual") });
    const m1State = await orderState(order.manual.id);
    report(
      "a manual order takes any name",
      m1.ok && m1State.status === "awaiting_photos" && meta(m1State.log.find((l) => l.action === "order.awaiting_photos")).buyerMismatchConfirmed === undefined,
      JSON.stringify(m1),
    );
    const n1 = await complete(VA, order.noReceipt.id, { customerName: "Anyone At All", customerEmail: mail("noreceipt") });
    report("an Etsy order with no stored receipt name takes any name", n1.ok, JSON.stringify(n1));

    /* The autopilot (system actor) can never confirm */
    const s1 = await complete(SYS, order.sysWrong.id, {
      customerName: "Audrea Sanchez",
      customerEmail: known.audrea.email,
      confirmBuyerMismatch: true,
    });
    const s1State = await orderState(order.sysWrong.id);
    report(
      "the system actor is refused even when it passes confirmBuyerMismatch",
      !s1.ok && s1.code === "buyer_mismatch" && s1State.status === "awaiting_details" && s1State.customerId === null && s1State.log.length === 0,
      JSON.stringify({ s1, status: s1State.status }),
    );
    const s2 = await complete(SYS, order.sysRight.id, { customerName: "Fiona Gray", customerEmail: mail("fiona") });
    const s2State = await orderState(order.sysRight.id);
    const s2Row = s2State.log.find((l) => l.action === "order.awaiting_photos");
    report(
      "the system actor still completes an order whose customer is the buyer",
      s2.ok && s2State.status === "awaiting_photos" && s2Row?.actorId === null && meta(s2Row).buyerMismatchConfirmed === undefined,
      JSON.stringify({ s2, row: s2Row }),
    );

    /* Saving an order's own customer again attaches nobody new */
    const g1 = await complete(VA, order.gina.id, { customerName: "Other Person", customerEmail: known.other.email, notes: "first save" });
    const g2 = await complete(VA, order.gina.id, { customerEmail: known.other.email, notes: "no name typed" });
    report(
      "re-saving the order's own customer (same name, or no name) is not refused",
      g1.ok && g2.ok,
      JSON.stringify({ g1, g2 }),
    );
    const g3 = await complete(VA, order.gina.id, { customerName: "Gina Park", customerEmail: known.other.email });
    report(
      "typing the buyer's name over another customer's email is still refused",
      !g3.ok && g3.code === "buyer_mismatch" && g3.message.includes("Other Person"),
      JSON.stringify(g3),
    );
    /* The edges into ready_to_assign (photos given) run auto-assign too */
    if (await autoAssignReady()) {
      const g4 = await complete(VA, order.gina.id, {
        customerName: "Other Person",
        customerEmail: known.other.email,
        photoUrls: ["https://example.com/photo.jpg"],
      });
      const g4State = await orderState(order.gina.id);
      const g4Row = g4State.log.find((l) => l.action === "order.ready_to_assign");
      report(
        "adding photos to that order moves it on, with no mismatch flag",
        g4.ok && g4State.status === "ready_to_assign" && meta(g4Row).via === "manual_photo_upload" && meta(g4Row).buyerMismatchConfirmed === undefined,
        JSON.stringify({ g4, row: g4Row }),
      );

      // Save anyway with photos: the flag rides on the ready_to_assign row.
      const p1 = await complete(VA, order.pia.id, {
        customerName: "Audrea Sanchez",
        customerEmail: known.audrea.email,
        photoUrls: ["https://example.com/pia.jpg"],
        confirmBuyerMismatch: true,
      });
      const p1State = await orderState(order.pia.id);
      const p1Row = p1State.log.find((l) => l.action === "order.ready_to_assign");
      report(
        "a confirmed mismatch with photos records the flag on the ready_to_assign row",
        p1.ok && p1State.status === "ready_to_assign" && meta(p1Row).buyerMismatchConfirmed === true && meta(p1Row).receiptBuyer === "Pia Moreno",
        JSON.stringify({ p1, row: p1Row }),
      );
    } else {
      skip("adding photos to an order that keeps its own customer moves it on, with no mismatch flag", BEHIND);
      skip("a confirmed mismatch with photos records the flag on the ready_to_assign row", BEHIND);
    }

    /* The same check as a plain function, for linking a reply to an order */
    const link = await withSystemContext((tx) =>
      findBuyerMismatch(tx, {
        businessId: ids.businessId,
        orderId: order.colleen.id,
        orderCustomerId: null,
        email: known.audrea.email,
        typedName: "Audrea Sanchez",
        receiptBuyer: "Colleen Luczak",
        overrideLabel: "Link anyway",
      }),
    );
    report(
      "the link check names the Link anyway button and both orders",
      !!link && link.message.includes("Link anyway") && !link.message.includes("Save anyway") && link.message.includes(order.audreaOwn.number),
      link?.message ?? "no mismatch",
    );
    const linkFine = await withSystemContext((tx) =>
      findBuyerMismatch(tx, {
        businessId: ids.businessId,
        orderId: order.colleen.id,
        orderCustomerId: null,
        email: mail("nobody-yet"),
        typedName: "Colleen Luczak",
        receiptBuyer: "Colleen Luczak",
        overrideLabel: "Link anyway",
      }),
    );
    report("the link check passes the buyer's own name", linkFine === null, JSON.stringify(linkFine));

    /* Nobody was renamed by any of the above */
    const audreaRow = await customerByEmail(known.audrea.email);
    const otherRow = await customerByEmail(known.other.email);
    report(
      "no existing customer was renamed",
      audreaRow?.firstName === "Audrea" &&
        audreaRow?.lastName === "Sanchez" &&
        shellieRow?.firstName === "shellie" &&
        otherRow?.firstName === "Other" &&
        otherRow?.lastName === "Person",
      JSON.stringify({ audreaRow, shellieRow, otherRow }),
    );
  } finally {
    await cleanup();
  }
  if (failures) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log(skipped ? `\nALL PASSED (${skipped} skipped)` : "\nALL PASSED");
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
