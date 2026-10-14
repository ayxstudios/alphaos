// Etsy proof fallback (Yousif 2026-10-14: "For orders that don't have email in
// alphaOS you should still find a way to send it to them like through Etsy
// messages"). Approving an Etsy order with no email on file never dead-ends:
// the proof is queued as an Etsy message for the shop desk to send, Gmail is
// never touched, and no email sweep picks the row up. Also checked: a non-Etsy
// order with no email gets a clear ask, the email path is unchanged, and an AI
// portrait held for the owner is released into the Etsy queue, not emailed.
// Local bench only (scripts/ci-local.sh): creates orders marked "etsyq-" and
// removes them at the end.
import "./load-env";
import { setTestSession } from "./ci/next-request-stub";

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

import { approveOwnerReview, ensureAgentDesigner } from "../lib/agent/ai-designer";
import { runOutboxPass } from "../lib/agent/outbox";
import { withSystemContext, type RequestUser } from "../lib/db";
import {
  activityLog,
  assets,
  assignments,
  businesses,
  customers,
  exceptions,
  messages,
  orderItems,
  orders,
  proofs,
  shops,
  users,
} from "../lib/db/schema";
import { skipStaleBacklog } from "../lib/email/backlog-guard";
import { flushQueued, sendMessage } from "../lib/email/dispatch";
import { getOutbox, getQueuedEmailCount } from "../lib/email/outbox";
import { installMockTransport } from "../lib/mock/transport";
import { ownerApproveCore } from "../lib/qc/owner-approve";

const MARK = "etsyq-";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

type Q = Parameters<Parameters<typeof withSystemContext>[0]>[0];
const q = <T>(fn: (tx: Q) => Promise<T>) => withSystemContext(fn);

