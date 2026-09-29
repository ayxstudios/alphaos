// Agent inbox pass (phase 2) against the DEMO database (Northlight Portraits),
// under the mock AI. Creates its own synthetic orders, proofs and inbound
// replies (marker "agenttest-inbox-"), archives what a previous run left
// behind, and always restores the business's switches and config at the end.
// Never run against staging or production.
import "./load-env";

import { randomUUID } from "node:crypto";

// The inbox classifies and drafts through the Anthropic road; answer it from
// lib/mock (x-api-key "mock_..."), never a real model.
if (!process.env.ANTHROPIC_API_KEY?.startsWith("mock_")) process.env.ANTHROPIC_API_KEY = "mock_sk-ant-agenttest";

import { and, eq, inArray, like, or, sql } from "drizzle-orm";

import { runAgentTick } from "../lib/agent/autopilot";
import { withSystemContext } from "../lib/db";
import {
  activityLog,
  businesses,
  customers,
  exceptions,
  messages,
  orderItems,
  orders,
  proofs,
  shops,
} from "../lib/db/schema";
import { installMockTransport } from "../lib/mock/transport";
import { generateProofToken } from "../lib/proofs/tokens";

const BUSINESS_NAME = "Northlight Portraits";
const MARK = "agenttest-inbox-";
const HOUR = 60 * 60 * 1000;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

type Snapshot = { messages: string; exceptions: string; activity: number; proofs: number; statuses: string };

// Only rows the inbox pass can write are fingerprinted, so another worker
// sharing the demo database (print jobs moving orders to shipped, their emails)
// does not read as a dry-run write.
async function snapshot(businessId: string): Promise<Snapshot> {
  return withSystemContext(async (tx) => {
    const count = sql<number>`count(*)::int`;
    const n = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
    const st = await tx
      .select({ status: orders.status, n: count })
      .from(orders)
      .where(and(eq(orders.businessId, businessId), inArray(orders.status, ["awaiting_approval", "approved", "in_design"])))
      .groupBy(orders.status)
      .orderBy(orders.status);
    // Inbound replies (metadata is part of the fingerprint: persisting a
    // classification is a write) plus the drafts the agent can create.
    const agentMessages = or(
      eq(messages.direction, "inbound"),
      eq(messages.templateKey, "proof_reminder"),
      sql`${messages.metadata}->>'agentDrafted' = 'true'`,
    );
    const [m] = await tx
      .select({ v: sql<string>`count(*)::text || ':' || md5(coalesce(string_agg(${messages.id} || ${messages.status} || coalesce(${messages.metadata}::text, ''), ',' order by ${messages.id}), ''))` })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), agentMessages));
    const [e] = await tx
      .select({ v: sql<string>`count(*)::text || ':' || md5(coalesce(string_agg(${exceptions.id} || ${exceptions.status} || ${exceptions.detail}::text, ',' order by ${exceptions.id}), ''))` })
      .from(exceptions)
      .where(eq(exceptions.businessId, businessId));
    const agentActivity = or(
      like(activityLog.action, "agent.%"),
      like(activityLog.action, "message.reply_%"),
      sql`${activityLog.metadata}->>'via' = 'agent_inbox'`,
    );
    return {
      messages: m?.v ?? "",
      exceptions: e?.v ?? "",
      activity: await n(
        tx.select({ n: count }).from(activityLog).where(and(eq(activityLog.businessId, businessId), agentActivity)),
      ),
      proofs: await n(tx.select({ n: count }).from(proofs).where(eq(proofs.businessId, businessId))),
      statuses: st.map((s) => `${s.status}:${s.n}`).join(","),
    };
  });
}

