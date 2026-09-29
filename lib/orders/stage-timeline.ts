import type { CardEvent } from "@/lib/orders/card-detail";

/**
 * The order's story in plain steps, built from the activity log: every stage
 * change, every hand-over to a designer, and every revision round. Pure, so
 * the order page, the overview and the tests all read the same rule.
 */
export type TimelineStep = {
  id: string;
  at: string;
  /** Short line, plain words: "In revision, round 2". */
  label: string;
  /** Second line: who did it, or what the buyer asked. */
  detail: string | null;
  tone: "neutral" | "revision" | "good" | "warn";
};

/** Edges that count as a revision round (mirrors lib/orders/transitions.ts). */
const REVISION_FROM = new Set(["awaiting_qc", "awaiting_approval", "approved", "printing", "shipped", "delivered", "complete"]);

const STAGE: Record<string, string> = {
  awaiting_details: "Waiting for order details",
  awaiting_photos: "Waiting for buyer photos",
  ready_to_assign: "Ready for a designer",
  in_design: "In design",
  awaiting_qc: "Waiting for QC",
  awaiting_approval: "Sent to buyer, waiting",
  approved: "Buyer approved",
  printing: "Printing",
  shipped: "Shipped",
  delivered: "Delivered",
  complete: "Complete",
  cancelled: "Cancelled",
  on_hold: "On hold",
  triage: "Needs a check",
  fulfillment_only: "Print only",
};

/** "In revision, round 2" for orders back in design, and the same idea for the steps after. */
export function stageWithRound(status: string, revisionCount: number | null | undefined): string {
  const round = revisionCount ?? 0;
  if (round > 0) {
    if (status === "in_design") return `In revision, round ${round}`;
    if (status === "awaiting_qc") return `Revision QC, round ${round}`;
    if (status === "awaiting_approval") return `Revision sent to buyer, round ${round}`;
  }
  return STAGE[status] ?? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function isRevisionStage(status: string, revisionCount: number | null | undefined): boolean {
  return (revisionCount ?? 0) > 0 && (status === "in_design" || status === "awaiting_qc" || status === "awaiting_approval");
}

function metaString(meta: Record<string, unknown> | null, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = meta?.[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return null;
}

export function buildStageTimeline(events: CardEvent[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  let round = 0;
  let currentStage: string | null = null;
  for (const e of events) {
    const who = e.actorName ?? "System";
    if (e.toState && e.toState !== e.fromState) {
      const revising = e.toState === "in_design" && !!e.fromState && REVISION_FROM.has(e.fromState);
      if (revising) round += 1;
      let label = STAGE[e.toState] ?? e.toState;
      let detail: string | null = who;
      let tone: TimelineStep["tone"] = "neutral";
      if (revising) {
        tone = "revision";
        label = `In revision, round ${round}`;
        const reason = metaString(e.metadata, "revisionReason", "reason", "note");
        detail = e.fromState === "awaiting_qc" ? `QC sent it back${reason ? `: ${reason}` : ""}` : `Buyer asked for a change${reason ? `: ${reason}` : ""}`;
      } else if (round > 0 && e.toState === "awaiting_qc") {
        label = `Revision QC, round ${round}`;
        tone = "revision";
      } else if (round > 0 && e.toState === "awaiting_approval") {
        label = `Revision sent to buyer, round ${round}`;
        tone = "revision";
      } else if (e.toState === "approved" || e.toState === "complete" || e.toState === "shipped") {
        tone = "good";
      } else if (e.toState === "on_hold" || e.toState === "cancelled" || e.toState === "triage") {
        tone = "warn";
      }
      currentStage = e.toState;
      steps.push({ id: e.id, at: e.createdAt, label, detail, tone });
      continue;
    }
    if (e.action === "order.assigned" || e.action === "order.reassigned" || e.action === "agent.assigned" || e.action === "agent.rebalanced") {
      const first = e.action === "order.assigned" || e.metadata?.firstAssignment === true;
      steps.push({
        id: e.id,
        at: e.createdAt,
        label: first ? "Given to a designer" : "Moved to another designer",
        detail: e.action.startsWith("agent.") ? "By the agent" : who,
        tone: "neutral",
      });
    }
  }
  void currentStage;
  return steps;
}
