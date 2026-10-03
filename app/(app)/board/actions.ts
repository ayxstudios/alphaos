"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { actingDesignerId, isDesignerLike } from "@/lib/auth/roles";
import { withUserContext, type RequestUser, type Tx } from "@/lib/db";
import { activityLog, assets, assignments, orders } from "@/lib/db/schema";
import {
  transition,
  runTransition,
  OrderTransitionError,
  type OrderStatus,
} from "@/lib/orders/transitions";
import {
  getCardDetail,
  addComment,
  type CardDetail,
  type CardEvent,
} from "@/lib/orders/card-detail";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  assetKey,
  extFor,
  isR2Configured,
  presignUpload,
} from "@/lib/storage/r2";
import { assertKeysBelongTo, assertStoredImage } from "@/lib/uploads/verify";

export type MoveResult =
  | { ok: true; status: OrderStatus }
  | { ok: false; code: string; message: string };

/**
 * Move an order through the state machine. Every board drag / queue action calls
 * this — it's the single server entry point; `transition()` is the only writer of
 * orders.status. Returns a result object (never throws to the client) so the
 * board can revert the optimistic move and toast.
 */
export async function moveOrder(
  orderId: string,
  to: OrderStatus,
  expectedFrom: OrderStatus,
  metadata?: Record<string, unknown>,
): Promise<MoveResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, code: "auth", message: "Not signed in" };
  const user = { id: session.user.id, role: session.user.role };

  try {
    const { status } = await transition(user, { orderId, to, expectedFrom, metadata });
    revalidatePath("/board");
    revalidatePath("/orders");
    return { ok: true, status };
  } catch (err) {
    if (err instanceof OrderTransitionError) {
      // The internal not-found text carries the order UUID and RLS wording;
      // the person gets the plain version.
      const message = err.code === "not_found" ? "Order not found. It may have been moved or reassigned." : err.message;
      return { ok: false, code: err.code, message };
    }
    throw err;
  }
}

/** Lazy-load a card's history feed + images when its modal opens. */
export async function loadCard(orderId: string): Promise<CardDetail> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in");
  const user = { id: session.user.id, role: session.user.role };
  return getCardDetail(user, orderId);
}

export type CommentResult =
  | { ok: true; event: CardEvent }
  | { ok: false; message: string };

export type CardAssetType = "reference" | "submission" | "final";

export type CardUploadPresignResult =
  | { ok: true; uploads: { key: string; uploadUrl: string }[] }
  | { ok: false; message: string };

export type CardUploadSaveResult =
  | { ok: true; detail: CardDetail }
  | { ok: false; message: string };

type CardActor = RequestUser & { helperFor?: string | null };

function requireSignedIn(): Promise<CardActor | { error: string }> {
  return auth().then((session) => {
    if (!session?.user) return { error: "Not signed in" };
    return { id: session.user.id, role: session.user.role, helperFor: session.user.helperFor ?? null };
  });
}

/**
 * A designer, or a helper working for one, may only touch orders actively
 * assigned to the designer they act as (a helper acts as `helperFor`). RLS
 * (migration 0042) enforces the same line; this is the explicit second check
 * for the upload paths. Staff pass through. The audit rows keep the person's
 * own id.
 */
async function assertActsOnOrder(tx: Tx, user: CardActor, orderId: string): Promise<void> {
  if (!isDesignerLike(user.role)) return;
  const designerId = actingDesignerId(user);
  if (!designerId) throw new Error("Order not found");
  const [owned] = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.orderId, orderId), eq(assignments.designerId, designerId), eq(assignments.active, true)))
    .limit(1);
  if (!owned) throw new Error("Order not found");
}

function validAssetType(type: string): type is CardAssetType {
  return type === "reference" || type === "submission" || type === "final";
}

/** Post a team comment (admin / VA / designer) onto a card's history. */
export async function postComment(orderId: string, body: string): Promise<CommentResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, message: "Not signed in" };
  const text = body.trim();
  if (!text) return { ok: false, message: "Message is empty" };
  if (text.length > 5000) return { ok: false, message: "Message is too long" };
  const user = { id: session.user.id, role: session.user.role };
  let event: CardEvent;
  try {
    event = await addComment(user, orderId, text);
  } catch {
    // Not visible to this user (RLS) or gone: a calm denial, never a 500.
    return { ok: false, message: "Order not found" };
  }
  revalidatePath("/board");
  return { ok: true, event };
}

