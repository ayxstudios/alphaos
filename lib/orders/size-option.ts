import type { ProductOption } from "@/lib/db/schema";

/**
 * The manual order form's "Size / canvas" field is stored as a structured
 * `{name:"Size", value}` pair in order_items.options, the same place shop
 * imports put the variant's size. The order page, board card, QC "Order says"
 * panel and print hand-off all read options, so a size typed here shows
 * everywhere an imported one does.
 */
const SIZE_NAME = /^\s*(print\s+)?(size|canvas|canvas size|dimensions?)\s*[:：]?\s*$/i;

export function isSizeOption(o: { name?: unknown }): boolean {
  return SIZE_NAME.test(String(o.name ?? ""));
}

/** The size currently held in a list of options ("" when none). */
export function sizeFromOptions(options: ProductOption[] | null | undefined): string {
  const hit = (options ?? []).find((o) => isSizeOption(o) && String(o.value ?? "").trim());
  return hit ? String(hit.value).trim() : "";
}

/**
 * Options with the size set to `size`: replaces an existing size pair in place,
 * appends one when absent, and removes it when `size` is blank. Every other
 * option is kept untouched, in order.
 */
export function withSizeOption(
  options: ProductOption[] | null | undefined,
  size: string | null | undefined,
): ProductOption[] {
  const value = (size ?? "").trim().slice(0, 120);
  const rest = (options ?? []).filter((o) => !isSizeOption(o));
  if (!value) return rest;
  const at = (options ?? []).findIndex((o) => isSizeOption(o));
  const entry: ProductOption = { name: "Size", value };
  if (at < 0) return [...rest, entry];
  const before = (options ?? []).slice(0, at).filter((o) => !isSizeOption(o));
  return [...before, entry, ...rest.slice(before.length)];
}
