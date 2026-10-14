/**
 * Pictures attached to a failed QC (Yousif 2026-10-14). Pure helpers, safe to
 * import from client components (no storage code here; see attachment-urls.ts
 * for the signed links).
 */
export const MAX_QC_ATTACHMENTS = 3;
export const MAX_QC_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB each

/** What qc_checks.attachments stores per picture. */
export type QcAttachment = { assetId: string; key: string; filename: string };

/** A picture ready to show: the stored record plus a link the browser can open. */
export type QcAttachmentView = { assetId: string; filename: string; url: string };

/** The R2 key prefix every picture of one order lives under. */
export function qcFeedbackPrefix(orderId: string): string {
  return `qc-feedback/${orderId}/`;
}

/** Tolerant read of the jsonb column: anything malformed is dropped. */
export function parseAttachments(raw: unknown): QcAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: QcAttachment[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.assetId !== "string" || typeof r.key !== "string") continue;
    out.push({
      assetId: r.assetId,
      key: r.key,
      filename: typeof r.filename === "string" && r.filename ? r.filename : r.key.split("/").pop() ?? "picture",
    });
  }
  return out.slice(0, MAX_QC_ATTACHMENTS);
}
