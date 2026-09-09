// Alpha AI client. The ONE way AlphaOS talks to Alpha (the manager that runs on
// the daemon, on its own number). Three verbs:
//
//   sendAlphaEvent(tx, evt)  fire-and-forget: queue a row in alpha_events, then
//                            try the hook once. The daemon also polls the queue,
//                            so a failed hook call is never a lost message.
//   askAlpha(q)              synchronous single question -> answer from the
//                            rulebook. Falls back to a calm "not connected"
//                            answer.
//   chatAlpha(req)           synchronous multi-turn chat for the floating
//                            widget (2026-09-09). Tries /alpha/chat first;
//                            while the daemon hasn't restarted onto it yet
//                            (404/503) falls back to /alpha/ask with the
//                            conversation folded into `context`; any other
//                            failure (or no hook configured) falls back to a
//                            deterministic answer built from the snapshot.
//                            Never throws, never returns an error string.
//
// Env: ALPHA_HOOK_URL (daemon bridge base, via the tunnel), ALPHA_HOOK_SECRET.
// Both optional: without them events queue and questions/chat get the fallback.
import { alphaEvents } from "@/lib/db/schema";
import type { Tx as DbTx } from "@/lib/db";

export type AlphaEventType =
  | "designer.brief" // new assignment: reference, photos, count, deadline, upload link
  | "designer.nudge" // 24 h with no submission
  | "designer.reassigned" // 48 h: moved to another designer (both told)
  | "designer.qc_feedback" // QC failed with pins
  | "va.attention" // something a VA must look at now
  | "customer.silent" // customer has not answered in N days
  | "order.missed_print" // in printing but no provider order
  | "owner.rundown" // the 06:00 summary
  | "owner.question"; // Alpha needs a rule it does not have

export interface AlphaEvent {
  type: AlphaEventType;
  businessId?: string | null;
  orderId?: string | null;
  toUserId?: string | null;
  toRole?: "admin" | "va" | "designer" | null;
  text: string;
  payload?: Record<string, unknown>;
}

export interface AlphaAsk {
  question: string;
  askedBy: { userId: string; role: "admin" | "va" | "designer"; name: string };
  businessId?: string | null;
  orderId?: string | null;
  context?: Record<string, unknown>;
}

export interface AlphaAnswer {
  answer: string;
  ruleId?: string | null;
  escalated: boolean;
  connected: boolean;
}

export interface AlphaChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AlphaChatRequest {
  messages: AlphaChatMessage[];
  askedBy: { userId: string; role: "admin" | "va" | "designer"; name: string };
  snapshot?: Record<string, unknown> | null;
  page?: string | null;
  orderId?: string | null;
}

export interface AlphaChatAnswer {
  answer: string;
  escalated: boolean;
  /** Which hop actually produced the answer -- for QA/telemetry only, never
   * shown to the person chatting. */
  source: "chat" | "ask" | "snapshot";
}

const hookUrl = () => (process.env.ALPHA_HOOK_URL || "").replace(/\/$/, "");
const hookSecret = () => process.env.ALPHA_HOOK_SECRET || "";
export const alphaConnected = () => Boolean(hookUrl() && hookSecret());

class AlphaHookError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

async function postHook(path: string, body: unknown, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${hookUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-alpha-secret": hookSecret() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new AlphaHookError(`alpha hook ${path} -> ${res.status}`, res.status);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(t);
  }
}

function humanizeSnapshotKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

/** Never an error string: a short plain-English line built straight from
 * whatever numeric fields the snapshot has, so the widget always shows
 * something useful even with the daemon fully unreachable. */
function snapshotFallbackAnswer(snapshot: Record<string, unknown> | null | undefined): string {
  const parts: string[] = [];
  if (snapshot && typeof snapshot === "object") {
    for (const [key, value] of Object.entries(snapshot)) {
      if (typeof value === "number") parts.push(`${humanizeSnapshotKey(key)}: ${value}`);
    }
  }
  const summary = parts.length ? `Here is what I can see right now: ${parts.join(", ")}.` : "Nothing urgent is showing right now.";
  return `${summary} Alpha will answer in full shortly.`;
}

/** Queue an event for Alpha. Safe inside any tx; never throws on hook failure. */
export async function sendAlphaEvent(tx: DbTx, evt: AlphaEvent): Promise<string> {
  const [row] = await tx
    .insert(alphaEvents)
    .values({
      type: evt.type,
      businessId: evt.businessId ?? null,
      orderId: evt.orderId ?? null,
      toUserId: evt.toUserId ?? null,
      toRole: evt.toRole ?? null,
      text: evt.text,
      payload: evt.payload ?? {},
      status: "queued",
    })
    .returning({ id: alphaEvents.id });
  if (alphaConnected()) {
    // Best effort, off the critical path. The daemon's poller is the guarantee.
    void postHook("/alpha/event", { id: row.id, ...evt }, 8000).catch(() => {});
  }
  return row.id;
}

/** Ask Alpha a question. Always returns an answer object; never throws. */
export async function askAlpha(q: AlphaAsk): Promise<AlphaAnswer> {
  if (!alphaConnected()) {
    return {
      answer:
        "Alpha is not connected on this workspace yet. Leave the question on the order as a comment and a person will answer it; once Alpha is connected it will answer here.",
      ruleId: null,
      escalated: false,
      connected: false,
    };
  }
  try {
    const out = await postHook("/alpha/ask", q, 60000);
    return {
      answer: String(out.answer || "").trim() || "Alpha had no answer. A person has been asked.",
      ruleId: (out.ruleId as string) || null,
      escalated: Boolean(out.escalated),
      connected: true,
    };
  } catch {
    return {
      answer: "Alpha could not be reached right now. The question has been kept and will be answered as soon as it is back.",
      ruleId: null,
      escalated: true,
      connected: true,
    };
  }
}

/**
 * Ask Alpha inside a running conversation (the floating chat widget).
 * Always returns an answer; never throws and never surfaces an error string.
 */
export async function chatAlpha(req: AlphaChatRequest): Promise<AlphaChatAnswer> {
  if (!alphaConnected()) {
    return { answer: snapshotFallbackAnswer(req.snapshot), escalated: false, source: "snapshot" };
  }

  try {
    const out = await postHook("/alpha/chat", req, 60000);
    return {
      answer: String(out.answer || "").trim() || snapshotFallbackAnswer(req.snapshot),
      escalated: Boolean(out.escalated),
      source: "chat",
    };
  } catch (err) {
    // The daemon only serves /alpha/chat after its own restart; until then
    // the path 404s or, because the pre-restart bridge's auth bypass list
    // does not know it yet, 401s. Either way this is "not deployed yet".
    // We do NOT fall back to /alpha/ask here: that route answers from the
    // rulebook alone and escalates every uncovered question to Yousif on
    // WhatsApp, which turns a chat about "what is waiting" into noise for
    // him (seen live 2026-09-09). The snapshot answer is honest and quiet.
    void err;
    return { answer: snapshotFallbackAnswer(req.snapshot), escalated: false, source: "snapshot" };
  }
}
