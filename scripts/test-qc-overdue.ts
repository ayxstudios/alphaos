// Owner QC overdue (lib/agent/qc-overdue.ts, clean slating audit 2026-10-16:
// Ami Multani #CPS10282 and Audrea Sanchez 4196536586 waited 61 h and 64 h for
// the owner's QC, unseen). The pure rules first, then the pass against a
// throwaway business of its own ("QC Overdue Test <stamp>": an owner, a partner
// who really QCs it, a spare admin, one shop), deleted again at the end. Never
// run against production.
import "./load-env";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { runAgentTick } from "../lib/agent/autopilot";
import {
  QC_BACKUP_ACTION,
  QC_OVERDUE_MAX_LINES,
  QC_OVERDUE_SOURCE,
  QC_URGENT_ACTION,
  listQcOverdue,
  pickBackupApprover,
  qcOverdueStage,
  qcOverdueText,
  resolveBackupApprover,
  runQcOverduePass,
  type QcOverdueLine,
} from "../lib/agent/qc-overdue";
import { describeEvent } from "../components/board/card-meta";
import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import { activityLog, alphaEvents, businesses, orderItems, orders, qcClaims, shops, users } from "../lib/db/schema";
import { activityLabel } from "../lib/orders/activity-label";
import { getQcQueueIds } from "../lib/qc/data";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const HOUR = 3_600_000;
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
const later = (hours: number) => new Date(now.getTime() + hours * HOUR);

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

