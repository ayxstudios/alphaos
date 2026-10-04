import Link from "next/link";

import { Badge, Disclosure } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { cn } from "@/lib/utils";
import { formatAt } from "@/lib/time";
import type { DesignerBoard as BoardData } from "@/lib/orders/board-data";
import { formatUsd, formatUsdPerFigure, USD_LABEL } from "@/lib/money";

function money(value: string | null): string {
  return value == null ? "On hold" : formatUsd(value);
}

/** The day an earning was made ("23 Sept"): the time of day adds nothing here. */
function shortDay(value: string): string {
  return formatAt(value, { day: "numeric", month: "short" });
}

/** Earning states in a designer's words. "Blocked" means pay waits on a figure count. */
const EARNING_STATUS: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  blocked: "On hold",
  voided: "Voided",
};

/** The "Earnings history" disclosure under a board (server page and board switcher both render it). */
export function EarningsHistory({ history }: { history: BoardData["earningHistory"] }) {
  return (
    <Disclosure
      summary="Earnings history"
      hint={history.length ? `${history.length} order${history.length === 1 ? "" : "s"} · amounts in ${USD_LABEL}` : "nothing yet"}
    >
      {history.length === 0 ? (
        <p className="py-1 text-sm text-slate">Pay for an order shows here once it is complete.</p>
      ) : (
        // Two lines per order at every size: what it was on the
        // left, what it pays and where the payment is on the right.
        // The whole row is the link, so it is an easy tap on a phone.
        <div className="-mx-4 divide-y divide-line/70">
          {history.map((earning) => (
            <Link
              key={earning.id}
              href={`/orders/${earning.orderId}`}
              className={cn("flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-canvas/60", focusRing)}
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">{earning.orderNumber}</p>
                <p className="text-xs text-slate">
                  {[
                    earning.style,
                    `${earning.figureCount} figure${earning.figureCount === 1 ? "" : "s"}`,
                    earning.rate ? formatUsdPerFigure(earning.rate) : earning.status === "blocked" ? null : "Mixed rates",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="font-semibold tabular-nums text-ink">{money(earning.amount)}</span>
                <span className="flex items-center gap-2">
                  <Badge variant={earning.status === "blocked" ? "warning" : earning.status === "voided" ? "danger" : earning.status === "paid" ? "success" : "neutral"}>
                    {EARNING_STATUS[earning.status] ?? earning.status}
                  </Badge>
                  <span className="text-xs text-slate">{shortDay(earning.createdAt)}</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Disclosure>
  );
}
