"use client";

import { useMemo, useState } from "react";

import { deactivatePrintProductMapping, savePrintProductMapping } from "@/app/(app)/settings/actions";
import { Badge, Button, DataPanel, Input, Select, Textarea } from "@/components/ui";
import { Printer, X } from "@/components/ui/icons";

export type PrintProductMappingVM = {
  id: string;
  shopId: string;
  shopName: string;
  provider: "gelato" | "lumaprints";
  matchType: string;
  sourceSku: string | null;
  titleContains: string | null;
  variantContains: string | null;
  label: string | null;
  providerProductId: string;
  providerConfig: unknown;
  active: boolean;
};

export type PrintMappingShopVM = {
  id: string;
  name: string;
  platform: "etsy" | "shopify";
  skuSuggestions: string[];
  titleSuggestions: string[];
};

export function PrintProductMappingsPanel({
  shops,
  mappings,
}: {
  shops: PrintMappingShopVM[];
  mappings: PrintProductMappingVM[];
}) {
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const selectedShop = shops.find((shop) => shop.id === shopId) ?? shops[0] ?? null;
  const byShop = useMemo(() => new Map(shops.map((shop) => [shop.id, shop])), [shops]);

  return (
    <div className="space-y-4">
      <DataPanel className="p-4">
        <div className="mb-4 flex items-center gap-2 font-medium text-ink">
          <Printer size={17} />
          Add print product mapping
        </div>
        {selectedShop ? (
          <form action={savePrintProductMapping} className="grid gap-3 lg:grid-cols-2">
            <Select label="Shop" name="shopId" value={shopId} onChange={(event) => setShopId(event.currentTarget.value)}>
              {shops.map((shop) => (
                <option key={shop.id} value={shop.id}>
                  {shop.name} · {shop.platform}
                </option>
              ))}
            </Select>
            <Select label="Provider" name="provider" defaultValue="lumaprints">
              <option value="lumaprints">Luma Prints</option>
              <option value="gelato">Gelato</option>
            </Select>
            <Select label="Match type" name="matchType" defaultValue="sku_exact">
              <option value="sku_exact">Exact SKU</option>
              <option value="title_variant_contains">Title / variant contains</option>
            </Select>
            <Input name="providerProductId" label="Provider product / SKU" placeholder="Provider SKU or product UID" required />
            <Input name="sourceSku" label="Source SKU" list="print-source-skus" placeholder="Exact SKU from Shopify/Etsy" />
            <Input name="label" label="Label" placeholder="A3 framed print" />
            <Input name="titleContains" label="Title contains" list="print-source-titles" placeholder="A3 Framed Print" />
            <Input name="variantContains" label="Variant contains" placeholder="A3 / framed / matte" />
            <Textarea
              className="lg:col-span-2"
              name="providerConfig"
              label="Provider config JSON"
              placeholder='{"size":"A3","frame":"black"}'
              rows={4}
            />
            <datalist id="print-source-skus">
              {selectedShop.skuSuggestions.map((sku) => (
                <option key={sku} value={sku} />
              ))}
            </datalist>
            <datalist id="print-source-titles">
              {selectedShop.titleSuggestions.map((title) => (
                <option key={title} value={title} />
              ))}
            </datalist>
            <Button type="submit" className="w-fit">
              Save mapping
            </Button>
          </form>
        ) : (
          <p className="text-sm text-slate">No shops are available for this business.</p>
        )}
      </DataPanel>

      <div className="grid gap-3">
        {mappings.length ? (
          mappings.map((mapping) => {
            const shop = byShop.get(mapping.shopId);
            return (
              <DataPanel key={mapping.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-ink">{mapping.label || mapping.providerProductId}</p>
                      <Badge variant={mapping.provider === "lumaprints" ? "info" : "neutral"}>{mapping.provider}</Badge>
                      <Badge variant={mapping.matchType === "sku_exact" ? "success" : "warning"}>
                        {mapping.matchType === "sku_exact" ? "Exact SKU" : "Contains fallback"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-slate">
                      {shop?.name ?? "Unknown shop"} · source{" "}
                      {mapping.matchType === "sku_exact"
                        ? mapping.sourceSku || "missing SKU"
                        : [mapping.titleContains, mapping.variantContains].filter(Boolean).join(" / ")}
                    </p>
                    <p className="mt-1 text-xs text-slate">Provider product: {mapping.providerProductId}</p>
                  </div>
                  <div className="flex gap-2">
                    <form action={deactivatePrintProductMapping}>
                      <input type="hidden" name="mappingId" value={mapping.id} />
                      <Button type="submit" variant="ghost" size="sm" aria-label="Deactivate mapping">
                        <X size={15} />
                      </Button>
                    </form>
                  </div>
                </div>
              </DataPanel>
            );
          })
        ) : (
          <DataPanel className="p-6">
            <p className="font-medium text-ink">No print product mappings yet</p>
            <p className="mt-1 text-sm text-slate">
              Physical products will show as blocked in Ready to Print until their SKU or title/variant rule is mapped.
            </p>
          </DataPanel>
        )}
      </div>
    </div>
  );
}