const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  installMockTransport();
  const [biz] = await withSystemContext((tx) =>
    tx
      .select({
        id: businesses.id,
        intake: businesses.agentIntakeEnabled,
        assign: businesses.agentAssignEnabled,
        inbox: businesses.agentInboxEnabled,
        config: businesses.agentConfig,
        autoSend: businesses.stageEmailAutoSend,
      })
      .from(businesses)
      .where(eq(businesses.name, BUSINESS_NAME)),
  );
  if (!biz) throw new Error(`demo business ${BUSINESS_NAME} not found: is .env.local the DEMO database?`);
  const businessId = biz.id;
  const [shop] = await withSystemContext((tx) =>
    tx.select({ id: shops.id }).from(shops).where(eq(shops.businessId, businessId)).limit(1),
  );
  if (!shop) throw new Error("demo business has no shop");

  try {
    // ---- setup -------------------------------------------------------------
    const stamp = Date.now().toString(36);
    const now = new Date();
    const ids = await withSystemContext(async (tx) => {
      // Leftovers from an earlier run leave the live set (archived, not deleted).
      await tx
        .update(orders)
        .set({ archivedAt: now, archiveReason: "agent inbox test leftover" })
        .where(and(eq(orders.businessId, businessId), like(orders.platformOrderId, `${MARK}%`), sql`${orders.archivedAt} is null`));
      await tx
        .update(messages)
        .set({ archivedAt: now })
        .where(and(eq(messages.businessId, businessId), like(messages.subject, `%${MARK}%`), sql`${messages.archivedAt} is null`));
      await tx
        .update(exceptions)
        .set({ status: "resolved", resolvedAt: now, resolutionNote: "agent inbox test leftover" })
        .where(
          and(
            eq(exceptions.businessId, businessId),
            eq(exceptions.status, "open"),
            sql`(${exceptions.summary} like ${"%" + MARK + "%"} or ${exceptions.orderId} in (select id from ${orders} where ${orders.platformOrderId} like ${MARK + "%"}))`,
          ),
        );

      const email = `${MARK}${stamp}@example.test`;
      const [cust] = await tx
        .insert(customers)
        .values({ businessId, email, firstName: "Inbox", lastName: "Test" })
        .returning({ id: customers.id });

      async function order(tag: string, proofAgeHours: number) {
        const name = `${MARK}${tag}-${stamp}`;
        const [o] = await tx
          .insert(orders)
          .values({
            businessId,
            shopId: shop.id,
            customerId: cust.id,
            platformOrderId: name,
            platformOrderName: name,
            status: "awaiting_approval",
            source: "manual",
            uploadToken: randomUUID(),
          })
          .returning({ id: orders.id });
        await tx.insert(orderItems).values({
          businessId,
          orderId: o.id,
          title: "Custom pet portrait",
          figureCount: 1,
          figureCountSource: "manual",
          productType: "digital",
        });
        const at = new Date(now.getTime() - proofAgeHours * HOUR);
        await tx.insert(proofs).values({ businessId, orderId: o.id, token: generateProofToken(), sentAt: at, createdAt: at });
        return { id: o.id, name };
      }

      async function inbound(o: { id: string; name: string } | null, text: string, from = email) {
        const [m] = await tx
          .insert(messages)
          .values({
            businessId,
            orderId: o?.id ?? null,
            customerId: o ? cust.id : null,
            direction: "inbound",
            channel: "email",
            status: "received",
            subject: o ? `Re: Your proof for ${o.name}` : `${MARK}${stamp} a photo question`,
            address: from,
            body: text,
            gmailThreadId: `${MARK}thread-${randomUUID()}`,
          })
          .returning({ id: messages.id });
        return m.id;
      }

      const approval = await order("approve", 2);
      const revision = await order("revise", 2);
      const question = await order("question", 2);
      const unclear = await order("unclear", 2);
      const stale = await order("stale", 80);
      return {
        approval,
        revision,
        question,
        unclear,
        stale,
        msg: {
          approval: await inbound(approval, "Love it, approved, please print"),
          revision: await inbound(revision, "Please make the dog's ears darker and remove the date"),
          question: await inbound(question, "Can I change the size to 16x20?"),
          unclear: await inbound(unclear, "ok"),
          unmatched: await inbound(
            null,
            "Hi, I sent my photos last week and have not heard anything yet. Did they arrive?",
            `${MARK}stranger-${stamp}@example.test`,
          ),
        },
      };
    });

    // Inbox on, everything else off; scope the pass to replies from this run
    // (inboxEnabledAt), and keep stage emails as drafts so nothing queues to send.
    await withSystemContext((tx) =>
      tx
        .update(businesses)
        .set({
          agentIntakeEnabled: false,
          agentAssignEnabled: false,
          agentInboxEnabled: true,
          stageEmailAutoSend: false,
          agentConfig: { ...(biz.config ?? {}), autoSendReplies: false, inboxEnabledAt: new Date(now.getTime() - 60_000).toISOString() },
        })
        .where(eq(businesses.id, businessId)),
    );
    console.log(`setup: 5 synthetic orders and 5 inbound replies (${MARK}*-${stamp})`);

    // ---- dry run -----------------------------------------------------------
    const before = await snapshot(businessId);
    const dry = await runAgentTick({ dryRun: true, businessId });
    const afterDry = await snapshot(businessId);
    const dryBiz = dry.businesses[0];
    check("dry run: report has the business with inbox on", dry.dryRun && dryBiz?.businessId === businessId && dryBiz.inboxEnabled);
    check("dry run: nothing written", same(before, afterDry), JSON.stringify({ before, afterDry }));
    check(
      "dry run: would apply 1 approval and 1 revision",
      dryBiz?.inbox.approvalsApplied === 1 && dryBiz?.inbox.revisionsApplied === 1,
      JSON.stringify(dryBiz?.inbox),
    );
    check("dry run: would draft a reminder", (dryBiz?.inbox.remindersDrafted ?? 0) >= 1, JSON.stringify(dryBiz?.inbox));
    check("dry run: no errors", (dryBiz?.errors.length ?? 1) === 0, JSON.stringify(dryBiz?.errors));

    // ---- real tick ---------------------------------------------------------
    const real = await runAgentTick({ businessId });
    const r = real.businesses[0];
    console.log("real tick inbox:", JSON.stringify(r?.inbox), "exceptions:", r?.exceptionsOpened, JSON.stringify(r?.exceptionKinds));
    check("real tick: no errors", (r?.errors.length ?? 1) === 0, JSON.stringify(r?.errors));

    const result = await withSystemContext(async (tx) => {
      const status = async (id: string) =>
        (await tx.select({ s: orders.status }).from(orders).where(eq(orders.id, id)))[0]?.s;
      const act = (orderId: string | null, action: string, messageId: string) =>
        tx
          .select({ id: activityLog.id, metadata: activityLog.metadata })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.businessId, businessId),
              orderId ? eq(activityLog.orderId, orderId) : sql`${activityLog.orderId} is null`,
              eq(activityLog.action, action),
              sql`${activityLog.metadata}->>'messageId' = ${messageId}`,
            ),
          );
      const openEx = (orderId: string, kind: string) =>
        tx
          .select({ id: exceptions.id, detail: exceptions.detail })
          .from(exceptions)
          .where(and(eq(exceptions.orderId, orderId), eq(exceptions.kind, kind), eq(exceptions.status, "open")));
      const revisionRows = await tx
        .select({ reason: sql<string>`${activityLog.metadata}->>'revisionReason'` })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, ids.revision.id), eq(activityLog.action, "order.in_design")));
      const drafts = await tx
        .select({ id: messages.id, status: messages.status, thread: messages.gmailThreadId, body: messages.body })
        .from(messages)
        .where(
          and(
            eq(messages.orderId, ids.question.id),
            eq(messages.direction, "outbound"),
            sql`${messages.metadata}->>'replyToMessageId' = ${ids.msg.question}`,
          ),
        );
      const [qIn] = await tx
        .select({ thread: messages.gmailThreadId, metadata: messages.metadata })
        .from(messages)
        .where(eq(messages.id, ids.msg.question));
      const reminders = await tx
        .select({ id: messages.id, status: messages.status })
        .from(messages)
        .where(and(eq(messages.orderId, ids.stale.id), eq(messages.templateKey, "proof_reminder")));
      const unmatched = await tx
        .select({ id: exceptions.id, detail: exceptions.detail })
        .from(exceptions)
        .where(
          and(
            eq(exceptions.businessId, businessId),
            eq(exceptions.kind, "unmatched_reply"),
            sql`${exceptions.detail}->>'messageId' = ${ids.msg.unmatched}`,
          ),
        );
      return {
        approvalStatus: await status(ids.approval.id),
        revisionStatus: await status(ids.revision.id),
        questionStatus: await status(ids.question.id),
        unclearStatus: await status(ids.unclear.id),
        applied: [
          ...(await act(ids.approval.id, "agent.reply_applied", ids.msg.approval)),
          ...(await act(ids.revision.id, "agent.reply_applied", ids.msg.revision)),
        ],
        revisionReasons: revisionRows.map((x) => x.reason),
        drafts,
        questionThread: qIn?.thread,
        questionClass: (qIn?.metadata as { replyClassification?: { intent?: string } } | null)?.replyClassification?.intent,
        questionDraftLog: await act(ids.question.id, "agent.reply_answer_drafted", ids.msg.question),
        buyerQuestion: await openEx(ids.question.id, "buyer_question"),
        unclear: await openEx(ids.unclear.id, "reply_unclear"),
        unclearLog: await act(ids.unclear.id, "agent.reply_escalated", ids.msg.unclear),
        unmatched,
        unmatchedLog: await act(null, "agent.reply_escalated", ids.msg.unmatched),
        reminders,
        reminderLog: await tx
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(and(eq(activityLog.orderId, ids.stale.id), eq(activityLog.action, "agent.proof_reminder_drafted"))),
      };
    });

    check("approval: order approved", result.approvalStatus === "approved", String(result.approvalStatus));
    check("revision: order back in design", result.revisionStatus === "in_design", String(result.revisionStatus));
    check(
      "revision: reason carries the buyer's words",
      result.revisionReasons.some((x) => x?.includes("ears darker") && x.includes("remove the date")),
      JSON.stringify(result.revisionReasons),
    );
    check("approval + revision: two agent.reply_applied rows", result.applied.length === 2, String(result.applied.length));
    check("question: classified as a question", result.questionClass === "question", String(result.questionClass));
    const questionPath = result.drafts.length ? "draft" : result.buyerQuestion.length ? "exception" : "none";
    check(
      `question: exactly one draft or one buyer_question exception (path: ${questionPath})`,
      result.drafts.length + result.buyerQuestion.length === 1,
      JSON.stringify({ drafts: result.drafts.length, exceptions: result.buyerQuestion.length }),
    );
    if (questionPath === "draft") {
      const d = result.drafts[0]!;
      check("question: draft is a draft on the inbound thread", d.status === "draft" && d.thread === result.questionThread, JSON.stringify(d));
      check("question: agent.reply_answer_drafted logged", result.questionDraftLog.length === 1);
    }
    check("question: order untouched", result.questionStatus === "awaiting_approval", String(result.questionStatus));
    const ux = result.unclear[0]?.detail as { suggested?: unknown; excerpt?: unknown; classifier?: { intent?: string } } | undefined;
    check("unclear: one reply_unclear exception", result.unclear.length === 1, String(result.unclear.length));
    check(
      "unclear: suggested filled, excerpt and classifier kept",
      typeof ux?.suggested === "string" && ux.suggested.length > 0 && ux.excerpt === "ok" && ux.classifier?.intent === "unclear",
      JSON.stringify(ux),
    );
    check("unclear: agent.reply_escalated logged, order untouched", result.unclearLog.length === 1 && result.unclearStatus === "awaiting_approval");
    check("unmatched: one unmatched_reply exception", result.unmatched.length === 1, String(result.unmatched.length));
    check("unmatched: agent.reply_escalated logged", result.unmatchedLog.length === 1, String(result.unmatchedLog.length));
    check(
      "stale: one proof_reminder draft",
      result.reminders.length === 1 && result.reminders[0]!.status === "draft" && result.reminderLog.length === 1,
      JSON.stringify(result.reminders),
    );

    // ---- second tick: nothing left to do -----------------------------------
    const beforeSecond = await snapshot(businessId);
    const second = await runAgentTick({ businessId });
    const afterSecond = await snapshot(businessId);
    const s = second.businesses[0];
    check("second tick: no writes", same(beforeSecond, afterSecond), JSON.stringify({ beforeSecond, afterSecond }));
    check(
      "second tick: nothing handled",
      !!s &&
        s.inbox.repliesChecked === 0 &&
        s.inbox.unmatchedEscalated === 0 &&
        s.inbox.remindersDrafted === 0 &&
        s.exceptionsOpened === 0 &&
        s.errors.length === 0,
      JSON.stringify(s?.inbox),
    );


    // ---- auto-send: on / off, sensitive hold, retry then exception ---------
    const setAuto = (on: boolean) =>
      withSystemContext((tx) =>
        tx
          .update(businesses)
          .set({ agentConfig: { ...(biz.config ?? {}), autoSendReplies: on, inboxEnabledAt: new Date(now.getTime() - 60_000).toISOString() } })
          .where(eq(businesses.id, businessId)),
      );
    const mkOut = (o: { id: string } | null, subject: string, status: "draft" | "failed", meta: Record<string, unknown>, address: string | null = `${MARK}${stamp}@example.test`) =>
      withSystemContext(async (tx) => {
        const [m] = await tx
          .insert(messages)
          .values({
            businessId,
            orderId: o?.id ?? null,
            direction: "outbound",
            channel: "email",
            status,
            subject: `${MARK}${stamp} ${subject}`,
            address,
            body: "Hello, this is a test reply.",
            metadata: meta,
          })
          .returning({ id: messages.id });
        return m.id;
      });
    const getMsg = async (id: string) =>
      (await withSystemContext((tx) => tx.select({ status: messages.status, metadata: messages.metadata }).from(messages).where(eq(messages.id, id))))[0];
    const failedEx = async (id: string) =>
      withSystemContext((tx) =>
        tx
          .select({ id: exceptions.id })
          .from(exceptions)
          .where(and(eq(exceptions.businessId, businessId), eq(exceptions.kind, "email_send_failed"), eq(exceptions.status, "open"), sql`${exceptions.detail}->>'messageId' = ${id}`)),
      );

    const draftOff = await mkOut(ids.unclear, "answer off", "draft", { agentDrafted: "true", replyToMessageId: ids.msg.question });
    await setAuto(false);
    await runAgentTick({ businessId });
    check("auto-send off: agent draft stays a draft", (await getMsg(draftOff))?.status === "draft");

    const sensitiveIn = await withSystemContext(async (tx) => {
      const [m] = await tx
        .insert(messages)
        .values({ businessId, orderId: ids.question.id, direction: "inbound", channel: "email", status: "received", subject: `${MARK}${stamp} refund`, address: `${MARK}${stamp}@example.test`, body: "I want a refund please", gmailThreadId: `${MARK}thread-${randomUUID()}` })
        .returning({ id: messages.id });
      return m.id;
    });
    const draftSensitive = await mkOut(ids.question, "answer refund", "draft", { agentDrafted: "true", replyToMessageId: sensitiveIn });
    const draftOn = draftOff;
    const exhausted = await mkOut(ids.unclear, "exhausted", "failed", { sendRetry: { attempts: 3, nextAt: null } });
    const backing = await mkOut(ids.unclear, "backing off", "failed", { sendRetry: { attempts: 1, nextAt: new Date(Date.now() + 6 * HOUR).toISOString() } });
    const noAddress = await mkOut(ids.stale, "no address", "failed", { sendRetry: { attempts: 0, nextAt: null } }, null);
    await withSystemContext((tx) => tx.update(messages).set({ error: "No recipient address" }).where(eq(messages.id, noAddress)));

    await setAuto(true);
    const on = await runAgentTick({ businessId });
    const draftOnAfter = await getMsg(draftOn);
    check(
      "auto-send on: agent draft goes out and is marked auto-sent",
      draftOnAfter?.status === "sent" && (draftOnAfter.metadata as { autoSent?: unknown } | null)?.autoSent === true,
      JSON.stringify(draftOnAfter),
    );
    check("auto-send on: refund question stays a draft for a human", (await getMsg(draftSensitive))?.status === "draft");
    check("retry: exhausted email opens an 'Email failed to send' exception", (await failedEx(exhausted)).length === 1);
    check("retry: email with no address opens the exception straight away", (await failedEx(noAddress)).length === 1);
    check("retry: email still backing off is left alone", (await failedEx(backing)).length === 0 && (await getMsg(backing))?.status === "failed");
    check("auto-send on: no errors", (on.businesses[0]?.errors.length ?? 1) === 0, JSON.stringify(on.businesses[0]?.errors));

    await runAgentTick({ businessId });
    check("retry: a second tick does not open a duplicate exception", (await failedEx(exhausted)).length === 1);

    console.log(`questionPath=${questionPath}`);
  } finally {
    await withSystemContext((tx) =>
      tx
        .update(businesses)
        .set({
          agentIntakeEnabled: biz.intake,
          agentAssignEnabled: biz.assign,
          agentInboxEnabled: false,
          stageEmailAutoSend: biz.autoSend,
          agentConfig: biz.config ?? {},
        })
        .where(eq(businesses.id, businessId)),
    );
    const [after] = await withSystemContext((tx) =>
      tx.select({ inbox: businesses.agentInboxEnabled }).from(businesses).where(eq(businesses.id, businessId)),
    );
    check("inbox flag reset to false", after?.inbox === false);
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall agent inbox checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
