import { matchesTolerant } from "./figures";

/**
 * Non-portrait / photo-request classification, shared by both integrations.
 *
 * Some orders aren't portrait work: add-on-only orders (a rush upgrade, an extra
 * print) and VA-created Shopify draft orders (invoices/quotes). These must never
 * sit in awaiting_photos, reach a designer, or trigger a photo request. The rules
 * are per-shop config because SKUs/titles vary across 14 shops.
 */

/** Shopify's Order.sourceName for a paid-out draft order (confirmed via API). */
export const SHOPIFY_DRAFT_SOURCE = "shopify_draft_order";

export type ClassifyConfig = {
  /** Exact (case-insensitive) SKUs that are not portrait work. */
  nonPortraitSkus?: string[];
  /** Product-title substrings (tolerant match) that are not portrait work. */
  nonPortraitTitles?: string[];
  /** Whether an awaiting_photos order should auto-request photos. Default is
   *  platform-driven (Etsy true, Shopify false) — see photoRequestEnabled(). */
  photoRequestEnabled?: boolean;
};

export type ClassifiableLine = { sku?: string | null; title?: string | null };

/** True when a line matches the shop's non-portrait SKU or title list. */
export function isNonPortraitLine(line: ClassifiableLine, cfg: ClassifyConfig | null | undefined): boolean {
  const skus = (cfg?.nonPortraitSkus ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (line.sku && skus.includes(line.sku.trim().toLowerCase())) return true;
  for (const t of cfg?.nonPortraitTitles ?? []) {
    if (t.trim() && matchesTolerant(line.title, t)) return true;
  }
  return false;
}

export type OrderClass = "portrait" | "fulfillment_only" | "triage";

/**
 * Classify an order:
 * - Shopify draft order (sourceName) -> `triage` (a VA decides; never inferred).
 * - every real line is non-portrait -> `fulfillment_only`.
 * - otherwise (incl. mixed: any portrait line) -> `portrait`.
 */
export function classifyOrder(input: {
  sourceName?: string | null;
  lines: ClassifiableLine[];
  config: ClassifyConfig | null | undefined;
}): OrderClass {
  if ((input.sourceName ?? "").trim().toLowerCase() === SHOPIFY_DRAFT_SOURCE) return "triage";
  const lines = input.lines;
  if (lines.length > 0 && lines.every((l) => isNonPortraitLine(l, input.config))) return "fulfillment_only";
  return "portrait";
}

/**
 * Whether automated photo-request email is enabled for a shop. Default is FALSE
 * for every shop — no shop sends automated photo requests until an admin turns it
 * on per shop in Settings. The upload link, form, and template stay built, and a
 * VA can still send one manually; this gate only governs the AUTOMATIC send.
 */
export function photoRequestEnabled(cfg: ClassifyConfig | null | undefined): boolean {
  return cfg?.photoRequestEnabled ?? false;
}
