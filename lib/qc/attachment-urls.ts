import { isR2Configured, presignGet } from "@/lib/storage/r2";
import { parseAttachments, type QcAttachmentView } from "./attachments";

/** Seven days is the longest a presigned link can live: long enough for a WhatsApp message read days later. */
export const LOGIN_FREE_LINK_SECONDS = 7 * 24 * 3600;

/**
 * Open-without-login links for the stored pictures of a fail (the bucket stays
 * private; each link is a presigned GET). Pictures that cannot be signed are
 * skipped rather than shown broken.
 */
export async function resolveAttachmentViews(
  raw: unknown,
  expiresIn?: number,
): Promise<QcAttachmentView[]> {
  const list = parseAttachments(raw);
  if (!list.length || !isR2Configured()) return [];
  const views = await Promise.all(
    list.map(async (a) => {
      try {
        return { assetId: a.assetId, filename: a.filename, url: await presignGet(a.key, expiresIn) };
      } catch {
        return null;
      }
    }),
  );
  return views.filter((v): v is QcAttachmentView => v !== null);
}