/** Presign direct-to-R2 uploads from a board card. Staff and assigned designers are scoped by RLS. */
export async function presignCardAssetUploads(input: {
  orderId: string;
  type: CardAssetType;
  files: { filename: string; contentType: string; size: number }[];
}): Promise<CardUploadPresignResult> {
  const user = await requireSignedIn();
  if ("error" in user) return { ok: false, message: user.error };
  if (!validAssetType(input.type)) return { ok: false, message: "Choose a valid upload type" };
  if (!isR2Configured()) return { ok: false, message: "File storage is not configured" };
  if (!input.orderId || !Array.isArray(input.files) || input.files.length === 0) {
    return { ok: false, message: "Nothing to upload" };
  }
  if (input.files.length > 20) return { ok: false, message: "Too many files (max 20)" };

  const [order] = await withUserContext(user, (tx) =>
    tx
      .select({ businessId: orders.businessId, status: orders.status })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1),
  );
  if (!order) return { ok: false, message: "Order not found" };
  try {
    await withUserContext(user, (tx) => assertActsOnOrder(tx, user, input.orderId));
  } catch {
    return { ok: false, message: "Order not found" };
  }
  if (isDesignerLike(user.role) && input.type !== "submission") {
    return { ok: false, message: "Designers can only upload finished portraits." };
  }
  if (isDesignerLike(user.role) && order.status !== "in_design") {
    return { ok: false, message: "Finished portraits can only be uploaded while the card is in design." };
  }

  try {
    const uploads = await Promise.all(
      input.files.map(async (file) => {
        if (!ALLOWED_IMAGE_TYPES.test(file.contentType)) {
          throw new Error(`${file.filename}: not an image`);
        }
        if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size <= 0) {
          throw new Error(`${file.filename}: the file is empty`);
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error(`${file.filename}: over 25 MB`);
        }
        const key = assetKey(order.businessId, input.orderId, input.type, extFor(file.filename, file.contentType));
        return { key, uploadUrl: await presignUpload({ key, contentType: file.contentType }) };
      }),
    );
    return { ok: true, uploads };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not prepare upload" };
  }
}

/** Persist board-card uploads after the browser PUT succeeds, then return fresh modal data. */
export async function saveCardAssetUploads(input: {
  orderId: string;
  type: CardAssetType;
  r2Keys: string[];
}): Promise<CardUploadSaveResult> {
  const user = await requireSignedIn();
  if ("error" in user) return { ok: false, message: user.error };
  if (!validAssetType(input.type)) return { ok: false, message: "Choose a valid upload type" };
  const r2Keys = [...new Set((input.r2Keys ?? []).map((key) => key.trim()).filter(Boolean))].slice(0, 20);
  if (!input.orderId || r2Keys.length === 0) return { ok: false, message: "Nothing to save" };

  try {
    await withUserContext(user, async (tx) => {
      const [order] = await tx
        .select({ id: orders.id, businessId: orders.businessId, status: orders.status })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .for("update")
        .limit(1);
      if (!order) throw new Error("Order not found");
      await assertActsOnOrder(tx, user, order.id);
      assertKeysBelongTo(r2Keys, `${order.businessId}/${order.id}/${input.type}/`);
      if (isDesignerLike(user.role) && input.type !== "submission") {
        throw new Error("Designers can only upload finished portraits");
      }
      if (isDesignerLike(user.role) && order.status !== "in_design") {
        throw new Error("Finished portraits can only be uploaded while the card is in design");
      }

      // Type, size and the bytes themselves (a .png that is really HTML is refused).
      await Promise.all(r2Keys.map((key) => assertStoredImage(key)));

      await tx.insert(assets).values(
        r2Keys.map((r2Key) => ({
          businessId: order.businessId,
          orderId: order.id,
          type: input.type,
          storage: "r2" as const,
          r2Key,
          uploadedBy: user.id,
        })),
      );

      await tx.insert(activityLog).values({
        businessId: order.businessId,
        orderId: order.id,
        actorId: user.id,
        action: "asset.uploaded",
        metadata: { type: input.type, count: r2Keys.length },
      });

      if (!isDesignerLike(user.role) && input.type === "reference" && order.status === "awaiting_photos") {
        await runTransition(tx, user, {
          orderId: order.id,
          to: "ready_to_assign",
          expectedFrom: "awaiting_photos",
          metadata: { via: "card_reference_upload", photoCount: r2Keys.length },
        });
      }
    });
  } catch (error) {
    if (error instanceof OrderTransitionError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : "Could not save upload" };
  }

  revalidatePath("/board");
  revalidatePath("/orders");
  revalidatePath(`/orders/${input.orderId}`);
  return { ok: true, detail: await getCardDetail(user, input.orderId) };
}
