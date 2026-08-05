"use client";

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
    <label className="flex min-w-32 flex-col gap-1 text-xs font-medium text-slate">
      {label}
      <select
        value={value}
        onChange={(event) => {
          window.location.href = hrefFor(event.currentTarget.value);
        }}
        className="h-10 rounded-input border border-line bg-canvas px-3 text-sm font-normal text-ink outline-none focus-visible:ring-2 focus-visible:ring-pigment"
      >
        {children}
      </select>
    </label>
  );
}
