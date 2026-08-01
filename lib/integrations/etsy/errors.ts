/** Refresh/authorization is dead — a human must reconnect the shop. */
export class ReauthRequiredError extends Error {
  constructor(message = "Etsy reauthorization required") {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

/** A non-recoverable Etsy API error (after retries were exhausted). */
export class EtsyApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "EtsyApiError";
  }
}
