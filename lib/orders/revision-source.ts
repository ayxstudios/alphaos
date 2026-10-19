export type RevisionSource = "internal_qc" | "customer" | "team";

export function revisionSource(metadata: Record<string, unknown> | null | undefined): RevisionSource {
  if (metadata?.via === "internal_qc_pullback" || metadata?.internalQcPullback === true) return "internal_qc";
  if (metadata?.via === "proof_portal" || typeof metadata?.messageId === "string") return "customer";
  return "team";
}
