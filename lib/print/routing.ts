import type { PrintProvider } from "./mapping";
import type { PrintRoutingOverride, PrintRoutingRule } from "./routing-types";

export type { PrintRoutingOverride, PrintRoutingRule } from "./routing-types";

/**
 * Which print provider an item goes to (docs/AGENT_FIRST.md 3.2). Order of
 * precedence:
 *   1. only one provider has a mapping for the item -> that one ("only mapping")
 *   2. the first override whose productType/size both match -> "override"
 *   3. the business default, else Lumaprints -> "default"
 * Pure: the caller passes the business's print_routing and the mapped providers.
 */
export type RoutingReason = "default" | "override" | "only mapping";

export type RoutingDecision = {
  provider: PrintProvider;
  reason: RoutingReason;
  override: PrintRoutingOverride | null;
};

export type RoutingItem = {
  productType?: string | null;
  size?: string | null;
  // Providers that have an active mapping for this item (lib/print/mapping.ts).
  mappedProviders?: PrintProvider[];
};

export const DEFAULT_PRINT_PROVIDER: PrintProvider = "lumaprints";

function isProvider(value: unknown): value is PrintProvider {
  return value === "lumaprints" || value === "gelato";
}

export function normalizeSize(size: string | null | undefined): string | null {
  const s = String(size ?? "").toLowerCase().replace(/\s+/g, "").replace(/["']|in(ch(es)?)?/g, "").replace(/×/g, "x");
  return s || null;
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** Parse whatever is in businesses.print_routing into a safe rule. */
export function parsePrintRouting(raw: unknown): Required<PrintRoutingRule> {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const overrides = Array.isArray(obj.overrides)
    ? (obj.overrides as unknown[]).flatMap((o): PrintRoutingOverride[] => {
        if (!o || typeof o !== "object") return [];
        const r = o as Record<string, unknown>;
        if (!isProvider(r.provider)) return [];
        return [
          {
            provider: r.provider,
            ...(typeof r.productType === "string" && r.productType.trim() ? { productType: r.productType } : {}),
            ...(typeof r.size === "string" && r.size.trim() ? { size: r.size } : {}),
          },
        ];
      })
    : [];
  return { default: isProvider(obj.default) ? obj.default : DEFAULT_PRINT_PROVIDER, overrides };
}

export function overrideMatches(override: PrintRoutingOverride, item: RoutingItem): boolean {
  // An override with neither field would swallow everything; the default does that job.
  if (!override.productType && !override.size) return false;
  if (override.productType && !sameText(override.productType, item.productType)) return false;
  if (override.size && normalizeSize(override.size) !== normalizeSize(item.size)) return false;
  return true;
}

export function chooseProvider(business: { printRouting?: unknown }, item: RoutingItem): RoutingDecision {
  const mapped = Array.from(new Set(item.mappedProviders ?? []));
  if (mapped.length === 1) return { provider: mapped[0], reason: "only mapping", override: null };

  const rule = parsePrintRouting(business.printRouting);
  const override = rule.overrides.find((o) => overrideMatches(o, item));
  if (override) return { provider: override.provider, reason: "override", override };
  return { provider: rule.default, reason: "default", override: null };
}

export function routingReasonLabel(reason: RoutingReason): string {
  if (reason === "override") return "routing override";
  if (reason === "only mapping") return "only provider mapped";
  return "business default";
}
