import type { Role } from "./config";

/**
 * Designer-side roles: the designer and their helper (a team member who works
 * the designer's board). Both get the designer-safe view of an order (no
 * customer email, scrubbed history) and the designer's limits on uploads and
 * moves. A helper additionally never sees pay (migration 0042 gives them no
 * policy on earnings or rates).
 */
export function isDesignerLike(role: Role | string | null | undefined): role is "designer" | "helper" {
  return role === "designer" || role === "helper";
}

/**
 * The designer whose orders this session acts on: a designer acts as
 * themselves, a helper as the designer they work for (`helperFor`, carried on
 * the JWT). Null for staff, and for a helper with no principal. Ownership checks
 * authorize against this id; audit rows (activity_log.actor_id, assets.uploaded_by)
 * keep the person's OWN id, so the trail shows who really did it.
 */
export function actingDesignerId(user: { id: string; role: Role | string; helperFor?: string | null }): string | null {
  if (user.role === "designer") return user.id;
  if (user.role === "helper") return user.helperFor ?? null;
  return null;
}
