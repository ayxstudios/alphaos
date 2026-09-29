// AI designer backend against the DEMO database (Paws and Pencils): enable ->
// intake -> job listed -> claim -> deliver -> VA QC -> owner approval ->
// revision -> deliver again, plus reassign-away and the jobs API auth.
// Creates synthetic orders (marker "aitest-"), removes them at the end, and
// leaves the "Disney Pet" style enabled with framework pixart-disney-pet.
// Never run against staging or production.
import "./load-env";

import { randomUUID } from "node:crypto";

process.env.AGENT_JOBS_TOKEN ||= "aitest-" + randomUUID();
if (!process.env.ANTHROPIC_API_KEY?.startsWith("mock_")) process.env.ANTHROPIC_API_KEY = "mock_sk-ant-aitest";

import { and, desc, eq, like, sql } from "drizzle-orm";
import { NextRequest } from "next/server";

import {
  approveOwnerReview,
  claimJob,
  deliverJob,
  failJob,
  getAgentDesignerId,
  holdForOwnerReview,
  listOwnerReview,
  listPendingJobs,
  reassignOrder,
  setStyleAiDesigner,
} from "../lib/agent/ai-designer";
import { getAgentConfig } from "../lib/agent/config";
import { withSystemContext, SYSTEM_ACTOR_ID } from "../lib/db";
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
  proofs,
  qcChecks,
  shops,
  styles,
  users,
} from "../lib/db/schema";
import { installMockTransport } from "../lib/mock/transport";
import { runAutoAssign } from "../lib/orders/assign";
import { runTransition } from "../lib/orders/transitions";
import { generateProofToken } from "../lib/proofs/tokens";
import { resolveChecklist } from "../lib/qc/checklist";

installMockTransport?.();

const BUSINESS_NAME = "Paws and Pencils";
const MARK = "aitest-";
const STYLE = "Disney Pet";
const FRAMEWORK = "pixart-disney-pet";
const SYS = { id: SYSTEM_ACTOR_ID, role: "system" as const };
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};
async function rejects(fn: () => Promise<unknown>, status: number) {
  try {
    await fn();
    return false;
  } catch (e) {
    return (e as { status?: number }).status === status;
  }
}

const q = <T>(fn: (tx: Parameters<Parameters<typeof withSystemContext>[0]>[0]) => Promise<T>) => withSystemContext(fn);
const act = (orderId: string, action: string) =>
  q((tx) =>
    tx
      .select({ metadata: activityLog.metadata, actorId: activityLog.actorId })
      .from(activityLog)
      .where(and(eq(activityLog.orderId, orderId), eq(activityLog.action, action)))
      .orderBy(desc(activityLog.createdAt)),
  );
const state = (orderId: string) =>
  q((tx) => tx.select({ s: orders.status, ai: orders.aiState, rc: orders.revisionCount }).from(orders).where(eq(orders.id, orderId)).then((r) => r[0]));

