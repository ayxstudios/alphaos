export type RevisionSource = "internal_qc" | "customer" | "team";

export function revisionSource(metadata: Record<string, unknown> | null | undefined): RevisionSource {
  if (metadata?.via === "internal_qc_pullback" || metadata?.internalQcPullback === true) return "internal_qc";
  // Older UI pullbacks used va_created_revision. Their saved note is the only
  // provenance marker, so honor the explicit prefix on those existing events.
  const reason = typeof metadata?.revisionReason === "string" ? metadata.revisionReason.trim() : "";
  if (/^INTERNAL QC\b/i.test(reason)) return "internal_qc";
  if (metadata?.via === "proof_portal" || typeof metadata?.messageId === "string") return "customer";
  return "team";
}
