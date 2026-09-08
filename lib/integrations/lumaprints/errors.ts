/** A non-recoverable Luma Prints API error (after retries were exhausted). */
export class LumaPrintsApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "LumaPrintsApiError";
  }
}

/** The stored username/password were rejected. A human must re-enter them. */
export class LumaPrintsAuthError extends LumaPrintsApiError {
  constructor(message = "Luma Prints rejected the credentials") {
    super(401, message);
    this.name = "LumaPrintsAuthError";
  }
}
