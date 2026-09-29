import { and, desc, eq, isNull } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import {
  assets,
  businesses,
  orderItems,
  orderShippingAddresses,
  orders,
  printProductMappings,
} from "@/lib/db/schema";
import type { OrderStatus } from "@/lib/orders/transitions";
import { isShippingAddressComplete, type ShippingAddressInput } from "@/lib/shipping/address";
import { matchPrintProductMapping, type PrintMapping, type PrintProvider } from "./mapping";
import { chooseProvider, type RoutingReason } from "./routing";

/**
 * The agent's print order, prepared before anyone taps Submit
 * (docs/AGENT_FIRST.md 3.2). A pure read: nothing is written or cached, so the
 * order page and lib/print/submit.ts always see the current data.
 */

export const PRINT_PROVIDERS: PrintProvider[] = ["lumaprints", "gelato"];

export type PrintBlockerCode =
  | "not_approved"
  | "digital_only"
  | "no_final_file"
  | "unmapped_product"
  | "missing_address"
  | "provider_unavailable";

export type PrintBlocker = { code: PrintBlockerCode; message: string; itemId?: string };

export type PrintFile = {
  assetId: string;
  // Rule: the newest non-deleted asset of type "final" on the order (the
  // file the designer delivered as print-ready). Submissions and references
  // never print; a missing final is a blocker.
  source: "final_asset";
  storage: "cdn" | "r2";
  url: string | null;
  r2Key: string | null;
  name: string;
  uploadedAt: string;
};

export type PrintCost = { unitCost: number | null; currency: string | null; costReason: string | null };

export type PrintPlanOption = PrintCost & {
  provider: PrintProvider;
  mappingId: string;
  providerSku: string;
  label: string | null;
};

export type PrintPlanItem = PrintCost & {
  itemId: string;
  title: string | null;
  sku: string | null;
  product: string | null; // mapping label, else the item title
  productType: string | null; // print product type for routing, e.g. "canvas"
  size: string | null;
  variant: string | null;
  quantity: number;
  provider: PrintProvider;
  routingReason: RoutingReason;
  providerSku: string | null;
  mappingId: string | null;
  providerConfig: Record<string, unknown>;
  options: PrintPlanOption[]; // one per provider that has a mapping for this item
};

export type PrintPlan = {
  orderId: string;
  businessId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  provider: PrintProvider;
  routingReason: RoutingReason;
  requestedProvider: PrintProvider | null;
  // Providers that have a mapping for EVERY physical item (the "Use other" link).
  availableProviders: PrintProvider[];
  file: PrintFile | null;
  address: (ShippingAddressInput & { source: string }) | null;
  items: PrintPlanItem[];
  totalCost: number | null;
  currency: string | null;
  blockers: PrintBlocker[];
  ready: boolean;
};

export const PROVIDER_LABEL: Record<PrintProvider, string> = { lumaprints: "Lumaprints", gelato: "Gelato" };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null;
}

function fileName(url: string | null, r2Key: string | null): string {
  const raw = (url ?? r2Key ?? "").split("?")[0];
  const last = raw.split("/").filter(Boolean).pop();
  return last ? decodeURIComponent(last) : "print file";
}

/**
 * Cost comes from the mapping's providerConfig.unitCost (set in Settings with
 * the price the business pays). Neither provider client has a price-quote call
 * wired, so without it the cost is null and the reason says why.
 */
export function mappingCost(mapping: PrintMapping): PrintCost {
  const config = asRecord(mapping.providerConfig);
  const unit = typeof config.unitCost === "number" ? config.unitCost : Number(config.unitCost);
  if (config.unitCost != null && Number.isFinite(unit) && unit >= 0) {
    return { unitCost: unit, currency: str(config.currency) ?? "USD", costReason: null };
  }
  return {
    unitCost: null,
    currency: null,
    costReason: `No unit cost on the ${PROVIDER_LABEL[mapping.provider]} mapping, and no live price quote is wired for ${PROVIDER_LABEL[mapping.provider]}.`,
  };
}

