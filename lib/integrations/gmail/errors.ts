/** Typed errors for the Gmail integration (mirrors the Etsy/Shopify clients). */

export class GmailApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GmailApiError";
  }
}

/**
 * The refresh token is dead / consent revoked / client mis-provisioned — no
 * automatic recovery. An admin must re-run the OAuth connect flow. Surfaced to
 * admins via a notification, exactly like the Etsy client's reauth path.
 */
export class GmailReauthRequiredError extends Error {
  constructor(message = "Gmail re-authentication required") {
    super(message);
    this.name = "GmailReauthRequiredError";
  }
}

/** Gmail was never connected for this business. */
export class GmailNotConnectedError extends Error {
  constructor(businessId: string) {
    super(`Gmail is not connected for business ${businessId}`);
    this.name = "GmailNotConnectedError";
  }
}
