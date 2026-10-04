import Link from "next/link";

import { focusRing } from "@/components/ui/styles";
import { ArrowRight } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { formatUsd, USD_LABEL } from "@/lib/money";
import { invoiceHref } from "@/lib/invoice";

/**
 * "Today · This month" pay totals in a board header (designer board and the
 * staff board switcher). The whole pill opens this month's invoice.
 */
export function EarningsPill({ designerId, today, month }: { designerId: string; today: number; month: number }) {
  return (
    <Link
      href={invoiceHref(designerId)}
      aria-label={`Earned today ${formatUsd(today)}, this month ${formatUsd(month)} ${USD_LABEL}. View invoice`}
      className={cn(
        "group flex w-fit items-center gap-4 rounded-card bg-surface px-4 py-2 text-sm shadow-card transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md",
        focusRing,
      )}
    >
      <span className="flex items-baseline gap-1.5">
        <span className="text-xs text-slate">Today</span>
        <span className="font-semibold tabular-nums text-ink">{formatUsd(today)}</span>
      </span>
      <span className="h-4 w-px bg-line" aria-hidden="true" />
      <span className="flex items-baseline gap-1.5">
        <span className="text-xs text-slate">This month</span>
        <span className="font-semibold tabular-nums text-ink">{formatUsd(month)}</span>
        <span className="text-xs font-medium text-slate">{USD_LABEL}</span>
      </span>
      <ArrowRight size={14} className="text-slate transition-colors group-hover:text-pigment" aria-hidden="true" />
    </Link>
  );
}
