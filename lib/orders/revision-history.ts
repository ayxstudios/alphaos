import type { CardEvent } from "@/lib/orders/card-detail";
import { SENT_BACK_FROM } from "@/lib/orders/board-constants";

/**
 * Every time an order went back to its designer (a failed QC, a customer's
 * change request, a revision the team passed on), as notes a designer can read
 * back and copy. Built from the card's own history feed: the send-back row in
 * the activity log already carries the QC reason and failed checks, or the
 * revision words, ticked issues and pin count (lib/orders/transitions.ts,
 * lib/proofs/decide.ts), and the feed is already scrubbed to what a designer
 * may see (lib/orders/card-detail.ts). Pure, so the card and the test share
 * one rule.
 */
export type RevisionHistoryNote = {
  id: string;
  /** When it was asked (ISO). */
  at: string;
  /** qc = a failed QC; customer = the customer's own request; team = a revision the team passed on. */
  kind: "qc" | "customer" | "team";
  /** Who asked: the team member's name, "The customer", or null when unknown. */
  who: string | null;
  /** Their words; null when only checks or issues were ticked. */
  note: string | null;
  /** The failed QC checks, or the issues the customer ticked. */
  items: string[];
  /** Spots the customer marked on the proof. */
  pins: number;
};

/** Revisions that reach the card straight from the customer: the proof page, or their email applied by the agent. */
const CUSTOMER_VIA = new Set(["proof_portal", "agent_inbox"]);

function str(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(Boolean) : [];
}

/**
 * The customer's own words on a revision. The stored note repeats the issues
 * they ticked in front of it ("Wrong eye colour. Could the collar be blue?"),
 * and those issues are listed beside the note, so they are dropped here.
 * Null when nothing is left.
 */
export function revisionNote(reason: string | null, failedItems: string[]): string | null {
  if (!reason) return null;
  let text = reason.trim();
  const prefix = failedItems.join(", ");
  if (prefix && text.toLowerCase().startsWith(prefix.toLowerCase())) {
    text = text.slice(prefix.length).replace(/^[\s.,;:]+/, "");
  }
  return text || null;
}

/** What one Copy press puts on the clipboard: the words, then each check or issue on its own line. */
export function revisionCopyText(note: string | null, items: string[]): string {
  return [note?.trim(), ...items.map((item) => `- ${item}`)].filter(Boolean).join("\n");
}

/** Newest first. A send-back with nothing written, ticked or pinned has nothing to read, so it is left out. */
export function buildRevisionHistory(events: CardEvent[]): RevisionHistoryNote[] {
  const notes: RevisionHistoryNote[] = [];
  for (const e of events) {
    if (e.toState !== "in_design" || !e.fromState) continue;
    if (!(SENT_BACK_FROM as readonly string[]).includes(e.fromState)) continue;
    const meta = e.metadata ?? {};
    if (e.fromState === "awaiting_qc") {
      const items = strings(meta.failedItems);
      const note = str(meta.reason) || null;
      if (!note && items.length === 0) continue;
      notes.push({
        id: e.id,
        at: e.createdAt,
        kind: "qc",
        who: e.actorName ?? (str(meta.signature) || null),
        note,
        items,
        pins: 0,
      });
      continue;
    }
    const items = strings(meta.revisionIssues);
    const note = revisionNote(str(meta.revisionReason) || null, items);
    const pins = typeof meta.annotationCount === "number" && meta.annotationCount > 0 ? meta.annotationCount : 0;
    if (!note && items.length === 0 && pins === 0) continue;
    const customer = !e.actorId && CUSTOMER_VIA.has(str(meta.via));
    notes.push({
      id: e.id,
      at: e.createdAt,
      kind: customer ? "customer" : "team",
      who: customer ? "The customer" : e.actorName,
      note,
      items,
      pins,
    });
  }
  return notes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