function pureTests() {
  const rule = { slaHours: 12, backupAfterHours: 2, hasBackup: true };
  const w = (enteredHoursAgo: number, urgentHoursAgo: number | null = null, backup = false) => ({
    enteredAt: ago(enteredHoursAgo),
    urgentAt: urgentHoursAgo === null ? null : ago(urgentHoursAgo),
    backupAt: backup ? ago(0.5) : null,
  });
  check("stage: inside the 12 h, nothing", qcOverdueStage(w(11.9), rule, now) === "none");
  check("stage: 12 h waiting = the URGENT", qcOverdueStage(w(12), rule, now) === "urgent");
  check("stage: URGENT sent 1 h ago, wait for the backup", qcOverdueStage(w(13, 1), rule, now) === "none");
  check("stage: URGENT sent 2 h ago, over to the backup", qcOverdueStage(w(14, 2), rule, now) === "backup");
  check("stage: no backup approver, nothing after the URGENT", qcOverdueStage(w(40, 20), { ...rule, hasBackup: false }, now) === "none");
  check("stage: backup already told, nothing more", qcOverdueStage(w(40, 20, true), rule, now) === "none");

  const c = (userId: string, name: string, here: number, all: number) => ({ userId, name, here, all });
  check(
    "backup: the other owner who QCs this business most",
    pickBackupApprover([c("own", "Owner", 50, 90), c("ay", "Ayser", 86, 118), c("gen", "Admin", 2, 2)], "own")?.userId === "ay",
  );
  check("backup: never the owner themself", pickBackupApprover([c("own", "Owner", 50, 90)], "own") === null);
  check(
    "backup: no QC here, the one with QC elsewhere (DT)",
    pickBackupApprover([c("own", "Owner", 0, 64), c("ay", "Ayser", 0, 118), c("gen", "Admin", 0, 2)], "own")?.userId === "ay",
  );
  check("backup: nobody with QC history and two others = nobody (never invent)", pickBackupApprover([c("own", "O", 0, 0), c("a", "A", 0, 0), c("b", "B", 0, 0)], "own") === null);
  check("backup: the one other admin even without history", pickBackupApprover([c("own", "O", 0, 0), c("a", "A", 0, 0)], "own")?.userId === "a");

  const owner = { userId: "own", name: "Yousif" };
  const partner = { userId: "ay", name: "Ayser" };
  const line = (o: Partial<QcOverdueLine>): QcOverdueLine => ({
    orderId: "o1",
    businessId: "b1",
    number: "#CPS10282",
    shop: "CPS",
    kind: "qc",
    urgentOrder: false,
    enteredAt: ago(61),
    urgentAt: null,
    backupAt: null,
    open: false,
    stage: "urgent",
    hours: 61,
    backup: partner,
    backupAfterHours: 2,
    slaHours: 12,
    primary: owner,
    ...o,
  });
  const two = qcOverdueText([
    line({}),
    line({ orderId: "o2", number: "4196536586", hours: 64, urgentOrder: true }),
    line({ orderId: "o3", number: "#CPS10292", kind: "owner_review", hours: 62 }),
  ]);
  const rows = two.split("\n");
  check("text: URGENT first line with the count and the SLA", rows[0] === "*URGENT* 3 portraits waiting for your QC over 12 h", rows[0]);
  check("text: one dot line per order with its /approve link", rows[1].startsWith("• CPS #CPS10282: 61 h. ") && rows[1].endsWith("/approve?o=o1"), rows[1]);
  check("text: a chasing buyer is said", rows[2].includes("the buyer is chasing"), rows[2]);
  check("text: an AI portrait held for the owner links /day", rows[3].includes("AI portrait held for an owner's OK") && rows[3].endsWith("/day"), rows[3]);
  check("text: says who it goes to next and when", rows[4] === "Not checked in 2 h, they go to Ayser.", rows[4]);
  check("text: no em dashes", !two.includes("—"));
  const one = qcOverdueText([line({ stage: "backup" })]).split("\n");
  check("text: the backup's message says whose check it was", one[0] === "*URGENT* 1 portrait still waiting for QC, over to you as backup for Yousif", one[0]);
  check("text: no footer on a backup message", one.length === 2);
  const mixed = qcOverdueText([line({}), line({ orderId: "o2", stage: "backup" })]);
  check(
    "text: urgent and backup lines in one message, each under its own heading",
    mixed.includes("Waiting for your QC over 12 h:") && mixed.includes("Still unchecked, over to you as backup for Yousif:"),
    mixed,
  );
  const noBackup = qcOverdueText([line({ backup: null })]);
  check("text: no backup approver, no promise of one", !noBackup.includes("Not checked in"));
  const many = qcOverdueText(Array.from({ length: QC_OVERDUE_MAX_LINES + 3 }, (_, i) => line({ orderId: `o${i}` })));
  check("text: a long list is cut with a link to the rest", many.includes("+3 more: ") && many.split("\n").filter((l) => l.startsWith("• ")).length === QC_OVERDUE_MAX_LINES);
  check("text: under an hour reads in minutes", qcOverdueText([line({ backupAfterHours: 0.5 })]).includes("Not checked in 30 min, it goes to Ayser."));

  const ev = (action: string) => ({
    id: "e1",
    action,
    actorId: null,
    actorName: null,
    fromState: null,
    toState: null,
    body: null,
    metadata: { toName: "Ayser" },
    createdAt: now.toISOString(),
  });
  check("card: designers never see the QC alarm", describeEvent(ev(QC_URGENT_ACTION), "designer") === null && describeEvent(ev(QC_BACKUP_ACTION), "designer") === null);
  check("card: staff read who was told", describeEvent(ev(QC_URGENT_ACTION), "admin")?.includes("URGENT sent to Ayser") === true);
  check("card: staff read the backup hand-over", describeEvent(ev(QC_BACKUP_ACTION), "va") === "passed QC to Ayser as backup approver");
  check("order page: plain labels", activityLabel(QC_URGENT_ACTION) === "QC overdue: owner alerted" && activityLabel(QC_BACKUP_ACTION) === "QC passed to the backup approver");
}

// ---------------------------------------------------------------------------
// The pass against a throwaway business
// ---------------------------------------------------------------------------

const stamp = Date.now();
const ids = {
  biz: randomUUID(),
  shop: randomUUID(),
  owner: randomUUID(),
  partner: randomUUID(),
  spare: randomUUID(),
  designer: randomUUID(),
};
const people = [ids.owner, ids.partner, ids.spare, ids.designer];

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({
      id: ids.biz,
      name: `QC Overdue Test ${stamp}`,
      slug: `qc-overdue-test-${stamp}`,
      // The to-do lists start a day ago: an order placed a month ago is
      // "before the to-do start", like Ami's and Audrea's.
      agentConfig: { ownerUserId: ids.owner, todoFrom: ago(24).toISOString() },
    });
    await tx.insert(users).values([
      { id: ids.owner, email: `qcoverdue-owner-${stamp}@example.test`, name: "Qc Owner", role: "admin" },
      { id: ids.partner, email: `qcoverdue-partner-${stamp}@example.test`, name: "Qc Partner", role: "admin" },
      { id: ids.spare, email: `qcoverdue-spare-${stamp}@example.test`, name: "Qc Spare", role: "admin" },
      { id: ids.designer, email: `qcoverdue-designer-${stamp}@example.test`, name: "Qc Designer", role: "designer" },
    ]);
    await tx.insert(shops).values({
      id: ids.shop,
      businessId: ids.biz,
      platform: "etsy",
      name: "Qc Etsy",
      externalShopId: `qc-overdue-${stamp}`,
      credentials: {},
    });
  });
}

