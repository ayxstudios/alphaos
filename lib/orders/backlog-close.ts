/**
 * BACKLOG CLOSE (Yousif 2026-11-08 18:48, chat 64828303487194@lid): "Also for orders before October 15. Just mark
 * them as complete. If a customers messages asking where it is, send them another one off via gelato if we haven't
 * already. If it's digital only and we haven't started, be like I couldn't seem to find any record of it so we're just
 * going to redraw it ... The idea here is to clear the backlogs".
 *
 * Every open order placed before the cut is closed as complete in ONE system step per order:
 *   - status -> complete directly, never a transition chain (approved -> printing -> shipped emails the buyer) and no
 *     stage email, proof or Alpha push: one activity_log row (order.complete, via backlog_close, his words, the prior
 *     status) and its open exceptions resolved with the same note;
 *   - its in-app earning books only when its proof passed QC, dated to that first pass (the weekly invoice paid it then;
 *     createEarningForCompletion is once per order); a never-drawn order books nothing;
 *   - a LIVE order stays open (liveReasons): the buyer wrote, answered or opened her proof, a designer or QC moved it,
 *     its print moved, or someone flagged it urgent, all inside `liveDays`; so does anything named in `keep`, and an
 *     approved print our own print check is holding as an unpaid draft (she said yes and paid; the print road prints
 *     it, Yousif the same evening: "you can just fix it");
 *   - every closed row goes into the report first; undoBacklogClose() puts back each one still complete via
 *     backlog_close (status, exceptions, the earning it booked).
 * She writes later = the daemon's where-is road (a Gelato one-off if we never sent her another, or the redraw line).
 */
import { and, eq, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, earnings, exceptions, orders } from "@/lib/db/schema";
import { createEarningForCompletion } from "@/lib/orders/earnings";

export const BACKLOG_CUT = "2026-10-14T13:00:00.000Z"; // 15 Oct 2026 00:00 Australia/Sydney (AEDT, UTC+11)
export const BACKLOG_WORDS =
  "Also for orders before October 15. Just mark them as complete.";
export const BACKLOG_BY = "Yousif in chat 2026-11-08 18:48";
export const BACKLOG_NOTE = `Backlog close: ${BACKLOG_BY}, "${BACKLOG_WORDS}" Handled again only if the buyer writes.`;

// the agent's own urgent lines are not a person reaching out (lib/agent/scope.ts uses the same pattern)
const AGENT_URGENT_RE =
  /^(customer deadline close|paid (shopify|etsy) order|website order)/i;

export type BacklogFacts = {
  id: string;
  businessId: string;
  business: string;
  number: string;
  status: string;
  placedAt: string | null;
  kinds: string | null;
  printJobs: number;
  heldPrint: boolean;
  openExceptions: number;
  firstQcPass: string | null;
  lastBuyerMessage: string | null;
  lastBuyerAction: string | null;
  lastDesign: string | null;
  lastPrint: string | null;
  urgentAt: string | null;
  urgentBy: string | null;
  urgentReason: string | null;
};

export type BacklogRow = BacklogFacts & { live: string[]; kept: boolean };

const within = (at: string | null, now: number, days: number) => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) && now - t < days * 86_400_000;
};

/** Why an old order is still being worked (empty = quiet, it closes). Pure. */
export function liveReasons(
  f: BacklogFacts,
  now: number,
  liveDays: number,
): string[] {
  const out: string[] = [];
  if (f.heldPrint)
    out.push(
      "approved, its print is held as an unpaid draft: the print road prints it",
    );
  if (within(f.lastBuyerMessage, now, liveDays))
    out.push(`buyer wrote ${f.lastBuyerMessage!.slice(0, 10)}`);
  if (within(f.lastBuyerAction, now, liveDays))
    out.push(
      `buyer answered or opened her proof ${f.lastBuyerAction!.slice(0, 10)}`,
    );
  if (within(f.lastDesign, now, liveDays))
    out.push(`designer or QC moved it ${f.lastDesign!.slice(0, 10)}`);
  if (within(f.lastPrint, now, liveDays))
    out.push(`print moved ${f.lastPrint!.slice(0, 10)}`);
  const agentOwn =
    (f.urgentBy ?? "") === "agent" &&
    AGENT_URGENT_RE.test(f.urgentReason ?? "");
  if (within(f.urgentAt, now, liveDays) && !agentOwn)
    out.push(
      `flagged urgent ${f.urgentAt!.slice(0, 10)}: ${(f.urgentReason ?? "").slice(0, 60)}`,
    );
  return out;
}

const iso = (v: unknown) =>
  v === null || v === undefined ? null : new Date(v as string).toISOString();

