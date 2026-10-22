/**
 * Customer cases for the /approve "Cases" stream (both owners, 2026-10-21: "for customer cases that need attention,
 * an angry customer or refund or something, I want you to make it into a swiper just like the QC thing").
 *
 * The cards live in the agent's table needs_you_cards (knowledge/integrations/needs-you-reviewer.md in the agent repo),
 * which the agent fills (shop asks, AlphaOS owner rows, unhappy-buyer alerts) and carries out. This module only reads
 * them and writes the decision columns, through the existing Needs-you reviewer's key-protected API, so AlphaOS never
 * holds the agent database's credentials. A swipe records the decision; the agent queues it, waits its 30 s undo window
 * and then does it. A card nobody swipes for 24 h is done on the agent's own pick (agent side, autoPass).
 */

export type CaseKind = "upset" | "refund" | "legal" | "revision" | "approve" | "print" | "late" | "qc" | "photos" | "other";

export type CaseCard = {
  id: string;
  kind: CaseKind;
  shop: string | null;
  buyer: string | null;
  orderNo: string | null;
  title: string;
  /** What happened, in plain words. */
  situation: string | null;
  /** Her exact words. */
  herWords: string | null;
  /** The reply the agent would send. */
  suggestedReply: string | null;
  /** The agent's pick, one tickable line each (US$ only). */
  suggestedActions: string[];
  /** Why this is an owner's call + the agent's pick. */
  why: string | null;
  /** What the agent already tried (handled cards only carry it; shown when present). */
  whatIDid: string | null;
  links: { label: string; url: string }[];
  urgent: boolean;
  raisedAt: string | null;
  /** A swipe that did not go through (the card is back in the pile): what stopped it. */
  failedNote: string | null;
};

/** The agent takes its own pick after this long without a swipe (agent side: autoPass). */
export const CASE_AUTO_AFTER_H = 24;
/** The page sends this when the reply box is emptied: send her nothing. Mirrors NO_REPLY in the agent. */
export const NO_REPLY = "[no reply]";

const KINDS: CaseKind[] = ["upset", "refund", "legal", "revision", "approve", "print", "late", "qc", "photos", "other"];

function base(): string | null {
  const key = process.env.NEEDS_YOU_KEY;
  if (!key) return null;
  return (process.env.NEEDS_YOU_URL || "https://yousif-needs-you.vercel.app").replace(/\/$/, "");
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function toCard(r: Row): CaseCard {
  const links = Array.isArray(r.links) ? (r.links as Row[]) : [];
  return {
    id: String(r.id),
    kind: KINDS.includes(r.kind as CaseKind) ? (r.kind as CaseKind) : "other",
    shop: str(r.shop),
    buyer: str(r.buyer),
    orderNo: str(r.order_no),
    title: str(r.title) ?? "Needs you",
    situation: str(r.situation),
    herWords: str(r.her_words),
    suggestedReply: str(r.suggested_reply),
    suggestedActions: Array.isArray(r.suggested_actions) ? (r.suggested_actions as unknown[]).filter((a): a is string => typeof a === "string") : [],
    why: str(r.why),
    whatIDid: str(r.what_i_did),
    links: links.filter((l) => typeof l?.url === "string").map((l) => ({ label: str(l.label) ?? "Open", url: String(l.url) })),
    urgent: !!r.urgent,
    raisedAt: str(r.raised_at),
    failedNote: r.exec_state === "failed" ? (str(r.exec_note) ?? "It did not go through.") : null,
  };
}

/** The last list read on this server (listCasesForCount). */
let recent: { at: number; cards: CaseCard[] } | null = null;

/** The cases waiting for a swipe, urgent first then oldest. null = could not be read (not configured or the agent's page is down). */
export async function listCases(): Promise<CaseCard[] | null> {
  const origin = base();
  if (!origin) return null;
  try {
    const res = await fetch(`${origin}/api/cards?k=${encodeURIComponent(process.env.NEEDS_YOU_KEY!)}`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { live?: Row[] };
    const cards = (j.live ?? []).map(toCard);
    recent = { at: Date.now(), cards };
    return cards;
  } catch {
    return null;
  }
}

/**
 * The case list for the Cases tab's count on the order streams: the agent's
 * page answers in ~2.5 s (it runs in the US), and every Approve page waited
 * for it before showing the order (2026-10-21 to 22). A list read in the last
 * CASES_COUNT_MAX_AGE_MS on this server is used as is; the Cases stream itself
 * always reads fresh (listCases), and a swipe forgets the copy.
 */
export const CASES_COUNT_MAX_AGE_MS = 30_000;

export function listCasesForCount(): Promise<CaseCard[] | null> {
  if (recent && Date.now() - recent.at < CASES_COUNT_MAX_AGE_MS) return Promise.resolve(recent.cards);
  return listCases();
}

export type CaseDecision =
  | { id: string; decision: "tick"; replyEdit?: string | null; actionsOff?: number[] }
  | { id: string; decision: "own"; ownerText: string }
  | { id: string; decision: "sorted" };

export type CaseWrite = { ok: true } | { ok: false; message: string };

async function post(path: string, body: Record<string, unknown>): Promise<CaseWrite> {
  const origin = base();
  if (!origin) return { ok: false, message: "Cases are not connected on this server yet." };
  try {
    const res = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ k: process.env.NEEDS_YOU_KEY, ...body }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.ok && j.ok) return { ok: true };
    return { ok: false, message: j.error || "That didn't go through. Tap again." };
  } catch {
    return { ok: false, message: "That didn't go through (connection dropped). Tap again." };
  }
}

export function writeDecision(d: CaseDecision): Promise<CaseWrite> {
  recent = null;
  return post("/api/decide", {
    id: d.id,
    decision: d.decision,
    owner_text: d.decision === "own" ? d.ownerText : "",
    reply_edit: d.decision === "tick" ? (d.replyEdit ?? "") : "",
    actions_off: d.decision === "tick" ? (d.actionsOff ?? []) : [],
  });
}

export function writeUndo(id: string): Promise<CaseWrite> {
  recent = null;
  return post("/api/undo", { id });
}
