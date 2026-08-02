import { randomBytes } from "node:crypto";

/**
 * A single-purpose proof token: 32 bytes (256 bits) of CSPRNG entropy,
 * base64url-encoded. Long enough that guessing or enumerating a valid token is
 * computationally infeasible, so the token itself is the access control for the
 * public proof portal.
 */
export function generateProofToken(): string {
  return randomBytes(32).toString("base64url");
}
