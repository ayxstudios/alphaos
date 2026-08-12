import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { orderShippingAddresses } from "@/lib/db/schema";

export type ShippingAddressInput = {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  phone?: string | null;
  email?: string | null;
  raw?: unknown;
};

export type ShippingAddressVM = ShippingAddressInput & {
  complete: boolean;
};

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function country(value: unknown): string | null {
  const cleaned = clean(value);
  return cleaned ? cleaned.toUpperCase() : null;
}

function splitName(name: string | null): { firstName: string | null; lastName: string | null } {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: parts[0] ?? null, lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function normalizeShippingAddress(input: ShippingAddressInput | null | undefined): ShippingAddressInput | null {
  if (!input) return null;
  const name = clean(input.name);
  const fallback = splitName(name);
  const normalized: ShippingAddressInput = {
    name,
    firstName: clean(input.firstName) ?? fallback.firstName,
    lastName: clean(input.lastName) ?? fallback.lastName,
    company: clean(input.company),
    addressLine1: clean(input.addressLine1),
    addressLine2: clean(input.addressLine2),
    city: clean(input.city),
    state: clean(input.state),
    postalCode: clean(input.postalCode),
    countryCode: country(input.countryCode),
    phone: clean(input.phone),
    email: clean(input.email),
    raw: input.raw,
  };
  return hasAnyShippingAddressValue(normalized) ? normalized : null;
}

export function normalizeShopifyAddress(input: unknown): ShippingAddressInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  return normalizeShippingAddress({
    firstName: clean(raw.firstName),
    lastName: clean(raw.lastName),
    company: clean(raw.company),
    addressLine1: clean(raw.address1),
    addressLine2: clean(raw.address2),
    city: clean(raw.city),
    state: clean(raw.provinceCode) ?? clean(raw.province),
    postalCode: clean(raw.zip),
    countryCode: clean(raw.countryCodeV2) ?? clean(raw.countryCode),
    phone: clean(raw.phone),
    raw,
  });
}

export function normalizeEtsyReceiptAddress(receipt: unknown): ShippingAddressInput | null {
  if (!receipt || typeof receipt !== "object") return null;
  const raw = receipt as Record<string, unknown>;
  return normalizeShippingAddress({
    name: clean(raw.name),
    addressLine1: clean(raw.first_line),
    addressLine2: clean(raw.second_line),
    city: clean(raw.city),
    state: clean(raw.state),
    postalCode: clean(raw.zip),
    countryCode: clean(raw.country_iso),
    email: clean(raw.buyer_email),
    raw: {
      receipt_id: raw.receipt_id,
      has_formatted_address: !!clean(raw.formatted_address),
    },
  });
}

export function hasAnyShippingAddressValue(address: ShippingAddressInput | null | undefined): boolean {
  if (!address) return false;
  return Boolean(
    address.name ||
      address.firstName ||
      address.lastName ||
      address.company ||
      address.addressLine1 ||
      address.addressLine2 ||
      address.city ||
      address.state ||
      address.postalCode ||
      address.countryCode ||
      address.phone ||
      address.email,
  );
}

export function isShippingAddressComplete(address: ShippingAddressInput | null | undefined): boolean {
  if (!address) return false;
  return Boolean(
    (address.name || address.firstName || address.lastName) &&
      address.addressLine1 &&
      address.city &&
      address.postalCode &&
      address.countryCode,
  );
}

export function formatShippingAddress(address: ShippingAddressInput | null | undefined): string[] {
  if (!address) return [];
  const name = address.name ?? [address.firstName, address.lastName].filter(Boolean).join(" ");
  return [
    name || null,
    address.company ?? null,
    address.addressLine1 ?? null,
    address.addressLine2 ?? null,
    [address.city, address.state, address.postalCode].filter(Boolean).join(" ") || null,
    address.countryCode ?? null,
    address.phone ? `Phone: ${address.phone}` : null,
    address.email ? `Email: ${address.email}` : null,
  ].filter((line): line is string => !!line);
}

export async function upsertOrderShippingAddress(
  tx: Tx,
  input: {
    businessId: string;
    orderId: string;
    source: "platform" | "manual";
    address: ShippingAddressInput | null | undefined;
  },
): Promise<void> {
  const address = normalizeShippingAddress(input.address);
  if (!address) return;

  const [existing] = await tx
    .select({ id: orderShippingAddresses.id, source: orderShippingAddresses.source })
    .from(orderShippingAddresses)
    .where(eq(orderShippingAddresses.orderId, input.orderId))
    .limit(1);
  if (existing?.source === "manual" && input.source !== "manual") return;

  const values = {
    businessId: input.businessId,
    orderId: input.orderId,
    source: input.source,
    name: address.name ?? null,
    firstName: address.firstName ?? null,
    lastName: address.lastName ?? null,
    company: address.company ?? null,
    addressLine1: address.addressLine1 ?? null,
    addressLine2: address.addressLine2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postalCode: address.postalCode ?? null,
    countryCode: address.countryCode ?? null,
    phone: address.phone ?? null,
    email: address.email ?? null,
    raw: address.raw,
    updatedAt: new Date(),
  };

  if (existing) {
    await tx.update(orderShippingAddresses).set(values).where(eq(orderShippingAddresses.id, existing.id));
  } else {
    await tx.insert(orderShippingAddresses).values(values);
  }
}