export async function loadBacklog(
  tx: Tx,
  cut: string,
): Promise<BacklogFacts[]> {
  const res = await tx.execute(sql`
    select o.id, o.business_id, b.name as business, coalesce(o.platform_order_name, o.platform_order_id) as number,
      o.status::text as status, coalesce(o.placed_at, o.created_at) as placed_at,
      (select string_agg(distinct i.product_type::text, ',') from order_items i where i.order_id = o.id) as kinds,
      (select count(*)::int from print_jobs p where p.order_id = o.id) as print_jobs,
      (o.status::text = 'approved' and exists (select 1 from print_jobs p where p.order_id = o.id
        and coalesce(p.provider_order_id, '') = '' and coalesce(p.provider_order_number, '') = '' and coalesce(p.tracking_number, '') = '')) as held_print,
      (select count(*)::int from exceptions e where e.order_id = o.id and e.status = 'open') as open_exceptions,
      (select min(l.created_at) from activity_log l where l.order_id = o.id and l.to_state = 'awaiting_approval') as first_qc_pass,
      (select max(m.created_at) from messages m where m.order_id = o.id and m.direction::text = 'inbound') as last_buyer_message,
      (select max(l.created_at) from activity_log l where l.order_id = o.id
        and (l.metadata->>'via' in ('proof_portal', 'agent_proof_replies') or l.action in ('message.received', 'agent.reply_applied'))) as last_buyer_action,
      (select max(l.created_at) from activity_log l where l.order_id = o.id
        and l.action in ('asset.uploaded', 'order.awaiting_qc', 'order.awaiting_approval', 'order.in_design', 'order.assigned')) as last_design,
      greatest(
        (select max(l.created_at) from activity_log l where l.order_id = o.id
          and (l.action in ('order.printing', 'order.shipped', 'order.delivered') or l.action like 'print.reconcile_shipped%' or l.action like 'print.reconcile_tracking%')),
        (select max(p.created_at) from print_jobs p where p.order_id = o.id)) as last_print,
      o.urgent_at, o.urgent_by, o.urgent_reason
    from orders o join businesses b on b.id = o.business_id
    where o.archived_at is null
      and coalesce(o.placed_at, o.created_at) < ${cut}::timestamptz
      and o.status::text not in ('complete', 'cancelled')
    order by coalesce(o.placed_at, o.created_at)`);
  const rows = ((res as unknown as { rows?: Record<string, unknown>[] }).rows ??
    (res as unknown as Record<string, unknown>[])) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    businessId: String(r.business_id),
    business: String(r.business),
    number: String(r.number),
    status: String(r.status),
    placedAt: iso(r.placed_at),
    kinds: (r.kinds as string | null) ?? null,
    printJobs: Number(r.print_jobs ?? 0),
    heldPrint: r.held_print === true,
    openExceptions: Number(r.open_exceptions ?? 0),
    firstQcPass: iso(r.first_qc_pass),
    lastBuyerMessage: iso(r.last_buyer_message),
    lastBuyerAction: iso(r.last_buyer_action),
    lastDesign: iso(r.last_design),
    lastPrint: iso(r.last_print),
    urgentAt: iso(r.urgent_at),
    urgentBy: (r.urgent_by as string | null) ?? null,
    urgentReason: (r.urgent_reason as string | null) ?? null,
  }));
}

export type ClosedEntry = {
  orderId: string;
  number: string;
  business: string;
  priorStatus: string;
  priorUpdatedAt: string;
  exceptionsResolved: string[];
  earningId: string | null;
  earningNote: string | null;
};

export type BacklogSummary = {
  cut: string;
  liveDays: number;
  apply: boolean;
  open: number;
  live: BacklogRow[];
  kept: BacklogRow[];
  quiet: BacklogRow[];
  closed: ClosedEntry[];
  skipped: { number: string; why: string }[];
};

/** Close one quiet order. Returns null when it moved since it was read (left alone). */
export async function closeBacklogOrder(
  tx: Tx,
  row: BacklogRow,
): Promise<ClosedEntry | null> {
  const [cur] = await tx
    .select({ status: orders.status, updatedAt: orders.updatedAt })
    .from(orders)
    .where(eq(orders.id, row.id))
    .for("update");
  if (!cur || cur.status !== row.status) return null;
  await tx
    .update(orders)
    .set({ status: "complete", updatedAt: new Date() })
    .where(and(eq(orders.id, row.id), eq(orders.status, cur.status)));
  const resolved = await tx
    .update(exceptions)
    .set({
      status: "resolved",
      resolvedAt: new Date(),
      resolutionNote: BACKLOG_NOTE,
    })
    .where(and(eq(exceptions.orderId, row.id), eq(exceptions.status, "open")))
    .returning({ id: exceptions.id });
  let earningId: string | null = null;
  let earningNote: string | null = null;
  if (row.firstQcPass) {
    const [had] = await tx
      .select({ id: earnings.id })
      .from(earnings)
      .where(eq(earnings.orderId, row.id));
    if (had) earningNote = "earning already booked";
    else {
      try {
        // savepoint: a payout the calculator cannot price never blocks the close
        await tx.transaction((sp) =>
          createEarningForCompletion(
            sp,
            row.id,
            row.businessId,
            new Date(row.firstQcPass!),
          ),
        );
        const [made] = await tx
          .select({ id: earnings.id })
          .from(earnings)
          .where(eq(earnings.orderId, row.id));
        earningId = made?.id ?? null;
        earningNote = made
          ? "booked to the first QC pass"
          : "no active designer, nothing booked";
      } catch (e) {
        earningNote = `not booked: ${(e as Error).message.slice(0, 160)}`;
      }
    }
  } else earningNote = "never passed QC, nothing booked";
  await tx.insert(activityLog).values({
    businessId: row.businessId,
    orderId: row.id,
    actorId: null,
    action: "order.complete",
    fromState: cur.status,
    toState: "complete",
    metadata: {
      edge: `${cur.status}->complete`,
      via: "backlog_close",
      by: BACKLOG_BY,
      words: BACKLOG_WORDS,
      priorStatus: cur.status,
      exceptionsResolved: resolved.map((e) => e.id),
      earningId,
    },
    createdAt: sql`clock_timestamp()`,
  });
  return {
    orderId: row.id,
    number: row.number,
    business: row.business,
    priorStatus: cur.status,
    priorUpdatedAt: new Date(cur.updatedAt).toISOString(),
    exceptionsResolved: resolved.map((e) => e.id),
    earningId,
    earningNote,
  };
}

