/** A non-recoverable Shopify API error (after retries were exhausted). */
export class ShopifyApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ShopifyApiError";
  }
}
