"use client";

import { ChevronDown } from "@/components/ui/icons";

export function OrdersFilterSelect({
  label,
  value,
  paramName,
  currentParams,
  children,
}: {
  label: string;
  value: string;
  paramName: string;
  currentParams: string;
  children: React.ReactNode;
}) {
  function hrefFor(nextValue: string) {
    const params = new URLSearchParams(currentParams);
    if (nextValue) params.set(paramName, nextValue);
    else params.delete(paramName);
    params.delete("page");
    return `/orders?${params.toString()}`;
  }

  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-slate">
      {label}
      <span className="relative">
        <select
          value={value}
          onChange={(event) => {
            window.location.href = hrefFor(event.currentTarget.value);
          }}
          className="h-10 w-full appearance-none rounded-input bg-canvas pl-3 pr-9 text-sm font-normal text-ink outline-none focus-visible:ring-2 focus-visible:ring-pigment"
        >
          {children}
        </select>
        <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate" />
      </span>
    </label>
  );
}