export async function backlogClose(opts: {
  cut?: string;
  liveDays?: number;
  keep?: string[];
  only?: string[];
  apply?: boolean;
  limit?: number;
  now?: number;
}): Promise<BacklogSummary> {
  const cut = opts.cut ?? BACKLOG_CUT;
  const liveDays = opts.liveDays ?? 10;
  const now = opts.now ?? Date.now();
  const norm = (s: string) => s.replace(/^#/, "").trim().toUpperCase();
  const keep = new Set((opts.keep ?? []).map(norm));
  const only = opts.only?.length ? new Set(opts.only.map(norm)) : null;
  const facts = await withSystemContext((tx) => loadBacklog(tx, cut));
  const rows: BacklogRow[] = facts
    .filter((f) => !only || only.has(norm(f.number)))
    .map((f) => ({
      ...f,
      live: liveReasons(f, now, liveDays),
      kept: keep.has(norm(f.number)),
    }));
  const out: BacklogSummary = {
    cut,
    liveDays,
    apply: !!opts.apply,
    open: rows.length,
    live: rows.filter((r) => !r.kept && r.live.length),
    kept: rows.filter((r) => r.kept),
    quiet: rows.filter((r) => !r.kept && !r.live.length),
    closed: [],
    skipped: [],
  };
  if (!opts.apply) return out;
  const limit = opts.limit ?? Infinity;
  for (const row of out.quiet) {
    if (out.closed.length >= limit) break;
    const done = await withSystemContext((tx) => closeBacklogOrder(tx, row));
    if (done) out.closed.push(done);
    else
      out.skipped.push({
        number: row.number,
        why: "its status changed since it was read",
      });
  }
  return out;
}

/** Put back what backlogClose closed, from its apply report. Leaves alone any order that moved on since. */
export async function undoBacklogClose(
  closed: ClosedEntry[],
): Promise<{ restored: string[]; left: { number: string; why: string }[] }> {
  const restored: string[] = [];
  const left: { number: string; why: string }[] = [];
  for (const c of closed) {
    const why = await withSystemContext(async (tx) => {
      const [cur] = await tx
        .select({ status: orders.status, businessId: orders.businessId })
        .from(orders)
        .where(eq(orders.id, c.orderId))
        .for("update");
      if (!cur) return "order not found";
      if (cur.status !== "complete") return `now ${cur.status}, moved on since`;
      const [last] = await tx
        .select({
          via: sql<string>`${activityLog.metadata}->>'via'`,
          to: activityLog.toState,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.orderId, c.orderId),
            sql`${activityLog.toState} is not null`,
          ),
        )
        .orderBy(sql`${activityLog.createdAt} desc`)
        .limit(1);
      if (!last || last.via !== "backlog_close")
        return "a later status change exists";
      await tx
        .update(orders)
        .set({
          status: c.priorStatus as typeof orders.$inferInsert.status,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, c.orderId));
      for (const id of c.exceptionsResolved) {
        const [ex] = await tx
          .select({ kind: exceptions.kind })
          .from(exceptions)
          .where(eq(exceptions.id, id));
        if (!ex) continue;
        const [clash] = await tx
          .select({ id: exceptions.id })
          .from(exceptions)
          .where(
            and(
              eq(exceptions.orderId, c.orderId),
              eq(exceptions.kind, ex.kind),
              eq(exceptions.status, "open"),
            ),
          );
        if (!clash)
          await tx
            .update(exceptions)
            .set({ status: "open", resolvedAt: null, resolutionNote: null })
            .where(eq(exceptions.id, id));
      }
      if (c.earningId)
        await tx.delete(earnings).where(eq(earnings.id, c.earningId));
      await tx.insert(activityLog).values({
        businessId: cur.businessId,
        orderId: c.orderId,
        actorId: null,
        action: `order.${c.priorStatus}`,
        fromState: "complete",
        toState: c.priorStatus as typeof orders.$inferInsert.status,
        metadata: {
          edge: `complete->${c.priorStatus}`,
          via: "backlog_close_undo",
        },
        createdAt: sql`clock_timestamp()`,
      });
      return null;
    });
    if (why) left.push({ number: c.number, why });
    else restored.push(c.number);
  }
  return { restored, left };
}
