import { cn } from "@/lib/utils";

/**
 * A small shop tag: the platform as a two-letter mark plus the shop name.
 * Colour is a hint only; the letters carry the meaning.
 */
export function ShopBadge({
  platform,
  name,
  className,
}: {
  platform: "etsy" | "shopify" | "manual" | string;
  name: string;
  className?: string;
}) {
  const mark = platform === "etsy" ? "Et" : platform === "shopify" ? "Sh" : "Mn";
  const tone =
    platform === "etsy"
      ? "bg-amber/10 text-amber"
      : platform === "shopify"
        ? "bg-sage/10 text-sage"
        : "bg-slate/10 text-slate";
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 text-sm text-slate", className)} title={`${name} (${platform})`}>
      <span className={cn("inline-flex h-5 min-w-6 items-center justify-center rounded-chip px-1 text-xs font-semibold", tone)} aria-hidden>
        {mark}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}
