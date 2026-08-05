import type { BoardCard } from "@/lib/orders/board-data";
import type { CardEvent } from "@/lib/orders/card-detail";
import type { OrderStatus } from "@/lib/orders/transitions";

/** Label tones map onto the design tokens — no colour outside the palette. */
export type LabelTone = "neutral" | "pigment" | "amber" | "rose" | "sage";

export type CardLabel = { text: string; tone: LabelTone };

export const LABEL_CLASS: Record<LabelTone, string> = {
  neutral: "bg-canvas text-slate border border-line",
  pigment: "bg-pigment-soft text-pigment",
  amber: "bg-amber/10 text-amber",
  rose: "bg-rose/10 text-rose",
  sage: "bg-sage/10 text-sage",
};

/** The coloured pills shown on the card and in the modal header — one system. */
export function cardLabels(card: BoardCard): CardLabel[] {
  const labels: CardLabel[] = [];
  if (card.source === "manual") labels.push({ text: "Manual", tone: "amber" });
  else if (card.source === "etsy") labels.push({ text: "Etsy", tone: "neutral" });
  else if (card.source === "shopify") labels.push({ text: "Shopify", tone: "neutral" });

  if (card.customerRevision) labels.push({ text: "Revision", tone: "pigment" });
  if (card.qcFail) labels.push({ text: "QC failed", tone: "rose" });
  if (card.style) labels.push({ text: card.style, tone: "sage" });
  if (!card.figuresResolved) labels.push({ text: "Figures ?", tone: "amber" });
  return labels;
}

const STATE_LABEL: Record<OrderStatus, string> = {
  awaiting_photos: "Awaiting photos",
  ready_to_assign: "Ready to assign",
  in_design: "In design",
  awaiting_qc: "Awaiting QC",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  printing: "Printing",
  shipped: "Shipped",
  delivered: "Delivered",
  complete: "Complete",
  on_hold: "On hold",
  cancelled: "Cancelled",
  triage: "Needs review",
  fulfillment_only: "Fulfilment",
  awaiting_details: "Awaiting details",
};

export function stateLabel(s: OrderStatus | null): string {
  return s ? (STATE_LABEL[s] ?? s) : "—";
}

/**
 * A one-line, human description of a history event (actor rendered separately).
 * Returns null for comments — those render as chat bubbles, not activity lines.
 */
export function describeEvent(e: CardEvent): string | null {
  if (e.action === "comment") return null;

  const to = e.toState;
  const from = e.fromState;
  switch (e.action) {
    case "order.ready_to_assign":
      return "moved this to Ready to assign";
    case "order.in_design":
      if (from === "ready_to_assign") return "started the design";
      if (from === "awaiting_qc") return "sent this back to design (QC fail)";
      if (from === "awaiting_approval") return "sent this back to design (customer revision)";
      return "moved this to In design";
    case "order.awaiting_qc":
      return "submitted this for QC";
    case "order.awaiting_approval":
      return "passed QC — sent to the customer for approval";
    case "order.approved":
      return "approved this proof";
    case "order.printing":
      return "sent this to print";
    case "order.shipped":
      return "marked this shipped";
    case "order.delivered":
      return "marked this delivered";
    case "order.complete":
      return "completed this order";
    case "order.on_hold":
      return "put this on hold";
    case "order.cancelled":
      return "cancelled this order";
    case "proof.viewed":
      return "the customer viewed the proof";
    case "order.imported":
    case "order.created":
      return "imported this order";
    default:
      break;
  }
  // Generic fallback: humanise the action and show the transition if any.
  const nice = e.action.replace(/^order\./, "").replace(/[._]/g, " ");
  if (from && to) return `moved this ${stateLabel(from)} → ${stateLabel(to)}`;
  if (to) return `moved this to ${stateLabel(to)}`;
  return nice;
}

/** Compact relative time ("3m", "5h", "2d") with an absolute fallback. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-AU", { day: "2-digit", month: "short" });
}
