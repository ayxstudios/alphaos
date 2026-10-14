"use server";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { assets, orders } from "@/lib/db/schema";
import {
  MAX_QC_ATTACHMENTS,
  MAX_QC_ATTACHMENT_BYTES,
  qcFeedbackPrefix,
} from "@/lib/qc/attachments";
import { ALLOWED_IMAGE_TYPES, extFor, isR2Configured, presignGet, presignUpload } from "@/lib/storage/r2";
import { assertKeysBelongTo, assertStoredImage } from "@/lib/uploads/verify";

export type FeedbackPresignResult =
  | { ok: true; uploads: { key: string; uploadUrl: string }[] }
  | { ok: false; message: string };

export type FeedbackRegisterResult =
  | { ok: true; pictures: { assetId: string; key: string; filename: string; url: string | null }[] }
  | { ok: false; message: string };

/** Staff only (VAs and owners fail QC); designers never attach to a fail. */
async function requireReviewer() {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) return null;
  return { id: session.user.id, role };
}

/**
 * Presign direct-to-R2 PUTs for QC fail pictures. Keys are
 * `qc-feedback/<orderId>/<uuid>.<ext>`; nothing exists in the database until
 * registerQcFeedbackUploads confirms the bytes landed.
 */
export async function presignQcFeedbackUploads(input: {
  orderId: string;
  files: { filename: string; contentType: string; size: number }[];
}): Promise<FeedbackPresignResult> {
  const user = await requireReviewer();
  if (!user) return { ok: false, message: "Only VAs and admins can attach pictures." };
  if (!isR2Configured()) return { ok: false, message: "File storage is not configured." };
  if (!input.orderId || !Array.isArray(input.files) || input.files.length === 0) {
    return { ok: false, message: "Nothing to upload." };
  }
  if (input.files.length > MAX_QC_ATTACHMENTS) {
    return { ok: false, message: `Attach at most ${MAX_QC_ATTACHMENTS} pictures.` };
  }
  const [order] = await withUserContext(user, (tx) =>
    tx.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId)).limit(1),
  );
  if (!order) return { ok: false, message: "Order not found." };

  try {
    const uploads = await Promise.all(
      input.files.map(async (file) => {
        if (!ALLOWED_IMAGE_TYPES.test(file.contentType)) throw new Error(`${file.filename}: not a picture`);
        if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size <= 0) {
          throw new Error(`${file.filename}: the file is empty`);
        }
        if (file.size > MAX_QC_ATTACHMENT_BYTES) throw new Error(`${file.filename}: over 20 MB`);
        const key = `${qcFeedbackPrefix(order.id)}${randomUUID()}.${extFor(file.filename, file.contentType)}`;
        return { key, uploadUrl: await presignUpload({ key, contentType: file.contentType }) };
      }),
    );
    return { ok: true, uploads };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not prepare the upload." };
  }
}

/**
 * After the browser PUT: verify the stored bytes really are a picture, then
 * register each as a `qc_feedback` asset of this order. Returns the asset ids
 * the fail will carry.
 */
export async function registerQcFeedbackUploads(input: {
  orderId: string;
  keys: string[];
}): Promise<FeedbackRegisterResult> {
  const user = await requireReviewer();
  if (!user) return { ok: false, message: "Only VAs and admins can attach pictures." };
  const keys = [...new Set((input.keys ?? []).map((k) => String(k).trim()).filter(Boolean))].slice(0, MAX_QC_ATTACHMENTS);
  if (!input.orderId || keys.length === 0) return { ok: false, message: "Nothing to save." };

  try {
    const rows = await withUserContext(user, async (tx) => {
      const [order] = await tx
        .select({ id: orders.id, businessId: orders.businessId })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);
      if (!order) throw new Error("Order not found.");
      assertKeysBelongTo(keys, qcFeedbackPrefix(order.id));
      await Promise.all(keys.map((key) => assertStoredImage(key)));
      return tx
        .insert(assets)
        .values(
          keys.map((r2Key) => ({
            businessId: order.businessId,
            orderId: order.id,
            type: "qc_feedback" as const,
            storage: "r2" as const,
            r2Key,
            uploadedBy: user.id,
          })),
        )
        .returning({ id: assets.id, r2Key: assets.r2Key });
    });
    const pictures = await Promise.all(
      rows.map(async (r) => {
        const key = r.r2Key as string;
        return {
          assetId: r.id,
          key,
          filename: key.split("/").pop() ?? "picture",
          url: await presignGet(key).catch(() => null),
        };
      }),
    );
    return { ok: true, pictures };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not save the picture." };
  }
}
