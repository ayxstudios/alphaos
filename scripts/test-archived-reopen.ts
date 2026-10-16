// Archived is not done (clean slating audit 2026-10-16, deck item 5): 86
// archived orders were still owed (PixArt 66, CPS 20) and sat outside every
// check; Nancy Lane PC32186 asked "has my order shipped?" after hers was
// archived. Buyer words reopen an archived, still-owed order (inline on the
// Gmail email and Etsy message paths, plus a tick catch-all), never marking it
// urgent or writing to the buyer; the census and the Alpha APIs count the rest.
// Runs against a throwaway business of its own ("Archived Reopen Test <stamp>"),
// deleted at the end. Never run against production.
import "./load-env";

process.env.ANTHROPIC_API_KEY = "";
process.env.ALPHA_HOOK_URL = "";
process.env.ALPHA_HOOK_SECRET = "archived-reopen-test-secret";

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { NextRequest } from "next/server";
import ws from "ws";

import { GET as archivedOpenGET } from "../app/api/alpha/archived-open/route";
import { GET as orderGET } from "../app/api/alpha/order/[id]/route";
import { GET as rundownGET } from "../app/api/alpha/rundown/route";
import { runAgentTick } from "../lib/agent/autopilot";
import { getLimboCensus } from "../lib/agent/limbo";
import { withSystemContext } from "../lib/db";
import * as schema from "../lib/db/schema";
import { activityLog, alphaEvents, businesses, customers, messages, orders, shops, users } from "../lib/db/schema";
import { processHistoryMessages } from "../lib/integrations/gmail/inbound";
import type { GmailMessage } from "../lib/integrations/gmail/types";
import { isSettledArchiveReason } from "../lib/orders/archive";
import { reopenArchivedWithBuyerWords } from "../lib/orders/reopen";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const HOUR = 3_600_000;
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);
const SWEEP = "Archived pre 2026-10-03 per Yousif 2026-10-04 (do orders from now on only)";

const stamp = Date.now();
const receipt = String(4_100_000_000 + (stamp % 90_000_000));
const ids = { biz: randomUUID(), shop: randomUUID(), cust: randomUUID(), va: randomUUID() };
const people = [ids.va];

