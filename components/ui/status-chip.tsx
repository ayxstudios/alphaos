import type { ComponentType } from "react";

import { cn } from "@/lib/utils";
import {
  Camera,
  Inbox,
  Pencil,
  Search,
  Eye,
  Check,
  Printer,
  Truck,
  Package,
  CheckCircle,
  Pause,
  XCircle,
  type IconProps,
} from "./icons";

/** The order states (see CLAUDE.md). */
export type OrderStatus =
  | "awaiting_photos"
  | "ready_to_assign"
  | "in_design"
  | "awaiting_qc"
  | "awaiting_approval"
  | "approved"
  | "printing"
  | "shipped"
  | "delivered"
  | "complete"
  | "on_hold"
  | "cancelled"
  | "triage"
  | "fulfillment_only"
  | "awaiting_details";

type Tone = "slate" | "pigment" | "amber" | "sage" | "rose";

type StatusMeta = {
  label: string;
  tone: Tone;
  icon: ComponentType<IconProps>;
};

// Every chip carries colour + text + icon — never colour alone.
const STATUS: Record<OrderStatus, StatusMeta> = {
  awaiting_photos: { label: "Awaiting photos", tone: "slate", icon: Camera },
  ready_to_assign: { label: "Ready to assign", tone: "pigment", icon: Inbox },
  in_design: { label: "In design", tone: "pigment", icon: Pencil },
  awaiting_qc: { label: "Awaiting QC", tone: "amber", icon: Search },
  awaiting_approval: { label: "Awaiting approval", tone: "amber", icon: Eye },
  approved: { label: "Approved", tone: "sage", icon: Check },
  printing: { label: "Printing", tone: "pigment", icon: Printer },
  shipped: { label: "Shipped", tone: "pigment", icon: Truck },
  delivered: { label: "Delivered", tone: "sage", icon: Package },
  complete: { label: "Complete", tone: "sage", icon: CheckCircle },
  on_hold: { label: "On hold", tone: "amber", icon: Pause },
  cancelled: { label: "Cancelled", tone: "rose", icon: XCircle },
  triage: { label: "Needs review", tone: "amber", icon: Search },
  fulfillment_only: { label: "Fulfilment only", tone: "slate", icon: Package },
  awaiting_details: { label: "Needs details", tone: "amber", icon: Pencil },
};

// Alpha modifiers of palette tokens only — no colours outside the palette.
const toneClasses: Record<Tone, string> = {
  slate: "text-slate bg-slate/[0.08] ring-slate/15",
  pigment: "text-pigment bg-pigment-soft ring-pigment/15",
  amber: "text-amber bg-amber/[0.1] ring-amber/20",
  sage: "text-sage bg-sage/[0.1] ring-sage/20",
  rose: "text-rose bg-rose/[0.1] ring-rose/20",
};

export type StatusChipProps = {
  status: OrderStatus;
  className?: string;
};

// Pill-shaped, icon + label — distinct silhouette from the rectangular Badge
// so "workflow state" and "metadata tag" read as different affordances at a
// glance, never by colour alone.
export function StatusChip({ status, className }: StatusChipProps) {
  const meta = STATUS[status];
  const Glyph = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        toneClasses[meta.tone],
        className,
      )}
    >
      <Glyph size={13} className="shrink-0" />
      {meta.label}
    </span>
  );
}

/** All statuses in workflow order — handy for the styleguide and filters. */
export const ORDER_STATUSES = Object.keys(STATUS) as OrderStatus[];
