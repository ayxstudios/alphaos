import { isNonPortraitLine, type ClassifyConfig } from "@/lib/integrations/classify";

/**
 * The ONE add-on recognizer (2026-10-29). An add-on line rides along with a
 * portrait (Print & Ship, Fast Track, rush, upgrades) and is never a portrait
 * of its own, never a style and never a route. Every reader imports from here.
 *
 * A title opening with an add-on word: "Add-on: Extra Pet", "Rush My Order",
 * "Fast Track My Order", "Upgrade to Canvas", "Priority Processing",
 * "Expedited Processing", "Skip The Line". Anywhere in the title: "Print &
 * Ship", "ADD-ON LISTING", "Fast Track My Order" / "Rush Your Order". A
 * portrait title that only mentions speed ("Pet Portrait, Fast Delivery",
 * "Disney Pet Portrait | Fast Track Available") is not one.
 */
export const ADD_ON_TITLE =
  /^\s*(add[\s-]?on|rush|upgrade|express|priority|fast[\s-]?track|expedited?|skip\s+the\s+(line|queue))\b|\bprint\s*(&|and)\s*ship|\badd[\s-]?on\s+listing\b|\b(fast[\s-]?track|rush|expedite)\s+(my|your)\s+order\b/i;

/** Add-on listings saved as a style row ("Print & Ship My Order"): nothing to draw, never a route. */
export const ADDON_STYLE = /print\s*&\s*ship|add-?on/i;

/** True when a product title is an add-on listing's. Pure. */
export function isAddOnTitle(title: string | null | undefined): boolean {
  return ADD_ON_TITLE.test(title ?? "");
}

/**
 * An add-on line: the shop's non-portrait SKU or title list, the add-on title
 * words, or an add-on style name. Pure.
 */
export function isAddOnItem(
  item: { title?: string | null; sku?: string | null; style?: string | null },
  cfg: ClassifyConfig | null | undefined,
): boolean {
  return isNonPortraitLine({ sku: item.sku, title: item.title }, cfg) || isAddOnTitle(item.title) || ADDON_STYLE.test(item.style ?? "");
}

/**
 * The portrait lines of an order: add-ons left out, but a lone line is always
 * a portrait and an order of nothing but add-ons keeps them all. Pure.
 */
export function portraitLinesOf<T extends { title?: string | null; sku?: string | null; style?: string | null }>(
  items: T[],
  cfg: ClassifyConfig | null | undefined,
): T[] {
  if (items.length < 2) return items;
  const portraits = items.filter((i) => !isAddOnItem(i, cfg));
  return portraits.length ? portraits : items;
}
