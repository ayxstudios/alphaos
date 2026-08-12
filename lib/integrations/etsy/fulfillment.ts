import { EtsyClient } from "./client";
import type { EtsyCredentials } from "./types";

export type EtsyShipmentResult = {
  receiptId: string;
  response: unknown;
};

function carrierName(value: string | undefined): string | null {
  const cleaned = value?.trim();
  if (!cleaned) return null;
  const key = cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string> = {
    usps: "usps",
    ups: "ups",
    fedex: "fedex",
    dhl: "dhl",
    dhlexpress: "dhl",
    canadapost: "canada-post",
    australiapost: "australia-post",
    auspost: "australia-post",
  };
  return aliases[key] ?? cleaned;
}

export async function createEtsyReceiptShipment(args: {
  shopId: string;
  businessId: string;
  etsyShopId: string;
  receiptId: string;
  credentials: EtsyCredentials;
  trackingNumber: string;
  trackingCompany?: string;
}): Promise<EtsyShipmentResult> {
  const company = carrierName(args.trackingCompany);
  if (!company) throw new Error("Etsy shipment writeback requires a carrier.");
  if (!/^\d+$/.test(args.etsyShopId)) throw new Error("Etsy shipment writeback requires a numeric Etsy shop id.");

  const client = new EtsyClient(args.shopId, args.businessId, args.credentials);
  const response = await client.apiPostForm(
    `/shops/${args.etsyShopId}/receipts/${args.receiptId}/tracking`,
    {
      tracking_code: args.trackingNumber,
      carrier_name: company,
      send_bcc: false,
    },
  );

  return { receiptId: args.receiptId, response };
}
