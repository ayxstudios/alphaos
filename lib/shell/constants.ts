/** Cookie holding the active business selection (see loadShellData). */
export const BUSINESS_COOKIE = "alpha_business";

/**
 * Sentinel workspace id for "All Businesses" (admin/VA only — see
 * lib/shell/context.ts). Not a real business row; pages that can't
 * meaningfully aggregate across businesses (Designers, Settings, Styles,
 * Customers, New order) must check for this and prompt the user to pick
 * one specific business instead of querying with it as a real id.
 *
 * Deliberately the plain string "all", not a more decorated sentinel:
 * lib/qc/data.ts (getQcQueueIds) and lib/email/outbox.ts already treat a
 * businessId of exactly "all" as "no business filter" — that support was
 * built ahead of the switcher ever being able to send it. Reusing the
 * same value activates that existing code instead of adding a second,
 * incompatible convention.
 */
export const ALL_BUSINESSES_ID = "all";
