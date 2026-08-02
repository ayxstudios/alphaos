"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/** Live countdown to due_at. Amber ≤4h remaining, rose when overdue. */
export function Countdown({ dueAt }: { dueAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!dueAt) return <span className="text-xs text-slate">no due date</span>;

  const diff = new Date(dueAt).getTime() - now;
  const overdue = diff < 0;
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const label = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;

  const tone = overdue ? "text-rose" : diff <= 4 * 3_600_000 ? "text-amber" : "text-slate";
  return (
    <span className={cn("text-xs font-medium tabular-nums", tone)}>
      {overdue ? `overdue ${label}` : `${label} left`}
    </span>
  );
}
