/**
 * The common revision issues offered as checkboxes on the customer proof portal.
 *
 * Shared between the customer-facing form (which shows `label`) and the
 * server-side formatting that turns a decision into the revision note that lands
 * on the designer's card — so the wording a customer picks is exactly what the
 * designer reads. `key` is the stable value persisted on `proofs.failed_items`.
 */
export type ProofIssue = { key: string; label: string };

export const PROOF_ISSUES: readonly ProofIssue[] = [
  { key: "eye_colour", label: "Wrong eye colour" },
  { key: "figure_count", label: "Wrong number of figures" },
  { key: "hair", label: "Hair not right" },
  { key: "style", label: "Style not right" },
  { key: "other", label: "Something else" },
] as const;

const ISSUE_KEYS = new Set(PROOF_ISSUES.map((i) => i.key));

/** Keep only recognised issue keys (drops anything a crafted request injects). */
export function sanitizeIssueKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (typeof k === "string" && ISSUE_KEYS.has(k)) seen.add(k);
  }
  // Preserve the canonical display order.
  return PROOF_ISSUES.filter((i) => seen.has(i.key)).map((i) => i.key);
}

/** Human labels for a set of issue keys, in canonical order. */
export function issueLabels(keys: string[]): string[] {
  const set = new Set(keys);
  return PROOF_ISSUES.filter((i) => set.has(i.key)).map((i) => i.label);
}