let orderNo = 0;
async function mkOrder(o: {
  status: typeof orders.$inferInsert.status;
  placedHoursAgo: number;
  aiState?: string | null;
  archived?: boolean;
}): Promise<{ id: string; number: string }> {
  orderNo++;
  const number = `QO${orderNo}`;
  return withSystemContext(async (tx) => {
    const [row] = await tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        platformOrderId: `qcoverdue-${stamp}-${orderNo}`,
        platformOrderName: number,
        status: o.status,
        source: "manual",
        uploadToken: randomUUID(),
        aiState: o.aiState ?? null,
        placedAt: ago(o.placedHoursAgo),
        createdAt: ago(o.placedHoursAgo),
        archivedAt: o.archived ? ago(1) : null,
      })
      .returning({ id: orders.id });
    await tx.insert(orderItems).values({
      businessId: ids.biz,
      orderId: row.id,
      title: "Custom pet portrait",
      figureCount: 1,
      figureCountSource: "manual",
      style: "Watercolor Pets",
      productType: "digital",
    });
    return { id: row.id, number };
  });
}

async function log(orderId: string, at: Date, row: { action: string; from?: string | null; to?: string | null; actorId?: string | null }) {
  await withSystemContext((tx) =>
    tx.insert(activityLog).values({
      businessId: ids.biz,
      orderId,
      actorId: row.actorId ?? null,
      action: row.action,
      fromState: (row.from ?? null) as typeof activityLog.$inferInsert.fromState,
      toState: (row.to ?? null) as typeof activityLog.$inferInsert.toState,
      createdAt: at,
    }),
  );
}

const enteredQc = (orderId: string, at: Date) => log(orderId, at, { action: "order.awaiting_qc", from: "in_design", to: "awaiting_qc" });

const stamps = (orderIds: string[]) =>
  withSystemContext((tx) =>
    tx
      .select({ orderId: activityLog.orderId, action: activityLog.action, metadata: activityLog.metadata })
      .from(activityLog)
      .where(and(inArray(activityLog.orderId, orderIds), inArray(activityLog.action, [QC_URGENT_ACTION, QC_BACKUP_ACTION]))),
  );

const eventsTo = (userId: string) =>
  withSystemContext((tx) =>
    tx
      .select({ id: alphaEvents.id, text: alphaEvents.text, payload: alphaEvents.payload, businessId: alphaEvents.businessId, orderId: alphaEvents.orderId })
      .from(alphaEvents)
      .where(and(eq(alphaEvents.toUserId, userId), sql`${alphaEvents.payload}->>'source' = ${QC_OVERDUE_SOURCE}`)),
  );

const setConfig = (patch: Record<string, unknown>) =>
  withSystemContext(async (tx) => {
    const [b] = await tx.select({ agentConfig: businesses.agentConfig }).from(businesses).where(eq(businesses.id, ids.biz));
    await tx
      .update(businesses)
      .set({ agentConfig: { ...((b?.agentConfig ?? {}) as Record<string, unknown>), ...patch } })
      .where(eq(businesses.id, ids.biz));
  });

