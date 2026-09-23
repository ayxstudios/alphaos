/**
 * Neon endpoints the staging scripts must never write to.
 *
 * - ep-sweet-king-azfnjij5: PRODUCTION since 2026-09-24 (Neon project
 *   floral-truth-37733980, aws-ap-southeast-1 Singapore). docs/REGION-MOVE-2026-09-24.md
 * - ep-spring-dawn-audsesft: production until 2026-09-24 (Neon project
 *   raspy-surf-15386736, us-east-1), kept untouched as the rollback copy.
 */
export const PROD_ENDPOINTS = ["ep-sweet-king-azfnjij5", "ep-spring-dawn-audsesft"] as const;

export function isProdHost(hostname: string): boolean {
  return PROD_ENDPOINTS.some((ep) => hostname.includes(ep));
}