async function main() {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
    console.log("skip: local bench only (run it through scripts/ci-local.sh)");
    process.exit(0);
  }

  installMockTransport();
  // Count every Gmail send so "nothing was emailed" is a fact, not a guess, and
  // serve the portrait files (example.test) so the email path can attach them.
  let gmailSends = 0;
  const inner = globalThis.fetch;
  const png = Buffer.from(PNG, "base64");
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://example.test/")) {
      const head = (init?.method ?? (input instanceof Request ? input.method : "GET")) === "HEAD";
      return Promise.resolve(
        new Response(head ? null : png, { headers: { "content-type": "image/png", "content-length": String(png.length) } }),
      );
    }
    if (url.includes("gmail.googleapis.com") && url.includes("/messages/send")) gmailSends++;
    return inner(input, init);
  }) as typeof fetch;

  const [etsy] = await q((tx) =>
    tx
      .select({ shopId: shops.id, businessId: shops.businessId, businessName: businesses.name, agentConfig: businesses.agentConfig })
      .from(shops)
      .innerJoin(businesses, eq(businesses.id, shops.businessId))
      .where(and(eq(shops.platform, "etsy"), eq(businesses.emailSendingEnabled, true)))
      .limit(1),
  );
  if (!etsy) throw new Error("seed has no Etsy shop on a business with email sending on");
  const businessId = etsy.businessId;
  const [shopify] = await q((tx) =>
    tx.select({ id: shops.id }).from(shops).where(and(eq(shops.platform, "shopify"), eq(shops.businessId, businessId))).limit(1),
  );
  const [va] = await q((tx) =>
    tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, "va"), eq(users.active, true))).limit(1),
  );
  const [admin] = await q((tx) =>
    tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.role, "admin"), eq(users.active, true))).limit(1),
  );
  if (!shopify || !va?.name || !admin?.name) throw new Error("seed needs a Shopify shop, a named VA and a named admin");
  const vaUser: RequestUser = { id: va.id, role: "va" };
  const adminUser: RequestUser = { id: admin.id, role: "admin" };
  const asVa = () => setTestSession({ user: { id: va.id, role: "va", name: va.name } });
  const asAdmin = () => setTestSession({ user: { id: admin.id, role: "admin", name: admin.name } });

  const stamp = Date.now();
  const orderIds: string[] = [];
  const customerIds: string[] = [];

  async function newOrder(
    tag: string,
    opts: { shopId: string; customer: "none" | "no_email" | "email"; receiptName?: string; agent?: boolean },
  ) {
    return q(async (tx) => {
      let customerId: string | null = null;
      if (opts.customer !== "none") {
        const [c] = await tx
          .insert(customers)
          .values({
            businessId,
            // customers.email is NOT NULL: an imported buyer with no email has "".
            email: opts.customer === "email" ? `${MARK}${tag}-${stamp}@example.test` : "",
            firstName: "Sam",
            lastName: `${MARK}${stamp}`,
          })
          .returning({ id: customers.id });
        customerId = c.id;
        customerIds.push(c.id);
      }
      const name = `${MARK}${tag}-${stamp}`;
      const [o] = await tx
        .insert(orders)
        .values({
          businessId,
          shopId: opts.shopId,
          customerId,
          platformOrderId: name,
          platformOrderName: name,
          status: "awaiting_qc",
          source: "manual",
          uploadToken: randomUUID(),
          rawImport: opts.receiptName ? { name: opts.receiptName, is_gift: false } : null,
        })
        .returning({ id: orders.id });
      orderIds.push(o.id);
      await tx.insert(orderItems).values({
        businessId,
        orderId: o.id,
        title: "Cartoon portrait",
        style: "cartoon",
        figureCount: 1,
        figureCountSource: "manual",
        productType: "digital",
      });
      await tx.insert(assets).values({ businessId, orderId: o.id, type: "submission", storage: "cdn", url: `https://example.test/${name}.png` });
      if (opts.agent) {
        const agentId = await ensureAgentDesigner(tx, businessId);
        await tx.insert(assignments).values({ businessId, orderId: o.id, designerId: agentId, active: true });
        await tx.update(orders).set({ aiState: "qc" }).where(eq(orders.id, o.id));
      }
      return { id: o.id, number: name };
    });
  }

  const outbound = (orderId: string) =>
    q((tx) =>
      tx
        .select({
          id: messages.id,
          channel: messages.channel,
          status: messages.status,
          address: messages.address,
          proofId: messages.proofId,
          templateKey: messages.templateKey,
          body: messages.body,
          metadata: messages.metadata,
          approvedBy: messages.approvedBy,
          error: messages.error,
          sentAt: messages.sentAt,
          attachmentAssetId: messages.attachmentAssetId,
        })
        .from(messages)
        .where(and(eq(messages.orderId, orderId), eq(messages.direction, "outbound")))
        .orderBy(desc(messages.createdAt)),
    );
  const orderRow = (orderId: string) =>
    q((tx) => tx.select({ status: orders.status, ai: orders.aiState }).from(orders).where(eq(orders.id, orderId)).then((r) => r[0]));
  const proofRow = (proofId: string) =>
    q((tx) => tx.select({ token: proofs.token, sentAt: proofs.sentAt }).from(proofs).where(eq(proofs.id, proofId)).then((r) => r[0]));
  const actions = (orderId: string) =>
    q((tx) =>
      tx.select({ action: activityLog.action, metadata: activityLog.metadata }).from(activityLog).where(eq(activityLog.orderId, orderId)),
    );
  const meta = (m: unknown) => (m ?? {}) as Record<string, unknown>;

  try {
    // 1. The 4197971695 shape: Etsy order, no customer row at all.
    const a = await newOrder("noone", { shopId: etsy.shopId, customer: "none", receiptName: "Jamie Rivera" });
    const queuedBefore = await getQueuedEmailCount(vaUser, { businessId });
    const gmail0 = gmailSends;
    asVa();
    const ra = await ownerApproveCore(vaUser, va.name, a.id);
    check("Approve with no email succeeds", ra.ok, ra.ok ? "" : `${ra.code}: ${ra.message}`);
    check(
      "the result says it goes as an Etsy message",
      ra.ok && ra.title === "Queued for Etsy" && ra.delivery === "etsy" && !!ra.description?.includes(a.number) && !!ra.description?.includes("Etsy message"),
      ra.ok ? `${ra.title} / ${ra.description}` : "",
    );
    check("order moves to awaiting approval", (await orderRow(a.id))?.status === "awaiting_approval");
    const am = await outbound(a.id);
    const m = am[0];
    check("exactly one outbound proof message", am.length === 1, `rows=${am.length}`);
    check("it is an Etsy message, queued, with no address", m?.channel === "etsy" && m.status === "queued" && m.address === null, `${m?.channel}/${m?.status}/${m?.address}`);
    check(
      "marked as the no-email Etsy delivery and approved by the VA",
      meta(m?.metadata).delivery === "etsy_message" && meta(m?.metadata).reason === "no_email" && m?.approvedBy === va.id,
    );
    check("carries the proof template and the portrait", !!m?.templateKey?.startsWith("proof_ready") && !!m?.attachmentAssetId, `${m?.templateKey}`);
    const pa = m?.proofId ? await proofRow(m.proofId) : undefined;
    check("the message body has the proof link", !!pa && !!m?.body?.includes(`/proof/${pa.token}`));
    check("the buyer is greeted by the receipt first name", !!m?.body?.includes("Jamie"));
    check("proof not marked sent until the shop desk sends it", !!pa && pa.sentAt === null);
    const aa = await actions(a.id);
    check("activity: etsy.queued logged", aa.some((r) => r.action === "etsy.queued" && meta(r.metadata).messageId === m?.id));
    check("activity: the move says it went by the Etsy queue", aa.some((r) => meta(r.metadata).via === "qc_etsy_queue"));
    check("activity: no email.sent", !aa.some((r) => r.action === "email.sent"));
    check("Gmail was never called", gmailSends === gmail0, `sends=${gmailSends - gmail0}`);
    check("the email outbox count ignores it", (await getQueuedEmailCount(vaUser, { businessId })) === queuedBefore);
    check("the email outbox list ignores it", !(await getOutbox(vaUser, { businessId })).some((r) => r.messageId === m?.id));

    // 2. Sending it again only re-queues it; every Gmail sweep leaves it alone.
    const again = m ? await sendMessage(m.id, { approvedById: va.id }) : null;
    check("sendMessage on an Etsy row queues, never emails", !!again?.ok && "queued" in again && again.queued === "etsy");
    await flushQueued(businessId);
    await runOutboxPass({ id: businessId, name: etsy.businessName, agentConfig: etsy.agentConfig });
    await q((tx) => skipStaleBacklog(tx, businessId, new Date(Date.now() + 60 * 86_400_000)));
    const after = (await outbound(a.id))[0];
    check("after flush, outbox pass and backlog guard it is still queued", after?.status === "queued" && after.error === null && after.sentAt === null, `${after?.status} ${after?.error ?? ""}`);
    asVa();
    const twice = await ownerApproveCore(vaUser, va.name, a.id);
    check("a second Approve is refused and adds nothing", !twice.ok && (await outbound(a.id)).length === 1, twice.ok ? "" : twice.code);

    // 3. Customer row with no email: same path, their own first name.
    const b = await newOrder("noemail", { shopId: etsy.shopId, customer: "no_email" });
    asVa();
    const rb = await ownerApproveCore(vaUser, va.name, b.id);
    const bm = (await outbound(b.id))[0];
    check("customer with a blank email: queued for Etsy", rb.ok && rb.title === "Queued for Etsy" && bm?.channel === "etsy" && bm.status === "queued", rb.ok ? "" : rb.message);
    check("greeted by the customer's first name", !!bm?.body?.includes("Sam"));

    // 4. A Shopify order with no email has no other road: a clear ask, nothing moves.
    const c = await newOrder("shopify", { shopId: shopify.id, customer: "none" });
    asVa();
    const rc = await ownerApproveCore(vaUser, va.name, c.id);
    check(
      "non-Etsy order with no email asks for the email",
      !rc.ok && rc.code === "email" && rc.message.includes("No email on file"),
      rc.ok ? "" : rc.message,
    );
    check("it stays in QC with no message", (await orderRow(c.id))?.status === "awaiting_qc" && (await outbound(c.id)).length === 0);

    // 5. Email on file: the email path is unchanged.
    const d = await newOrder("email", { shopId: etsy.shopId, customer: "email" });
    const gmail1 = gmailSends;
    asVa();
    const rd = await ownerApproveCore(vaUser, va.name, d.id);
    const dm = (await outbound(d.id))[0];
    check("email on file: emailed as before", rd.ok && rd.title === "Sent to the customer" && rd.delivery === "email" && dm?.channel === "email" && dm.status === "sent", rd.ok ? `${dm?.status}` : `${rd.message} (${dm?.error ?? "no error saved"})`);
    check("the email went through Gmail once", gmailSends === gmail1 + 1, `sends=${gmailSends - gmail1}`);
    const pd = dm?.proofId ? await proofRow(dm.proofId) : undefined;
    check("emailed proof marked sent", !!pd?.sentAt);

    // 6. AI portrait held for the owner: draft first, Etsy queue on release.
    const e = await newOrder("ai", { shopId: etsy.shopId, customer: "none", receiptName: "Robin Lee", agent: true });
    const gmail2 = gmailSends;
    asVa();
    const re = await ownerApproveCore(vaUser, va.name, e.id);
    const held = (await outbound(e.id))[0];
    check("AI portrait: VA approve holds it for the owner", re.ok && re.title === "Approved" && re.delivery === "held" && (await orderRow(e.id))?.ai === "owner_review", re.ok ? re.title : re.message);
    check("the held proof is an Etsy draft", held?.channel === "etsy" && held.status === "draft");
    check("the held Etsy draft stays out of the email outbox", !(await getOutbox(vaUser, { businessId })).some((r) => r.messageId === held?.id));
    asAdmin();
    const released = await approveOwnerReview(e.id, admin.id);
    const rel = (await outbound(e.id))[0];
    check("owner approval releases it", released.ok, released.ok ? "" : released.message);
    check("released into the Etsy queue, not emailed", rel?.channel === "etsy" && rel.status === "queued" && gmailSends === gmail2, `${rel?.status} sends=${gmailSends - gmail2}`);
    const pe = rel?.proofId ? await proofRow(rel.proofId) : undefined;
    check("held proof still not marked sent", !!pe && pe.sentAt === null);
    const ea = await actions(e.id);
    check(
      "activity: etsy.queued via the owner approval, no email.sent",
      ea.some((r) => r.action === "etsy.queued" && meta(r.metadata).via === "ai_owner_approval") && !ea.some((r) => r.action === "email.sent"),
    );
    check("order is with the buyer", (await orderRow(e.id))?.ai === "with_buyer");

    // 6b. Held AI portrait with an email on file: the owner release still emails it.
    const g = await newOrder("ai-email", { shopId: etsy.shopId, customer: "email", agent: true });
    asVa();
    const rg = await ownerApproveCore(vaUser, va.name, g.id);
    const gHeld = (await outbound(g.id))[0];
    check("AI portrait with email: held as an email draft", rg.ok && rg.delivery === "held" && gHeld?.channel === "email" && gHeld.status === "draft", rg.ok ? `${gHeld?.channel}/${gHeld?.status}` : rg.message);
    const gmail3 = gmailSends;
    asAdmin();
    const gReleased = await approveOwnerReview(g.id, admin.id);
    const gm = (await outbound(g.id))[0];
    check("owner approval emails it as before", gReleased.ok && gm?.status === "sent" && gmailSends === gmail3 + 1, gReleased.ok ? `${gm?.status} sends=${gmailSends - gmail3}` : gReleased.message);
    const pg = gm?.proofId ? await proofRow(gm.proofId) : undefined;
    const ga = await actions(g.id);
    check("emailed after release: proof sent, email.sent logged", !!pg?.sentAt && ga.some((r) => r.action === "email.sent") && !ga.some((r) => r.action === "etsy.queued"));

    // 7. An admin approving an AI portrait releases it in one go.
    const f = await newOrder("ai-admin", { shopId: etsy.shopId, customer: "none", agent: true });
    asAdmin();
    const rf = await ownerApproveCore(adminUser, admin.name, f.id);
    const fm = (await outbound(f.id))[0];
    check("admin approve on an AI portrait: queued for Etsy", rf.ok && rf.title === "Queued for Etsy" && rf.delivery === "etsy" && fm?.channel === "etsy" && fm.status === "queued", rf.ok ? rf.title : rf.message);
  } finally {
    setTestSession(null);
    await q(async (tx) => {
      if (orderIds.length) {
        await tx.delete(exceptions).where(inArray(exceptions.orderId, orderIds));
        // Cascades messages, proofs, items, assets, assignments and QC rows;
        // activity_log is append-only and keeps its rows (order_id set null).
        await tx.delete(orders).where(inArray(orders.id, orderIds));
      }
      if (customerIds.length) await tx.delete(customers).where(inArray(customers.id, customerIds));
    });
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
