/**
 * Absolute URLs for customer-facing links embedded in email. Uses the public
 * app origin (NEXT_PUBLIC_APP_URL), falling back to AUTH_URL, then localhost for
 * dev. Kept trailing-slash-free so path concatenation is predictable.
 */
function appOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

export function appUrl(path: string): string {
  return `${appOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Customer proof portal link for a proof token. */
export function proofUrl(token: string): string {
  return appUrl(`/proof/${token}`);
}

/** Customer photo-upload link for an order's upload token. */
export function uploadUrl(uploadToken: string): string {
  return appUrl(`/upload/${uploadToken}`);
}
