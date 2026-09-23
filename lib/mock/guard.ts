/**
 * Mocks never run on the production deployment (security QA round 2, P2).
 *
 * Before this, MOCK_INTEGRATIONS=1 (the mock transport) or PRINT_PROVIDER_MOCK=1
 * (fake Gelato/Luma answers, including synthetic "shipped" tracking for real
 * order numbers) would have been honoured on production if set there by
 * mistake, and docs/MOCK.md even suggested it. Vercel sets VERCEL_ENV to
 * "production" only on the production deployment; staging is a preview, local
 * and CI runs have no VERCEL_ENV, so every existing mock use keeps working.
 */
export function mocksAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV !== "production";
}
