// NEEDS YOU, the passes (./needs-you.ts has the rules). The tick closes what has
// nothing left to do; the agent takes its rows through /api/alpha/needs-you,
// resolves them with a note, or hands one to an owner (upset, money back,
// legal). Every write is one activity row; system writes, so actor_id is null.
import { and, eq, inArray, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, businesses, exceptions } from "@/lib/db/schema";
import { appUrl } from "@/lib/urls";
import { autoResolveTx } from "./limbo";
import {
  AGENT_TAKE_LIMIT,
  agentStateOf,
  roadOf,
  takeable,
  type OwnerTag,
  type Road,
} from "./needs-you";
import {
  buyerWords,
  graceHours,
  needsYouInput,
  onlyEmailMissing,
  openRaisableRows,
  shortShopLabel,
  type RaisableRow,
} from "./owner-digest";

export type NothingLeftResult = { checked: number; closed: number; byReason: Record<string, number>; ids: string[] };

/** The tick's pass for one business: close the rows with nothing left to do. dryRun counts and writes nothing. */
export async function closeNothingLeft(
  businessId: string,
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<NothingLeftResult> {
  const now = opts.now ?? new Date();
  return withSystemContext(async (tx) => {
    const rows = await openRaisableRows(tx, [businessId]);
    const toClose: { id: string; businessId: string; orderId: string | null; kind: string; reason: string }[] = [];
    for (const r of rows) {
      const road = roadOf(needsYouInput(r));
      if (road.road === "close") toClose.push({ id: r.id, businessId: r.businessId, orderId: r.orderId, kind: r.kind, reason: road.why });
    }
    const byReason: Record<string, number> = {};
    for (const c of toClose) byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;
    if (opts.dryRun) return { checked: rows.length, closed: toClose.length, byReason, ids: toClose.map((c) => c.id) };
    const closed = await autoResolveTx(tx, toClose, now);
    return { checked: rows.length, closed, byReason, ids: toClose.map((c) => c.id) };
  });
}

export type NeedsYouItem = {
  id: string;
  kind: string;
  road: Road["road"];
  tags: OwnerTag[];
  why: string;
  business: string;
  shop: string;
  number: string | null;
  orderId: string | null;
  orderStatus: string | null;
  revisions: number | null;
  summary: string;
  recommendation: string | null;
  /** The buyer's words, history cut off. */
  said: string | null;
  /** What the row knows beyond its summary (why it is stuck, what is missing, the sender). */
  facts: Record<string, unknown>;
  link: string;
  createdAt: string;
  escalations: number;
  takes: number;
  takenAt: string | null;
  agentNote: string | null;
  /** The agent may take it now. */
  takeable: boolean;
};

const FACT_KEYS = ["reason", "missing", "suggested", "from", "subject", "verdict", "verdictReason", "messageId", "said", "ownerAsk"];

function itemOf(r: RaisableRow, bizName: Map<string, string>, now: Date): NeedsYouItem {
  const detail = (r.detail ?? {}) as Record<string, unknown>;
  const input = needsYouInput(r);
  const road = roadOf(input);
  const agent = agentStateOf(detail);
  const grace = graceHours({ kind: r.kind, emailOnly: onlyEmailMissing(r.kind, detail) });
  const facts: Record<string, unknown> = {};
  for (const k of FACT_KEYS) if (detail[k] !== undefined) facts[k] = detail[k];
  return {
    id: r.id,
    kind: r.kind,
    road: road.road,
    tags: road.tags,
    why: road.why,
    business: bizName.get(r.businessId) ?? "",
    shop: r.shopName ? shortShopLabel(r.shopName) : (bizName.get(r.businessId) ?? ""),
    number: r.orderId ? r.number : null,
    orderId: r.orderId,
    orderStatus: r.orderStatus,
    revisions: r.revisions,
    summary: r.summary,
    recommendation: input.recommendation,
    said: typeof detail.excerpt === "string" ? buyerWords(detail.excerpt, 1200) : null,
    facts,
    link: r.orderId ? appUrl(`/orders/${r.orderId}`) : appUrl("/exceptions"),
    createdAt: r.createdAt.toISOString(),
    escalations: typeof detail.escalations === "number" ? detail.escalations : 0,
    takes: agent.takes,
    takenAt: agent.takenAt,
    agentNote: agent.note,
    takeable: road.road === "agent" && grace !== null && takeable(r.createdAt, grace, agent, now),
  };
}

async function allRows(tx: Tx, businessIds?: string[]) {
  const biz = await tx
    .select({ id: businesses.id, name: businesses.name })
    .from(businesses)
    .where(businessIds ? inArray(businesses.id, businessIds) : undefined);
  const bizName = new Map(biz.map((b) => [b.id, b.name]));
  const rows = await openRaisableRows(tx, biz.map((b) => b.id));
  return { rows, bizName };
}

/** Every open row with its road, oldest first. Read-only. */
export async function listNeedsYou(opts: { now?: Date; businessIds?: string[] } = {}): Promise<NeedsYouItem[]> {
  const now = opts.now ?? new Date();
  return withSystemContext(async (tx) => {
    const { rows, bizName } = await allRows(tx, opts.businessIds);
    return rows.map((r) => itemOf(r, bizName, now)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
}

/**
 * The agent takes up to `limit` of its rows that are due, oldest first, and
 * each is stamped (detail.agentTakenAt, detail.agentTakes) so the owner does
 * not hear about it while it is being worked. Two takers never get one row:
 * the stamp only lands on the take count it read.
 */
export async function takeForAgent(opts: { now?: Date; limit?: number; businessIds?: string[] } = {}): Promise<NeedsYouItem[]> {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? AGENT_TAKE_LIMIT, 50));
  return withSystemContext(async (tx) => {
    const { rows, bizName } = await allRows(tx, opts.businessIds);
    const due = rows
      .map((r) => itemOf(r, bizName, now))
      .filter((i) => i.takeable)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    const taken: NeedsYouItem[] = [];
    for (const i of due) {
      const stamp = { agentTakenAt: now.toISOString(), agentTakes: i.takes + 1 };
      const done = await tx
        .update(exceptions)
        .set({ detail: sql`coalesce(${exceptions.detail}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb` })
        .where(
          and(
            eq(exceptions.id, i.id),
            eq(exceptions.status, "open"),
            sql`coalesce((${exceptions.detail}->>'agentTakes')::int, 0) = ${i.takes}`,
          ),
        )
        .returning({ id: exceptions.id });
      if (done.length) taken.push({ ...i, takes: stamp.agentTakes, takenAt: stamp.agentTakenAt, takeable: false });
    }
    return taken;
  });
}

type RowRef = { id: string; businessId: string; orderId: string | null; kind: string; status: string };

async function rowRef(tx: Tx, id: string): Promise<RowRef | null> {
  const [row] = await tx
    .select({ id: exceptions.id, businessId: exceptions.businessId, orderId: exceptions.orderId, kind: exceptions.kind, status: exceptions.status })
    .from(exceptions)
    .where(eq(exceptions.id, id));
  return row ?? null;
}

export type DeskResult = { ok: boolean; status?: string; changed?: boolean; error?: string };

/** The agent did it: resolved with its note ("agent: ..."). A row already closed answers changed:false. */
export async function resolveByAgent(id: string, note: string, now = new Date()): Promise<DeskResult> {
  return withSystemContext(async (tx) => {
    const row = await rowRef(tx, id);
    if (!row) return { ok: false, error: "not found" };
    if (row.status !== "open") return { ok: true, status: row.status, changed: false };
    const done = await tx
      .update(exceptions)
      .set({ status: "resolved", resolvedAt: now, resolvedBy: null, resolutionNote: `agent: ${note}` })
      .where(and(eq(exceptions.id, id), eq(exceptions.status, "open")))
      .returning({ id: exceptions.id });
    if (done.length) {
      await tx.insert(activityLog).values({
        businessId: row.businessId,
        orderId: row.orderId,
        actorId: null,
        action: "agent.exception_resolved",
        metadata: { exceptionId: id, kind: row.kind, note },
      });
    }
    return { ok: true, status: done.length ? "resolved" : row.status, changed: done.length > 0 };
  });
}

/** Where the agent got to on a row it could not finish yet; the owner sees it if the agent gives up. */
export async function noteByAgent(id: string, note: string, now = new Date()): Promise<DeskResult> {
  return withSystemContext(async (tx) => {
    const row = await rowRef(tx, id);
    if (!row) return { ok: false, error: "not found" };
    if (row.status !== "open") return { ok: true, status: row.status, changed: false };
    await tx
      .update(exceptions)
      .set({ detail: sql`coalesce(${exceptions.detail}, '{}'::jsonb) || ${JSON.stringify({ agentNote: note, agentNoteAt: now.toISOString() })}::jsonb` })
      .where(and(eq(exceptions.id, id), eq(exceptions.status, "open")));
    return { ok: true, status: "open", changed: true };
  });
}

/**
 * The agent hands a row to an owner (upset, money back, legal, a revision) with
 * what it recommends. Its raise count starts again, so the next owner message
 * carries it.
 */
export async function raiseToOwner(id: string, kinds: OwnerTag[], note: string, now = new Date()): Promise<DeskResult> {
  return withSystemContext(async (tx) => {
    const row = await rowRef(tx, id);
    if (!row) return { ok: false, error: "not found" };
    if (row.status !== "open") return { ok: true, status: row.status, changed: false };
    const ask = { ownerAsk: { kinds, note, at: now.toISOString() }, escalations: 0 };
    await tx
      .update(exceptions)
      .set({ detail: sql`(coalesce(${exceptions.detail}, '{}'::jsonb) - 'escalatedAt') || ${JSON.stringify(ask)}::jsonb` })
      .where(and(eq(exceptions.id, id), eq(exceptions.status, "open")));
    await tx.insert(activityLog).values({
      businessId: row.businessId,
      orderId: row.orderId,
      actorId: null,
      action: "agent.exception_to_owner",
      metadata: { exceptionId: id, kind: row.kind, kinds, note },
    });
    return { ok: true, status: "open", changed: true };
  });
}
