// Agent intake parse for Etsy awaiting_details orders (docs/AGENT_FIRST.md).
// Pure: no db. Reads the stored Etsy receipt the same way the VA's "Complete
// order details" page pre-fills its form, and only calls the parse confident
// when every field that form needs comes from a rule, never a guess.

import { resolveFigureCount, resolveStyle } from "@/lib/integrations/etsy/figures";
import { applyStyleFigureDefault } from "@/lib/integrations/figures";
import type { EtsyIntegrationConfig, EtsyTransaction } from "@/lib/integrations/etsy/types";
import { parseEtsyReceiptReview, reviewDefaults } from "@/lib/integrations/etsy/receipt-review";
import { parseFigureCount } from "@/lib/orders/manual-input";
import { emailProblem } from "@/lib/orders/complete-details";

export type IntakeContext = {
  rawImport: unknown;
  shopConfig: EtsyIntegrationConfig | null;
  /** The styles the VA form offers for this shop (shopStyleChoices). */
  styleOptions: string[];
  /** Already on the order (linked customer / saved notes), if any. */
  customerName: string | null;
  customerEmail: string | null;
  orderNotes: string | null;
  /**
   * The business catalog's style for this listing (exact title/SKU match), used
   * only when the shop's own rules name no style. Ignored unless the shop offers it.
   */
  catalogStyle?: string | null;
};

export type IntakeValues = {
  figureCount: number;
  style: string;
  productTitle: string;
  productType: "digital" | "physical";
  notes: string;
  customerName: string;
  /** Empty when nobody has read it off the Etsy order page yet (not a blocker). */
  customerEmail: string;
};

export type IntakeBestGuess = {
  figureCount: number | null;
  figureCountNote: string;
  style: string | null;
  styleNote: string;
  productTitle: string | null;
  productType: "digital" | "physical" | null;
  notes: string | null;
  customerName: string | null;
  customerEmail: string | null;
};

export type IntakeParse =
  | { confident: true; values: IntakeValues; bestGuess: IntakeBestGuess }
  | { confident: false; missing: string[]; bestGuess: IntakeBestGuess };

import { countsInText } from "@/lib/orders/text-counts";

export { countsInText };

export function parseIntake(ctx: IntakeContext): IntakeParse {
  const missing: string[] = [];
  const review = parseEtsyReceiptReview(ctx.rawImport);
  const defaults = reviewDefaults(review);
  const raw = ctx.rawImport as { transactions?: EtsyTransaction[] } | null;
  const transactions = Array.isArray(raw?.transactions) ? raw.transactions : [];

  if (transactions.length === 0) missing.push("line items (the stored Etsy receipt has none)");
  if (transactions.length > 1) {
    missing.push(`line items (${transactions.length} items on one receipt; a person decides how they map to one portrait)`);
  }
  const tx = transactions[0];
  if (tx && typeof tx.quantity === "number" && tx.quantity !== 1) {
    missing.push(`quantity (${tx.quantity} of the same listing)`);
  }

  // Style: the shop's rules, and only a style the shop actually offers.
  const styleRes = tx
    ? resolveStyle(tx.variations ?? [], ctx.shopConfig, tx.title)
    : { style: null, source: "unresolved" as const, note: "no line item" };
  const want = (styleRes.style ?? ctx.catalogStyle ?? "").trim().toLowerCase();
  const style = want ? (ctx.styleOptions.find((s) => s.trim().toLowerCase() === want) ?? null) : null;
  if (!ctx.styleOptions.length) missing.push("style (this shop has no styles configured)");
  else if (!want) missing.push(`style (${styleRes.note})`);
  else if (!style) missing.push(`style ("${styleRes.style ?? ctx.catalogStyle}" is not one of this shop's styles)`);

  // Figure count: only a rule (shop rule, the built-in named-option rule, or
  // the shop's fixed per-style default for subject-less styles).
  const fig = applyStyleFigureDefault(
    tx
      ? resolveFigureCount(tx.variations ?? [], ctx.shopConfig)
      : { count: null, source: "unresolved" as const, note: "no line item" },
    style ?? styleRes.style ?? ctx.catalogStyle,
    ctx.shopConfig,
  );
  let figureCount: number | null = null;
  if (fig.source === "shop_rule" && fig.count != null) {
    const parsed = parseFigureCount(fig.count);
    if (parsed.ok && parsed.value != null) figureCount = parsed.value;
    else missing.push(`figure count (${fig.count} is out of range)`);
  } else {
    missing.push(`figure count (${fig.note})`);
  }

  // The buyer's own words must not contradict the option they picked.
  const freeText = [review.combinedPersonalization, review.buyerNote].filter(Boolean).join("\n");
  const stated = [...new Set(countsInText(freeText))];
  if (figureCount != null && stated.some((n) => n !== figureCount)) {
    missing.push(`figure count (options say ${figureCount} but the buyer's text mentions ${stated.join(", ")})`);
  }

  // Product type: the listing's own digital flag and option values must agree.
  const productType = review.transactions[0]?.fulfillment ?? null;
  if (tx && !productType) missing.push("product type (digital and physical signals conflict or are absent)");

  const productTitle = defaults.productTitle.trim() || null;
  if (!productTitle) missing.push("product title");

  // A missing email never keeps an order off the boards (2026-10-23: two paid
  // CPS orders sat 7 days in awaiting_details on it alone). Etsy's API never
  // gives it; the order completes without one and the email filler links the
  // buyer later (it picks every Etsy order with no customer). Every buyer email
  // send skips an order with no customer. A malformed one still holds the order.
  const customerEmail = (ctx.customerEmail?.trim() || review.buyerEmail?.trim() || "").toLowerCase() || null;
  if (customerEmail && emailProblem(customerEmail)) missing.push(`customer email ("${customerEmail}" does not look right)`);
  const customerName = ctx.customerName?.trim() || review.buyerName?.trim() || null;

  const notes = ctx.orderNotes?.trim() || defaults.notes.trim() || null;

  const bestGuess: IntakeBestGuess = {
    figureCount: figureCount ?? fig.count ?? review.inferredFigureCount ?? stated[0] ?? null,
    figureCountNote: fig.note,
    style: style ?? styleRes.style ?? ctx.catalogStyle ?? null,
    styleNote: styleRes.note,
    productTitle,
    productType: productType ?? (tx ? defaults.productType : null),
    notes,
    customerName,
    customerEmail,
  };

  if (missing.length || figureCount == null || !style || !productType || !productTitle) {
    return { confident: false, missing, bestGuess };
  }
  return {
    confident: true,
    values: {
      figureCount,
      style,
      productTitle,
      productType,
      notes: notes ?? "",
      customerName: customerName ?? "",
      customerEmail: customerEmail ?? "",
    },
    bestGuess,
  };
}
