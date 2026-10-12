import { LABEL_CLASS } from "@/components/board/card-meta";
import { cn } from "@/lib/utils";

/**
 * The URGENT marker (lib/orders/urgent.ts) for lists and headers outside the
 * board: the same solid pill the board cards use, with the reason on hover.
 */
export function UrgentPill({ reason, className }: { reason?: string | null; className?: string }) {
  return (
    <span
      title={reason ? `Urgent: ${reason}` : "Urgent"}
      className={cn("inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-semibold", LABEL_CLASS.urgent, className)}
    >
      Urgent
    </span>
  );
}
