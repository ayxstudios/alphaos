// Stored in businesses.print_routing (migration 0044). Type-only module so
// lib/db/schema.ts can import it without pulling in runtime code.
export type PrintRoutingProvider = "lumaprints" | "gelato";

export type PrintRoutingOverride = {
  productType?: string; // e.g. "canvas", matched case-insensitively
  size?: string; // e.g. "8x10", matched ignoring spaces and case
  provider: PrintRoutingProvider;
};

export type PrintRoutingRule = {
  default?: PrintRoutingProvider;
  overrides?: PrintRoutingOverride[];
};