async function dbTests() {
  // The partner really QCs this business (five decisions this month); the
  // spare admin never has.
  const hist = await mkOrder({ status: "delivered", placedHoursAgo: 200 });
  for (let i = 0; i < 5; i++) {
    await log(hist.id, ago(48 + i), { action: "order.awaiting_approval", from: "awaiting_qc", to: "awaiting_approval", actorId: ids.partner });
  }

  // A: placed a month ago (before the to-do start), in QC 13 h: Ami's shape.
  const a = await mkOrder({ status: "awaiting_qc", placedHoursAgo: 24 * 30 });
  await enteredQc(a.id, ago(13));
  // B: in QC 5 h, not due.
  const b = await mkOrder({ status: "awaiting_qc", placedHoursAgo: 10 });
  await enteredQc(b.id, ago(5));
  // C: an AI portrait held for the owner 20 h (#CPS10292's shape).
  const c = await mkOrder({ status: "awaiting_approval", placedHoursAgo: 30, aiState: "owner_review" });
  await log(c.id, ago(20), { action: "ai.owner_review_queued" });
  // D: in QC 14 h, but someone has it open on /approve right now.
  const d = await mkOrder({ status: "awaiting_qc", placedHoursAgo: 20 });
  await enteredQc(d.id, ago(14));
  await withSystemContext((tx) => tx.insert(qcClaims).values({ orderId: d.id, userId: ids.spare }));
  // E: in QC 30 h; a details edit an hour ago is not a new wait.
  const e = await mkOrder({ status: "awaiting_qc", placedHoursAgo: 40 });
  await enteredQc(e.id, ago(30));
  await log(e.id, ago(1), { action: "order.details_updated", from: "awaiting_qc", to: "awaiting_qc" });
  // F: archived, never raised.
  const f = await mkOrder({ status: "awaiting_qc", placedHoursAgo: 60, archived: true });
  await enteredQc(f.id, ago(40));

  const queue = await getQcQueueIds({ id: ids.owner, role: "admin" }, ids.biz);
  check("/approve shows QC work placed before the to-do start (Ami, Audrea)", queue.includes(a.id), `${queue.length} in queue`);
  check("/approve still hides archived orders", !queue.includes(f.id));

  const list = await listQcOverdue({ businessIds: [ids.biz], now });
  const byId = new Map(list.map((i) => [i.orderId, i]));
  check("list: the overdue ones, oldest first", list.map((i) => i.orderId).join() === [e.id, c.id, d.id, a.id].join(), list.map((i) => i.orderNumber).join());
  check("list: a details edit does not restart the clock", byId.get(e.id)?.hours === 30, String(byId.get(e.id)?.hours));
  check("list: the held AI portrait links /day", byId.get(c.id)?.kind === "owner_review" && !!byId.get(c.id)?.link.endsWith("/day"));
  check("list: says who has it open", byId.get(d.id)?.open === true && byId.get(a.id)?.open === false);
  check(
    "list: owner and the default backup (the partner who QCs it)",
    byId.get(a.id)?.owner?.userId === ids.owner && byId.get(a.id)?.backup?.userId === ids.partner && byId.get(a.id)?.next === "urgent",
  );
  const all = await listQcOverdue({ businessIds: [ids.biz], now, all: true });
  check("list all: includes the ones not due yet", all.some((i) => i.orderId === b.id && !i.overdue) && !all.some((i) => i.orderId === f.id));

  const dry = await runQcOverduePass({ businessIds: [ids.biz], now, dryRun: true });
  check("dry run: one message, three URGENT lines, the open one left alone", dry.sent === 1 && dry.urgent === 3 && dry.skippedOpen === 1, JSON.stringify({ ...dry, texts: undefined }));
  check("dry run: nothing sent or stamped", (await eventsTo(ids.owner)).length === 0 && (await stamps([a.id, c.id, e.id])).length === 0);

  const first = await runQcOverduePass({ businessIds: [ids.biz], now });
  const toOwner = await eventsTo(ids.owner);
  check("URGENT: one message to the owner", first.sent === 1 && first.urgent === 3 && toOwner.length === 1, JSON.stringify({ ...first, texts: undefined }));
  const msg = toOwner[0]?.text ?? "";
  check("URGENT: first line and every order", msg.startsWith("*URGENT* 3 portraits waiting for your QC over 12 h") && msg.includes(a.number) && msg.includes(e.number));
  check("URGENT: links the order on /approve", msg.includes(`/approve?o=${a.id}`));
  check("URGENT: names the backup and when", msg.includes("Not checked in 2 h, they go to Qc Partner."), msg);
  check("URGENT: the open one is not in it", !msg.includes(d.number));
  const p = (toOwner[0]?.payload ?? {}) as { orderIds?: string[]; urgent?: number };
  check("URGENT: payload lists the orders", p.orderIds?.length === 3 && p.urgent === 3 && toOwner[0]?.businessId === ids.biz);
  const s1 = await stamps([a.id, c.id, e.id]);
  check(
    "URGENT: stamped once on each order, to the owner",
    s1.length === 3 && s1.every((r) => r.action === QC_URGENT_ACTION && (r.metadata as { toUserId?: string })?.toUserId === ids.owner),
  );

  const again = await runQcOverduePass({ businessIds: [ids.biz], now });
  check("once: the next tick sends nothing", again.sent === 0 && (await eventsTo(ids.owner)).length === 1);
  const soon = await runQcOverduePass({ businessIds: [ids.biz], now: later(1) });
  check("backup: not before 2 h", soon.sent === 0 && soon.backup === 0);

  // G comes due right after the owner's message: it waits for the hour.
  const g = await mkOrder({ status: "awaiting_qc", placedHoursAgo: 20 });
  await enteredQc(g.id, ago(12.5));
  const held = await runQcOverduePass({ businessIds: [ids.biz], now });
  check("one message an hour: a new due order waits", held.sent === 0 && held.heldRecent === 1, JSON.stringify({ ...held, texts: undefined }));

  const step2 = await runQcOverduePass({ businessIds: [ids.biz], now: later(3) });
  const toPartner = await eventsTo(ids.partner);
  check("backup: 2 h after the URGENT the three go to the partner", step2.backup === 3 && toPartner.length === 1, JSON.stringify({ ...step2, texts: undefined }));
  check(
    "backup: the partner's message says it is theirs now",
    (toPartner[0]?.text ?? "").startsWith("*URGENT* 3 portraits still waiting for QC, over to you as backup for Qc Owner"),
    toPartner[0]?.text,
  );
  check("backup: G's URGENT goes to the owner in the same tick", step2.urgent === 1 && (await eventsTo(ids.owner)).length === 2);
  const s2 = await stamps([a.id, c.id, e.id]);
  check(
    "backup: stamped to the partner",
    s2.filter((r) => r.action === QC_BACKUP_ACTION && (r.metadata as { toUserId?: string })?.toUserId === ids.partner).length === 3,
  );
  const step3 = await runQcOverduePass({ businessIds: [ids.biz], now: later(3) });
  check("backup: once", step3.sent === 0 && step3.backup === 0);

  // A goes back to design and comes back: a new wait, a new clock.
  await log(a.id, later(4), { action: "order.in_design", from: "awaiting_qc", to: "in_design", actorId: ids.owner });
  await enteredQc(a.id, later(5));
  const fresh = (await listQcOverdue({ businessIds: [ids.biz], now: later(18) })).find((i) => i.orderId === a.id);
  check("a new wait starts clean: the old stamps do not count", fresh?.urgentSentAt === null && fresh?.backupSentAt === null && fresh?.next === "urgent");

  // The setting wins when it names an active admin who is not the owner.
  await setConfig({ qcBackupApproverUserId: ids.spare });
  check("setting: the named admin is the backup", (await listQcOverdue({ businessIds: [ids.biz], now, all: true }))[0]?.backup?.userId === ids.spare);
  await setConfig({ qcBackupApproverUserId: ids.designer });
  check("setting: a designer is never a backup approver", (await listQcOverdue({ businessIds: [ids.biz], now, all: true }))[0]?.backup?.userId === ids.partner);
  await setConfig({ qcBackupApproverUserId: ids.owner });
  check("setting: the owner is never their own backup", (await listQcOverdue({ businessIds: [ids.biz], now, all: true }))[0]?.backup?.userId === ids.partner);
  const noOwner = await withSystemContext((tx) => resolveBackupApprover(tx, ids.biz, { ownerUserId: null, qcBackupApproverUserId: null }, now));
  check("no single owner: every admin had the URGENT, no backup is invented", noOwner === null);

  const tick = await runAgentTick({ businessId: ids.biz, dryRun: true });
  check("tick: the QC overdue pass runs with the agent tick", !!tick.qcOverdue && !tick.qcOverdueError, String(tick.qcOverdueError ?? ""));
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
      await tx.delete(alphaEvents).where(inArray(alphaEvents.toUserId, people));
      await tx.delete(users).where(inArray(users.id, people));
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
  console.log(failed ? `\n${failed} check(s) failed` : "\nall qc-overdue checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
