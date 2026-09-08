import type { PrintProvider } from "@/lib/print/mapping";

/**
 * Normalized shape both provider clients (Gelato, Luma Prints) reduce their own
 * response formats to, so lib/print/reconcile.ts never branches on provider.
 */
export type NormalizedFulfillmentStatus =
  | "created" // accepted by the provider, not yet in production
  | "printed" // produced, not yet handed to a carrier
  | "shipped" // has at least one tracking number
  | "delivered" // carrier confirms delivery
  | "failed" // provider could not fulfil it (art rejected, payment, etc.)
  | "canceled";

export type NormalizedShipment = {
  trackingNumber: string;
  carrier: string | null;
  trackingUrl: string | null;
  shippedAt: string | null; // ISO date, when the provider says
};

export type NormalizedProviderOrder = {
  provider: PrintProvider;
  providerOrderId: string; // the provider's own id/order number
  referenceId: string | null; // our order number/reference, as the provider has it
  status: NormalizedFulfillmentStatus;
  rawStatus: string; // provider's own status word, for display + logging
  reason: string | null; // failure/cancellation reason, if any
  shipments: NormalizedShipment[];
  raw: unknown; // full provider payload, kept for providerResponse/providerPayload columns
};

/** What lib/print/reconcile.ts asks each provider client to do. */
export interface PrintProviderClient {
  readonly provider: PrintProvider;
  /**
   * Find the provider's order that matches our own order number/reference
   * (the value the VA types or pastes into the provider's dashboard as the
   * order name/reference when triggering print). Returns null when nothing
   * matches - the caller treats that as "not sent yet" or "missing".
   */
  findByReference(referenceId: string, window: { since: Date }): Promise<NormalizedProviderOrder | null>;
  /** Direct lookup by the provider's own order id, when we already have one. */
  getOrder(providerOrderId: string): Promise<NormalizedProviderOrder | null>;
}

export class PrintProviderError extends Error {
  provider: PrintProvider;
  status: number | null;
  constructor(provider: PrintProvider, message: string, status: number | null = null) {
    super(message);
    this.name = "PrintProviderError";
    this.provider = provider;
    this.status = status;
  }
}

/** Credentials never configured for this business/provider. */
export class ProviderNotConfiguredError extends PrintProviderError {
  constructor(provider: PrintProvider) {
    super(provider, `${provider} is not configured for this business`);
    this.name = "ProviderNotConfiguredError";
  }
}