function mail(id: string, from: string, subject: string, body: string): GmailMessage {
  return {
    id,
    threadId: `thread-${id}-${stamp}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: "orders@example.com" },
        { name: "Subject", value: subject },
        { name: "Message-ID", value: `<${id}-${stamp}@example.com>` },
      ],
      body: { data: Buffer.from(body).toString("base64url"), size: body.length },
    },
  };
}

async function setup() {
  await withSystemContext(async (tx) => {
    await tx.insert(businesses).values({ id: ids.biz, name: `Archived Reopen Test ${stamp}`, slug: `archived-reopen-test-${stamp}` });
    await tx.insert(users).values({ id: ids.va, email: `artest-va-${stamp}@example.test`, name: "AR VA", role: "va" });
    await tx.insert(shops).values({ id: ids.shop, businessId: ids.biz, platform: "etsy", name: "AR Shop", externalShopId: `ar-${stamp}`, credentials: {} });
    await tx.insert(customers).values({ id: ids.cust, businessId: ids.biz, email: `ar-customer-${stamp}@example.test`, firstName: "Nancy" });
  });
}

let n = 0;
async function order(o: {
  number?: string;
  status?: typeof orders.$inferInsert.status;
  source?: typeof orders.$inferInsert.source;
  archived?: boolean;
  reason?: string | null;
  archivedHoursAgo?: number;
  dueInHours?: number;
}) {
  n++;
  // Etsy-style receipt numbers, so a reply subject links the way real mail does.
  const number = o.number ?? String(4_300_000_000 + (stamp % 9_000_000) * 10 + n);
  const [row] = await withSystemContext((tx) =>
    tx
      .insert(orders)
      .values({
        businessId: ids.biz,
        shopId: ids.shop,
        customerId: ids.cust,
        platformOrderId: number,
        platformOrderName: number,
        status: o.status ?? "ready_to_assign",
        source: o.source ?? "etsy",
        uploadToken: randomUUID(),
        dueAt: new Date(now.getTime() + (o.dueInHours ?? 48) * HOUR),
        placedAt: ago(400),
        createdAt: ago(400),
        ...(o.archived === false ? {} : { archivedAt: ago(o.archivedHoursAgo ?? 100), archiveReason: o.reason === undefined ? SWEEP : o.reason }),
      })
      .returning({ id: orders.id }),
  );
  return { id: row.id, number };
}

const state = (orderId: string) =>
  withSystemContext(async (tx) => {
    const [o] = await tx
      .select({ archivedAt: orders.archivedAt, archiveReason: orders.archiveReason, urgentAt: orders.urgentAt })
      .from(orders)
      .where(eq(orders.id, orderId));
    return o;
  });

const reopenRows = (orderId: string) =>
  withSystemContext((tx) =>
    tx.select({ metadata: activityLog.metadata }).from(activityLog).where(and(eq(activityLog.orderId, orderId), eq(activityLog.action, "order.reopened_by_buyer"))),
  );

async function buyerWords(orderId: string, hoursAgo: number, channel: "email" | "etsy" = "email", kind = "message") {
  await withSystemContext((tx) =>
    tx.insert(messages).values({
      businessId: ids.biz,
      orderId,
      customerId: ids.cust,
      direction: "inbound",
      channel,
      status: "received",
      subject: "Re: my order",
      body: "Any news on my portrait?",
      createdAt: ago(hoursAgo),
      ...(channel === "etsy" ? { metadata: { kind } } : {}),
    }),
  );
}

async function dbTests() {
  check("settled reasons: duplicate, not needed, ignore", isSettledArchiveReason("Duplicate placeholder: the real order 1 was delivered") && isSettledArchiveReason("Not needed: the Etsy order no longer exists.") && isSettledArchiveReason("Yousif 2026-10-14: ignore this order. Archived so the hourly check stops raising it."));
  check("sweep, cutoff, revive-if-writes and null reasons are not settled", !isSettledArchiveReason(SWEEP) && !isSettledArchiveReason("Imported before shop backfill cutoff") && !isSettledArchiveReason("Revive if the buyer writes or sends photos.") && !isSettledArchiveReason(null));

  const emailed = await order({});
  const etsyMsg = await order({ number: receipt });
  const legacy = await order({ status: "awaiting_photos", source: "trello" });
  const delivered = await order({ status: "delivered" });
  const duplicate = await order({ reason: "Duplicate placeholder: the real order 4190816309 was delivered on 12 Oct." });
  const linked = await order({});
  const wroteBefore = await order({});
  const saleNotice = await order({ status: "in_design" });
  const overdue = await order({ dueInHours: -30 });
  const live = await order({ archived: false });

  // ---- inline: the Gmail poll attaches buyer mail ---------------------------
  const inbox: Record<string, GmailMessage> = {
    emailed: mail("emailed", "Nancy Lane <nancy@example.com>", `Re: ${emailed.number} - Portrait Is Ready!`, "Hi, has my order shipped?"),
    legacy: mail("legacy", "Nancy Lane <nancy@example.com>", `Re: ${legacy.number}`, "Did you get my photos?"),
    delivered: mail("delivered", "Nancy Lane <nancy@example.com>", `Re: ${delivered.number}`, "Thank you, love it!"),
    duplicate: mail("duplicate", "Nancy Lane <nancy@example.com>", `Re: ${duplicate.number}`, "Hello again"),
    live: mail("live", "Nancy Lane <nancy@example.com>", `Re: ${live.number}`, "Hi there"),
    etsy: mail(
      "etsy",
      "Etsy <transaction@etsy.com>",
      "You have a new message from nancy_lane",
      `You have a new message about Order #${receipt}.\n\nnancy_lane wrote:\n"Any update on my portrait?"\n\nReply on Etsy: https://www.etsy.com/your/conversations/1\n\n--\nThis email was sent by Etsy, Inc.`,
    ),
  };
  const summary = await processHistoryMessages({
    client: { async getMessage(id: string) { return inbox[id]; } },
    businessId: ids.biz,
    selfAddress: "orders@example.com",
    historyMessages: Object.keys(inbox).map((id) => ({ id, threadId: inbox[id].threadId!, labelIds: ["INBOX"] })),
  });
  check("all six mails attached", summary.attached === 6, JSON.stringify(summary));

  const e = await state(emailed.id);
  check("email: archived, owed order reopened", e.archivedAt === null && e.archiveReason === null);
  const eRows = await reopenRows(emailed.id);
  const eMeta = eRows[0]?.metadata as { via?: string; archiveReason?: string; messageId?: string } | undefined;
  check("email: one timeline row with the old reason and the message", eRows.length === 1 && eMeta?.via === "email" && eMeta?.archiveReason === SWEEP && !!eMeta?.messageId, JSON.stringify(eRows));
  check("email: not marked urgent", e.urgentAt === null);

  const t = await state(etsyMsg.id);
  check("etsy conversation message: reopened", t.archivedAt === null);
  check("etsy: timeline says etsy", ((await reopenRows(etsyMsg.id))[0]?.metadata as { via?: string } | undefined)?.via === "etsy");

  const l = await state(legacy.id);
  check("legacy (Trello) order: reopened but not urgent", l.archivedAt === null && l.urgentAt === null);
  check("delivered order: stays archived", (await state(delivered.id)).archivedAt !== null);
  check("settled duplicate: stays archived", (await state(duplicate.id)).archivedAt !== null && (await reopenRows(duplicate.id)).length === 0);
  check("live order: no reopen row", (await reopenRows(live.id)).length === 0);

  // ---- tick catch-all: words that came some other way ------------------------
  await buyerWords(linked.id, 2); // a VA linked her mail by hand after the archive
  await buyerWords(wroteBefore.id, 150); // she wrote, then someone archived it
  await buyerWords(saleNotice.id, 2, "etsy", "sale"); // an Etsy sale notice is not her words

  const dry = await reopenArchivedWithBuyerWords(ids.biz, { dryRun: true });
  check("sweep dry run: finds the linked order and the settled duplicate", dry.found === 2 && dry.keptSettled === 1 && dry.reopened.length === 1 && dry.reopened[0].id === linked.id, JSON.stringify(dry));
  check("sweep dry run: nothing changed", (await state(linked.id)).archivedAt !== null);

  const outboundBefore = await withSystemContext(async (tx) => {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(messages).where(and(eq(messages.businessId, ids.biz), eq(messages.direction, "outbound")));
    return Number(r.n);
  });
  const tick = await runAgentTick({ businessId: ids.biz, now });
  const biz = tick.businesses.find((b) => b.businessId === ids.biz);
  check("tick: reports one reopened", biz?.noLimbo?.reopenedByBuyer === 1, JSON.stringify(biz?.noLimbo?.reopenedByBuyer));
  const lk = await state(linked.id);
  check("tick: linked order reopened, not urgent", lk.archivedAt === null && lk.urgentAt === null);
  const tickMeta = (await reopenRows(linked.id))[0]?.metadata as { via?: string; messageId?: string | null } | undefined;
  check("tick: timeline says tick and names her message", tickMeta?.via === "tick" && !!tickMeta?.messageId, JSON.stringify(tickMeta));
  check("words before the archive: stays archived", (await state(wroteBefore.id)).archivedAt !== null);
  check("sale notice: stays archived", (await state(saleNotice.id)).archivedAt !== null);
  const outboundAfter = await withSystemContext(async (tx) => {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(messages).where(and(eq(messages.businessId, ids.biz), eq(messages.direction, "outbound")));
    return Number(r.n);
  });
  check("no mail to any buyer from reopening", outboundAfter === outboundBefore, `${outboundBefore} -> ${outboundAfter}`);
  const again = await reopenArchivedWithBuyerWords(ids.biz);
  check("second sweep: only the settled one is left", again.reopened.length === 0 && again.keptSettled === 1);

  // ---- visibility: census and the Alpha APIs ---------------------------------
  // Still archived and owed: duplicate (settled), wroteBefore, saleNotice, overdue.
  const census = await getLimboCensus(ids.biz, { now });
  check("census: four archived but still owed", census.archivedUnfinished === 4, String(census.archivedUnfinished));
  check("census: delivered one not counted", !census.archivedUnfinishedOrders.some((o) => o.id === delivered.id));
  check("census: the duplicate shows the buyer wrote", census.archivedUnfinishedOrders.find((o) => o.id === duplicate.id)?.buyerWroteSinceArchive === true, JSON.stringify(census.archivedUnfinishedOrders));
  check("census: overdue one listed first", census.archivedUnfinishedOrders[0]?.id === overdue.id);

  const auth = { "x-alpha-secret": process.env.ALPHA_HOOK_SECRET! };
  const base = "http://localhost/api/alpha";
  check("archived-open: 401 without the secret", (await archivedOpenGET(new NextRequest(`${base}/archived-open`))).status === 401);
  const ao = await archivedOpenGET(new NextRequest(`${base}/archived-open?business=${ids.biz}`, { headers: auth }));
  const aj = (await ao.json()) as {
    total: number;
    overdue: number;
    buyerWroteSinceArchive: number;
    orders: { id: string; settled: boolean; overdue: boolean; buyerWroteSinceArchive: boolean; archiveReason: string | null }[];
  };
  check("archived-open: four, one overdue, one with buyer words", ao.status === 200 && aj.total === 4 && aj.overdue === 1 && aj.buyerWroteSinceArchive === 1, JSON.stringify({ total: aj.total, overdue: aj.overdue, w: aj.buyerWroteSinceArchive }));
  check("archived-open: the duplicate is flagged settled", aj.orders.find((o) => o.id === duplicate.id)?.settled === true);
  check("archived-open: no customer data", !JSON.stringify(aj).includes("example.test") && !JSON.stringify(aj).includes("Nancy"));

  const rd = (await (await rundownGET(new NextRequest(`${base}/rundown`, { headers: auth }))).json()) as {
    archivedUnfinished: { businessId: string; status: string; n: number }[];
    archivedUnfinishedOverdue: { businessId: string; n: number }[];
    overdue: { businessId: string; n: number }[];
  };
  const mine = rd.archivedUnfinished.filter((r) => r.businessId === ids.biz).reduce((s, r) => s + Number(r.n), 0);
  check("rundown: archived-unfinished counted for the business", mine === 4, String(mine));
  check("rundown: archived overdue counted apart", Number(rd.archivedUnfinishedOverdue.find((r) => r.businessId === ids.biz)?.n) === 1);
  check("rundown: live overdue unchanged by archived ones", !rd.overdue.some((r) => r.businessId === ids.biz));

  const od = (await (await orderGET(new NextRequest(`${base}/order/${overdue.id}`, { headers: auth }), { params: Promise.resolve({ id: overdue.id }) })).json()) as {
    archivedAt: string | null;
    archiveReason: string | null;
    archivedUnfinished: boolean;
  };
  check("order API: archived and still owed is said plainly", od.archivedUnfinished === true && !!od.archivedAt && od.archiveReason === SWEEP);
  const odDone = (await (await orderGET(new NextRequest(`${base}/order/${delivered.id}`, { headers: auth }), { params: Promise.resolve({ id: delivered.id }) })).json()) as { archivedUnfinished: boolean };
  check("order API: archived delivered is not owed", odDone.archivedUnfinished === false);
}

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
  await setup();
  try {
    await dbTests();
  } finally {
    await cleanup();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall archived-reopen checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await cleanup();
  } catch {}
  process.exit(1);
});
