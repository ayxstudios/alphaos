export type PrintProvider = "gelato" | "lumaprints";

export type PrintMapping = {
  id: string;
  provider: PrintProvider;
  matchType: string;
  sourceSku: string | null;
  titleContains: string | null;
  variantContains: string | null;
  label: string | null;
  providerProductId: string;
  providerConfig: unknown;
  active: boolean;
};

export type PrintableItem = {
  id: string;
  sku: string | null;
  title: string | null;
  variation: string | null;
  productType: "digital" | "physical";
};

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function exactSku(item: PrintableItem, mapping: PrintMapping): boolean {
  return !!item.sku && norm(item.sku) === norm(mapping.sourceSku);
}

function containsRule(item: PrintableItem, mapping: PrintMapping): boolean {
  const titleNeedle = norm(mapping.titleContains);
  const variantNeedle = norm(mapping.variantContains);
  if (!titleNeedle && !variantNeedle) return false;
  const titleOk = !titleNeedle || norm(item.title).includes(titleNeedle);
  const variantOk = !variantNeedle || norm(item.variation).includes(variantNeedle);
  return titleOk && variantOk;
}

export function matchPrintProductMapping(
  item: PrintableItem,
  mappings: PrintMapping[],
  provider?: PrintProvider,
): PrintMapping | null {
  const active = mappings.filter((mapping) => mapping.active && (!provider || mapping.provider === provider));
  const skuMatch = active.find((mapping) => mapping.matchType === "sku_exact" && exactSku(item, mapping));
  if (skuMatch) return skuMatch;
  return (
    active.find((mapping) => mapping.matchType === "title_variant_contains" && containsRule(item, mapping)) ??
    null
  );
}

export function defaultPrintProvider(countryCode: string | null | undefined): PrintProvider {
  return norm(countryCode) === "us" ? "lumaprints" : "gelato";
}
