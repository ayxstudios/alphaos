/** A non-recoverable Gelato API error (after retries were exhausted). */
export class GelatoApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GelatoApiError";
  }
}

/** The stored API key was rejected. A human must re-enter it in Settings. */
export class GelatoAuthError extends GelatoApiError {
  constructor(message = "Gelato rejected the API key") {
    super(401, message);
    this.name = "GelatoAuthError";
  }
}