async function main() {
  const [biz] = await q((tx) => tx.select({ id: businesses.id, agentConfig: businesses.agentConfig }).from(businesses).where(eq(businesses.name, BUSINESS_NAME)));
  if (!biz) throw new Error("demo business missing");
  const businessId = biz.id;
  const [shop] = await q((tx) => tx.select({ id: shops.id }).from(shops).where(eq(shops.businessId, businessId)).limit(1));
  const [admin] = await q((tx) => tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.active, true))).limit(1));
  const [human] = await q((tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(designerBusinesses, and(eq(designerBusinesses.userId, users.id), eq(designerBusinesses.businessId, businessId)))
      .where(and(eq(users.role, "designer"), sql`${users.email} not like 'ai-studio+%'`))
      .limit(1),
  );
  const agentId = await q((tx) => getAgentDesignerId(tx, businessId));
  check("agent designer exists for the business", !!agentId);
  if (!agentId || !admin || !human || !shop) throw new Error("demo data missing");

  // Style: the PixArt-like product. Created once, left enabled at the end.
  await q(async (tx) => {
    const [s] = await tx.select({ id: styles.id }).from(styles).where(and(eq(styles.businessId, businessId), sql`lower(${styles.name}) = lower(${STYLE})`));
    if (!s) await tx.insert(styles).values({ businessId, name: STYLE, titleMatches: ["Disney", "Pixar"] });
  });

  // Owner approval switch restored at the end.
  const originalConfig = biz.agentConfig;
  const created: string[] = [];
  const stamp = Date.now();

  try {
    check("config: aiOwnerApproval defaults true", getAgentConfig({ agentConfig: null } as never).aiOwnerApproval === true);
    check("config: autoSendReplies defaults true", getAgentConfig({ agentConfig: null } as never).autoSendReplies === true);

    const [cust] = await q((tx) =>
      tx.insert(customers).values({ businessId, email: `${MARK}${stamp}@example.test`, firstName: "Ai", lastName: "Test" }).returning({ id: customers.id }),
    );
    async function newOrder(tag: string, style: string) {
      return q(async (tx) => {
        const name = `${MARK}${tag}-${stamp}`;
        const [o] = await tx
          .insert(orders)
          .values({
            businessId,
            shopId: shop.id,
            customerId: cust.id,
            platformOrderId: name,
            platformOrderName: name,
            status: "ready_to_assign",
            source: "manual",
            uploadToken: randomUUID(),
            notes: "Please keep the white paw.",
          })
          .returning({ id: orders.id });
        created.push(o.id);
        await tx.insert(orderItems).values({
          businessId,
          orderId: o.id,
          title: `${style} portrait`,
          style,
          figureCount: 1,
          figureCountSource: "manual",
          productType: "digital",
        });
        await tx.insert(assets).values({ businessId, orderId: o.id, type: "reference", storage: "cdn", url: `https://example.test/${name}.jpg` });
        return o.id;
      });
    }

    // 1. Switch off: goes to a human. Switch on: goes to the agent.
    await q((tx) => setStyleAiDesigner(tx, { businessId, styleName: STYLE, enabled: false }));
    const off = await newOrder("off", STYLE);
    const offRes = await q((tx) => runAutoAssign(tx, { orderId: off, businessId, assignedBy: null }));
    check("AI off: order goes to a human, not the agent", offRes.assigned !== agentId && (await state(off)).ai === null);

    await q((tx) => setStyleAiDesigner(tx, { businessId, styleName: STYLE, enabled: true, framework: FRAMEWORK }));
    const id = await newOrder("main", STYLE);
    const res = await q((tx) => runAutoAssign(tx, { orderId: id, businessId, assignedBy: null }));
    check("AI on: intake assigns to the agent", res.assigned === agentId);
    check("order marked queued for the agent", (await state(id)).ai === "queued");

    // 2. Job listed with the right shape.
    const jobs = await listPendingJobs({ businessId });
    const job = jobs.find((j) => j.jobId === id);
    check("job listed", !!job && job.kind === "new");
    check("job carries framework, photos, notes", job?.product.aiFramework === FRAMEWORK && job.buyerPhotoUrls.length === 1 && job.buyerNotes === "Please keep the white paw.");
    check("job carries order number and business", job?.orderNumber === `${MARK}main-${stamp}` && job.business.id === businessId);
    check("human order not listed", !jobs.some((j) => j.jobId === off));

    // 3. Claim once; a second claim conflicts.
    const claimed = await claimJob(id);
    check("claim ok, order in design", claimed.jobId === id && (await state(id)).s === "in_design");
    check("second claim rejected (409)", await rejects(() => claimJob(id), 409));
    check("claimed job leaves the pending list", !(await listPendingJobs({ businessId })).some((j) => j.jobId === id));

    // 4. Deliver needs a selfCheck; base64 and url both work.
    check("deliver without selfCheck rejected (400)", await rejects(() => deliverJob(id, { url: "https://example.test/p.png" }), 400));
    const d1 = await deliverJob(id, { url: "https://example.test/portrait-1.png", selfCheck: "Fur colours match photo 1; white paw kept." });
    const st1 = await state(id);
    check("deliver advances to VA QC", d1.status === "awaiting_qc" && st1.s === "awaiting_qc" && st1.ai === "qc");
    const delAct = (await act(id, "ai.delivered"))[0];
    check("ai.delivered logged with selfCheck", (delAct?.metadata as { selfCheck?: string })?.selfCheck?.includes("white paw") === true && delAct?.actorId === agentId);
    const subs = await q((tx) => tx.select({ id: assets.id }).from(assets).where(and(eq(assets.orderId, id), eq(assets.type, "submission"))));
    check("proof stored as a submission asset", subs.length === 1);

    // 5. VA QC pass (what confirmQcPassAndSend does) with the email held for the owner.
    async function qcPassHeld(orderId: string) {
      return q(async (tx) => {
        const [p] = await tx.insert(proofs).values({ businessId, orderId, token: generateProofToken() }).returning({ id: proofs.id });
        const [m] = await tx
          .insert(messages)
          .values({
            businessId,
            orderId,
            customerId: cust.id,
            direction: "outbound",
            channel: "email",
            status: "draft",
            templateKey: "proof_ready",
            proofId: p.id,
            subject: "Your portrait is ready",
            body: "Here it is.",
            address: `${MARK}${stamp}@example.test`,
            metadata: { qcPass: { signature: "Test VA" } },
          })
          .returning({ id: messages.id });
        const [sh] = await tx.select({ v: shops.checklistVersion, c: shops.integrationConfig }).from(shops).where(eq(shops.id, shop.id));
        const itemResults = Object.fromEntries(resolveChecklist({ checklistVersion: sh?.v ?? 1, integrationConfig: sh?.c ?? null }).items.map((i) => [i.key, true]));
        await runTransition(tx, SYS, { orderId, to: "awaiting_approval", expectedFrom: "awaiting_qc", metadata: { via: "qc_email_send", messageId: m.id, itemResults } });
        const { holdForOwnerReview: hold } = await import("../lib/agent/ai-designer");
        await hold(tx, { orderId, businessId, messageId: m.id, byUserId: null });
        return { proofId: p.id, messageId: m.id };
      });
    }
    void holdForOwnerReview;
    const held = await qcPassHeld(id);
    check("after QC pass the order waits in owner_review", (await state(id)).ai === "owner_review" && (await state(id)).s === "awaiting_approval");
    const [p0] = await q((tx) => tx.select({ sentAt: proofs.sentAt }).from(proofs).where(eq(proofs.id, held.proofId)));
    check("proof email not sent yet", p0.sentAt === null);
    const waiting = (await listOwnerReview(businessId)).find((r) => r.orderId === id);
    check("listOwnerReview shows it with portrait and selfCheck", !!waiting && !!waiting.portraitUrl && !!waiting.selfCheck);
    check("non-admin cannot approve", !(await approveOwnerReview(id, human.id)).ok);
    const appr = await approveOwnerReview(id, admin.id);
    check("owner approval sends the proof email", appr.ok, appr.ok ? "" : appr.message);
    const [p1] = await q((tx) => tx.select({ sentAt: proofs.sentAt }).from(proofs).where(eq(proofs.id, held.proofId)));
    check("proof marked sent, order with buyer", p1.sentAt !== null && (await state(id)).ai === "with_buyer");
    check("approving twice rejected", !(await approveOwnerReview(id, admin.id)).ok);

    // 6. Buyer revision goes back to the jobs queue, not a human board.
    await q(async (tx) => {
      await tx.update(proofs).set({ decision: "revision", decidedAt: new Date(), revisionNotes: "Make the ears bigger please" }).where(eq(proofs.id, held.proofId));
      await runTransition(tx, SYS, { orderId: id, to: "in_design", expectedFrom: "awaiting_approval", metadata: { revisionReason: "Make the ears bigger please" } });
    });
    const st2 = await state(id);
    check("buyer revision queues an AI revision job", st2.s === "in_design" && st2.ai === "revision" && st2.rc === 1);
    const revAct = (await act(id, "ai.revision_queued"))[0];
    check("stage recorded as 'in revision (AI)'", (revAct?.metadata as { stage?: string })?.stage === "in revision (AI)");
    const rj = (await listPendingJobs({ businessId })).find((j) => j.jobId === id);
    check("revision job carries buyer words and prior portrait", rj?.kind === "revision" && rj.revision?.buyerWords === "Make the ears bigger please" && rj.revision.priorPortraitUrl === "https://example.test/portrait-1.png");
    const humanAssign = await q((tx) => tx.select({ d: assignments.designerId }).from(assignments).where(and(eq(assignments.orderId, id), eq(assignments.active, true))));
    check("revision stays with the agent, not a human", humanAssign.length === 1 && humanAssign[0].d === agentId);

    // 7. Claim and deliver again with a base64 file; re-enters VA QC.
    await claimJob(id);
    check("revision claim sets revision_claimed", (await state(id)).ai === "revision_claimed");
    const d2 = await deliverJob(id, { base64: PNG, contentType: "image/png", selfCheck: "Ears enlarged as asked; rest unchanged." });
    const st3 = await state(id);
    check("revision deliver re-enters VA QC", d2.status === "awaiting_qc" && st3.s === "awaiting_qc" && st3.ai === "qc");
    check("base64 stored as a second submission", (await q((tx) => tx.select({ id: assets.id }).from(assets).where(and(eq(assets.orderId, id), eq(assets.type, "submission"))))).length === 2);

    // 8. Owner approval off: nothing to hold.
    const { ownerReviewRequired } = await import("../lib/agent/ai-designer");
    await q((tx) => tx.update(businesses).set({ agentConfig: { ...(originalConfig as object | null), aiOwnerApproval: false } as never }).where(eq(businesses.id, businessId)));
    check("aiOwnerApproval=false: no hold", (await q((tx) => ownerReviewRequired(tx, id, businessId))) === false);
    await q((tx) => tx.update(businesses).set({ agentConfig: originalConfig as never }).where(eq(businesses.id, businessId)));
    check("aiOwnerApproval default: hold required", (await q((tx) => ownerReviewRequired(tx, id, businessId))) === true);

    // 9. Fail path: exception raised, order reassignable.
    const fo = await newOrder("fail", STYLE);
    await q((tx) => runAutoAssign(tx, { orderId: fo, businessId, assignedBy: null }));
    await claimJob(fo);
    check("fail without reason rejected", await rejects(() => failJob(fo, ""), 400));
    const f = await failJob(fo, "Photo too blurry to draw");
    const [ex] = await q((tx) => tx.select({ kind: exceptions.kind, status: exceptions.status }).from(exceptions).where(eq(exceptions.id, f.exceptionId)));
    check("fail raises an exception card", ex?.kind === "ai_designer_failed" && ex.status === "open");
    check("failed job leaves the queue", (await state(fo)).ai === "failed" && !(await listPendingJobs({ businessId })).some((j) => j.jobId === fo));
    const rf = await reassignOrder(fo, human.id, admin.id);
    const stf = await state(fo);
    check("failed order reassigned to a human", rf.ok && stf.ai === null);

    // 10. Reassign away from the agent while queued.
    const ro = await newOrder("reassign", STYLE);
    await q((tx) => runAutoAssign(tx, { orderId: ro, businessId, assignedBy: null }));
    check("queued job present before reassign", (await listPendingJobs({ businessId })).some((j) => j.jobId === ro));
    const rr = await reassignOrder(ro, human.id, admin.id);
    check("reassignOrder ok", rr.ok && rr.changed);
    check("reassigned order leaves the agent queue", !(await listPendingJobs({ businessId })).some((j) => j.jobId === ro) && (await state(ro)).ai === null);
    const ra = (await act(ro, "order.reassigned"))[0];
    check("reassign logged", (ra?.metadata as { designerId?: string })?.designerId === human.id && ra.actorId === admin.id);
    check("agent cannot be claimed once reassigned", await rejects(() => claimJob(ro), 404));
    const back = await reassignOrder(ro, agentId, admin.id);
    check("reassign back to the agent re-queues it", back.ok && (await state(ro)).ai === "queued");
    check("reassign to a stranger rejected", !(await reassignOrder(ro, randomUUID(), admin.id)).ok);

    // 11. HTTP layer: bearer auth, fail-closed, response shapes.
    const { GET } = await import("../app/api/agent-designer/jobs/route");
    const { POST: claimPost } = await import("../app/api/agent-designer/jobs/[id]/claim/route");
    const { POST: deliverPost } = await import("../app/api/agent-designer/jobs/[id]/deliver/route");
    const url = "http://localhost/api/agent-designer/jobs";
    const auth = { authorization: `Bearer ${process.env.AGENT_JOBS_TOKEN}` };
    check("GET without token 401", (await GET(new NextRequest(url))).status === 401);
    check("GET with wrong token 401", (await GET(new NextRequest(url, { headers: { authorization: "Bearer nope" } }))).status === 401);
    const g = await GET(new NextRequest(url, { headers: auth }));
    const gj = (await g.json()) as { jobs: { jobId: string }[] };
    check("GET with token lists jobs", g.status === 200 && gj.jobs.some((j) => j.jobId === ro));
    const params = (i: string) => ({ params: Promise.resolve({ id: i }) });
    const c1 = await claimPost(new NextRequest(`${url}/${ro}/claim`, { method: "POST", headers: auth }), params(ro));
    check("POST claim 200", c1.status === 200);
    const c2 = await claimPost(new NextRequest(`${url}/${ro}/claim`, { method: "POST", headers: auth }), params(ro));
    check("POST claim twice 409", c2.status === 409);
    const dv = await deliverPost(
      new NextRequest(`${url}/${ro}/deliver`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.test/x.png" }) }),
      params(ro),
    );
    check("POST deliver without selfCheck 400", dv.status === 400);
    const dv2 = await deliverPost(
      new NextRequest(`${url}/${ro}/deliver`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.test/x.png", selfCheck: "ok" }) }),
      params(ro),
    );
    const dj = (await dv2.json()) as { ok?: boolean; orderStatus?: string };
    check("POST deliver 200 to awaiting_qc", dv2.status === 200 && dj.orderStatus === "awaiting_qc");
    const saved = process.env.AGENT_JOBS_TOKEN;
    delete process.env.AGENT_JOBS_TOKEN;
    check("token env unset fails closed", (await GET(new NextRequest(url, { headers: auth }))).status === 401);
    process.env.AGENT_JOBS_TOKEN = saved;
  } finally {
    await q(async (tx) => {
      await tx.update(businesses).set({ agentConfig: originalConfig as never }).where(eq(businesses.id, businessId));
      await tx.update(styles).set({ aiDesignerEnabled: true, aiFramework: FRAMEWORK }).where(and(eq(styles.businessId, businessId), sql`lower(${styles.name}) = lower(${STYLE})`));
      const stale = await tx.select({ id: orders.id }).from(orders).where(like(orders.platformOrderId, `${MARK}%`));
      for (const { id } of stale) {
        // activity_log is append-only and keeps its rows; everything else goes.
        for (const t of [exceptions, messages, proofs, assets, assignments, qcChecks, orderItems] as const) {
          await tx.delete(t).where(eq((t as typeof assets).orderId, id));
        }
        await tx.delete(orders).where(eq(orders.id, id));
      }
      await tx.delete(customers).where(like(customers.email, `${MARK}%`));
    });
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