function sizeFrom(config: Record<string, unknown>, options: Array<{ name: string; value: string }> | null): string | null {
  const configured = str(config.size);
  if (configured) return configured;
  const option = (options ?? []).find((o) => /size|dimension/i.test(o.name));
  return option?.value?.trim() || null;
}

export async function preparePrintOrder(
  orderId: string,
  opts: { tx?: Tx; provider?: PrintProvider | null } = {},
): Promise<PrintPlan | null> {
  if (!opts.tx) return withSystemContext((tx) => preparePrintOrder(orderId, { ...opts, tx }));
  const tx = opts.tx;

  const [order] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      shopId: orders.shopId,
      status: orders.status,
      platformOrderName: orders.platformOrderName,
      platformOrderId: orders.platformOrderId,
      printRouting: businesses.printRouting,
    })
    .from(orders)
    .innerJoin(businesses, eq(businesses.id, orders.businessId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return null;

  const [itemRows, finalAsset, addressRow, mappingRows] = await Promise.all([
    tx
      .select({
        id: orderItems.id,
        sku: orderItems.sku,
        title: orderItems.title,
        variation: orderItems.variation,
        options: orderItems.options,
        productType: orderItems.productType,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId)),
    tx
      .select({
        id: assets.id,
        storage: assets.storage,
        url: assets.url,
        r2Key: assets.r2Key,
        createdAt: assets.createdAt,
      })
      .from(assets)
      .where(and(eq(assets.orderId, orderId), eq(assets.type, "final"), isNull(assets.deletedAt)))
      .orderBy(desc(assets.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    tx
      .select()
      .from(orderShippingAddresses)
      .where(eq(orderShippingAddresses.orderId, orderId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    tx
      .select({
        id: printProductMappings.id,
        provider: printProductMappings.provider,
        matchType: printProductMappings.matchType,
        sourceSku: printProductMappings.sourceSku,
        titleContains: printProductMappings.titleContains,
        variantContains: printProductMappings.variantContains,
        label: printProductMappings.label,
        providerProductId: printProductMappings.providerProductId,
        providerConfig: printProductMappings.providerConfig,
        active: printProductMappings.active,
      })
      .from(printProductMappings)
      .where(and(eq(printProductMappings.shopId, order.shopId), eq(printProductMappings.active, true))),
  ]);

  const blockers: PrintBlocker[] = [];
  const orderNumber = order.platformOrderName ?? order.platformOrderId;
  if (order.status !== "approved") {
    blockers.push({ code: "not_approved", message: `The order is ${order.status.replace(/_/g, " ")}, not approved.` });
  }

  const physical = itemRows.filter((item) => item.productType === "physical");
  if (!physical.length) {
    blockers.push({ code: "digital_only", message: "Digital-only order: nothing to print or ship." });
  }

  const file: PrintFile | null = finalAsset
    ? {
        assetId: finalAsset.id,
        source: "final_asset",
        storage: finalAsset.storage,
        url: finalAsset.url,
        r2Key: finalAsset.r2Key,
        name: fileName(finalAsset.url, finalAsset.r2Key),
        uploadedAt: finalAsset.createdAt.toISOString(),
      }
    : null;
  if (physical.length && !file) {
    blockers.push({ code: "no_final_file", message: "No final print file uploaded yet." });
  }

  const address = addressRow
    ? {
        name: addressRow.name,
        firstName: addressRow.firstName,
        lastName: addressRow.lastName,
        company: addressRow.company,
        addressLine1: addressRow.addressLine1,
        addressLine2: addressRow.addressLine2,
        city: addressRow.city,
        state: addressRow.state,
        postalCode: addressRow.postalCode,
        countryCode: addressRow.countryCode,
        phone: addressRow.phone,
        email: addressRow.email,
        source: addressRow.source,
      }
    : null;
  if (physical.length && !isShippingAddressComplete(address)) {
    blockers.push({
      code: "missing_address",
      message: address
        ? "Shipping address is incomplete (needs name, address line 1, city, postal code, country)."
        : "No shipping address on the order.",
    });
  }

  const mappings = mappingRows as PrintMapping[];
  const perItem = physical.map((item) => {
    const printable = { id: item.id, sku: item.sku, title: item.title, variation: item.variation, productType: item.productType };
    const options: Array<PrintPlanOption & { mapping: PrintMapping }> = PRINT_PROVIDERS.flatMap((provider) => {
      const mapping = matchPrintProductMapping(printable, mappings, provider);
      return mapping
        ? [{ provider, mappingId: mapping.id, providerSku: mapping.providerProductId, label: mapping.label, mapping, ...mappingCost(mapping) }]
        : [];
    });
    const firstConfig = asRecord(options[0]?.mapping.providerConfig);
    const decision = chooseProvider(order, {
      productType: str(firstConfig.productType),
      size: sizeFrom(firstConfig, item.options),
      mappedProviders: options.map((o) => o.provider),
    });
    return { item, options, decision };
  });

  const availableProviders = PRINT_PROVIDERS.filter(
    (provider) => perItem.length > 0 && perItem.every((p) => p.options.some((o) => o.provider === provider)),
  );
  // The whole order ships from one provider: the requested one, else the
  // first item's routing decision (the rule is per business, so items agree
  // unless their mappings differ).
  const first = perItem[0]?.decision ?? chooseProvider(order, {});
  const requested = opts.provider ?? null;
  const provider: PrintProvider = requested ?? first.provider;
  const routingReason: RoutingReason = first.reason;
  if (requested && !availableProviders.includes(requested) && perItem.every((p) => p.options.length)) {
    blockers.push({
      code: "provider_unavailable",
      message: `${PROVIDER_LABEL[requested]} has no mapping for every item on this order.`,
    });
  }

  const items: PrintPlanItem[] = perItem.map(({ item, options, decision }) => {
    const chosen = options.find((o) => o.provider === provider) ?? null;
    const config = asRecord(chosen?.mapping.providerConfig);
    if (!options.length) {
      blockers.push({
        code: "unmapped_product",
        itemId: item.id,
        message: `No print mapping for "${item.title ?? item.sku ?? "item"}"${item.sku && item.sku !== item.title ? ` (SKU ${item.sku})` : ""}. Add one in Settings.`,
      });
    } else if (!chosen && !requested) {
      blockers.push({
        code: "unmapped_product",
        itemId: item.id,
        message: `"${item.title ?? item.sku ?? "item"}" has no ${PROVIDER_LABEL[provider]} mapping.`,
      });
    }
    return {
      itemId: item.id,
      title: item.title,
      sku: item.sku,
      product: chosen?.label ?? item.title,
      productType: str(config.productType),
      size: sizeFrom(config, item.options),
      variant: item.variation,
      quantity: 1,
      provider,
      routingReason: decision.reason,
      providerSku: chosen?.providerSku ?? null,
      mappingId: chosen?.mappingId ?? null,
      providerConfig: config,
      unitCost: chosen?.unitCost ?? null,
      currency: chosen?.currency ?? null,
      costReason: chosen ? chosen.costReason : "No mapping, so no cost.",
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      options: options.map(({ mapping: _mapping, ...rest }) => rest),
    };
  });

  const costs = items.map((i) => i.unitCost);
  const currencies = new Set(items.map((i) => i.currency).filter(Boolean));
  const totalCost =
    items.length && costs.every((c): c is number => c != null) && currencies.size <= 1
      ? Math.round(costs.reduce((sum, c) => sum + c, 0) * 100) / 100
      : null;

  return {
    orderId: order.id,
    businessId: order.businessId,
    orderNumber,
    orderStatus: order.status,
    provider,
    routingReason,
    requestedProvider: requested,
    availableProviders,
    file,
    address,
    items,
    totalCost,
    currency: totalCost != null ? ([...currencies][0] ?? null) : null,
    blockers,
    ready: blockers.length === 0,
  };
}
