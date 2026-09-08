import { and, eq, inArray, isNull } from "drizzle-orm";

import { withSystemContext, SYSTEM_ACTOR_ID, type Tx } from "@/lib/db";
import { activityLog, assets, businesses, notifications, orderItems, orders, users } from "@/lib/db/schema";
import { runTransition, OrderTransitionError } from "@/lib/orders/transitions";
import { ALLOWED_IMAGE_TYPES, MAX_UPLOAD_BYTES, extFor } from "@/lib/storage/r2";
import { DEV_STORE_PREFIX, headStored, presignPut, usingDevStore } from "./store";

/**
 * Everything the PUBLIC upload page may render. Deliberately minimal (same
 * rule as the proof portal): brand, order number, what we need, and whether
 * photos were already received. Never the customer's email, never internal
 * notes, never another order.
 *
 * The page has no signed-in user, so it runs in the system RLS context; every
 * query is scoped by the unique upload token (or the one order it resolves to).
 */
export type UploadView = {
  businessName: string;
  businessLogoUrl: string | null;
  orderNumber: string;
  /** Plain-English ask, e.g. "Upload 2 clear photos of the people you want drawn". */
  ask: string;
  /** Short helper line under the ask (item names / options), may be empty. */
  detail: string;
  figureCount: number | null;
  /** Reference photos already on the order (from a previous visit or the shop). */
  receivedCount: number;
  /** False once the order is closed; uploads are refused. */
  open: boolean;
  /** True when the store is the local dev fallback (label shown on the page). */
  devStore: boolean;
};

const CLOSED: string[] = ["cancelled", "complete"];
const MAX_FILES = 20;

type OrderRow = {
  id: string;
  businessId: string;
  status: string;
  platformOrderId: string;
  platformOrderName: string | null;
  notes: string | null;
  businessName: string;
  businessLogoUrl: string | null;
};

async function orderByToken(tx: Tx, token: string): Promise<OrderRow | null> {
  if (!token || token.length > 128) return null;
  const [row] = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      status: orders.status,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
      notes: orders.notes,
      businessName: businesses.name,
      businessLogoUrl: businesses.logoUrl,
    })
    .from(orders)
    .innerJoin(businesses, eq(businesses.id, orders.businessId))
    .where(eq(orders.uploadToken, token))
    .limit(1);
  return row ?? null;
}

export async function getUploadView(token: string): Promise<UploadView | null> {
  return withSystemContext(async (tx) => {
    const order = await orderByToken(tx, token);
    if (!order) return null;

    const items = await tx
      .select({ title: orderItems.title, variation: orderItems.variation, figureCount: orderItems.figureCount, options: orderItems.options })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    const received = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.orderId, order.id), eq(assets.type, "reference"), isNull(assets.deletedAt)));

    const { ask, detail, figureCount } = describeAsk(items);
    return {
      businessName: order.businessName,
      businessLogoUrl: order.businessLogoUrl,
      orderNumber: order.platformOrderName ?? order.platformOrderId,
      ask,
      detail,
      figureCount,
      receivedCount: received.length,
      open: !CLOSED.includes(order.status),
      devStore: usingDevStore(),
    };
  });
}

type ItemLite = {
  title: string | null;
  variation: string | null;
  figureCount: number | null;
  options: { name: string; value: string }[] | null;
};

/**
 * Turn the order's items into one plain ask. Figure count comes from the
 * resolved item counts (never guessed); the subject ("people" / "pets") is read
 * from the product title when it is obvious, else the neutral "people or pets".
 */
export function describeAsk(items: ItemLite[]): { ask: string; detail: string; figureCount: number | null } {
  const counts = items.map((i) => i.figureCount).filter((n): n is number => typeof n === "number" && n > 0);
  const figureCount = counts.length === items.length && counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null;
  const text = items.map((i) => `${i.title ?? ""} ${i.variation ?? ""}`).join(" ").toLowerCase();
  const pets = /\b(pet|dog|cat|puppy|kitten|horse|bunny|rabbit)s?\b/.test(text);
  const people = /\b(family|couple|people|person|portrait of you|kids?|child|baby|wedding)\b/.test(text);
  const subject = pets && !people ? "pets" : people && !pets ? "people" : "people or pets";
  const drawnOf = subject === "pets" ? "the pets" : subject === "people" ? "the people" : "each person or pet";

  let ask: string;
  if (figureCount === 1) ask = `Upload 1 clear photo of ${subject === "pets" ? "your pet" : subject === "people" ? "the person" : "the person or pet"} you want drawn`;
  else if (figureCount) ask = `Upload ${figureCount} clear photos of ${drawnOf} you want drawn`;
  else ask = `Upload a clear photo of ${drawnOf} you want drawn`;

  const names = [...new Set(items.map((i) => i.title).filter((t): t is string => !!t))];
  const opts = items
    .flatMap((i) => i.options ?? [])
    .filter((o) => o.name && o.value && !/^(quantity|qty)$/i.test(o.name))
    .map((o) => `${o.name}: ${o.value}`);
  const detail = [names.join(" + "), [...new Set(opts)].slice(0, 4).join(" · ")].filter(Boolean).join(" — ");
  return { ask, detail, figureCount };
}

/* --- presign + save ---------------------------------------------------- */

export type PresignResult =
  | { ok: true; uploads: { key: string; uploadUrl: string; filename: string }[] }
  | { ok: false; message: string };

export type FileMeta = { filename: string; contentType: string; size: number };

export async function presignCustomerUploads(token: string, files: FileMeta[]): Promise<PresignResult> {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, message: "Choose at least one photo." };
  if (files.length > MAX_FILES) return { ok: false, message: `Please upload at most ${MAX_FILES} photos at a time.` };

  const order = await withSystemContext((tx) => orderByToken(tx, token));
  if (!order) return { ok: false, message: "This upload link is not valid." };
  if (CLOSED.includes(order.status)) return { ok: false, message: "This order is closed, so photos can no longer be added." };

  const uploads: { key: string; uploadUrl: string; filename: string }[] = [];
  for (const f of files) {
    const type = normaliseType(f.filename, f.contentType);
    if (!type) return { ok: false, message: `${f.filename}: please choose a JPG, PNG or HEIC photo.` };
    if (typeof f.size !== "number" || f.size <= 0) return { ok: false, message: `${f.filename}: the file is empty.` };
    if (f.size > MAX_UPLOAD_BYTES) return { ok: false, message: `${f.filename}: photos must be under 25 MB.` };
    const key = customerAssetKey(order.businessId, order.id, extFor(f.filename, type));
    uploads.push({ key, uploadUrl: await presignPut({ key, contentType: type }), filename: f.filename });
  }
  return { ok: true, uploads };
}

/** iOS often reports HEIC as an empty type; fill it from the extension. */
export function normaliseType(filename: string, contentType: string): string | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const fromExt: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", webp: "image/webp" };
  const t = (contentType || "").toLowerCase();
  if (ALLOWED_IMAGE_TYPES.test(t)) return t;
  if (ext && fromExt[ext]) return fromExt[ext];
  return null;
}

function customerAssetKey(businessId: string, orderId: string, ext: string): string {
  const base = `${businessId}/${orderId}/reference/${crypto.randomUUID()}.${ext}`;
  return usingDevStore() ? `${DEV_STORE_PREFIX}${base}` : base;
}

export type SaveResult = { ok: true; receivedCount: number; status: string } | { ok: false; message: string };

/**
 * After the browser PUTs succeed: verify each object really landed (size and
 * type read from storage, never the client), create the assets rows, keep the
 * note, and move awaiting_photos -> ready_to_assign THROUGH the state machine.
 * Any other status keeps its state (an Etsy order in awaiting_details still
 * needs a VA to fill the details; a later re-upload is just more references).
 */
export async function saveCustomerUploads(token: string, keys: string[], note: string): Promise<SaveResult> {
  const r2Keys = [...new Set((keys ?? []).map((k) => String(k).trim()).filter(Boolean))].slice(0, MAX_FILES);
  const cleanNote = (note ?? "").toString().trim().slice(0, 2000);
  if (r2Keys.length === 0 && !cleanNote) return { ok: false, message: "Nothing to save yet." };

  try {
    return await withSystemContext(async (tx) => {
      const order = await orderByToken(tx, token);
      if (!order) return { ok: false as const, message: "This upload link is not valid." };
      if (CLOSED.includes(order.status)) return { ok: false as const, message: "This order is closed." };

      const prefix = `${usingDevStore() ? DEV_STORE_PREFIX : ""}${order.businessId}/${order.id}/reference/`;
      if (r2Keys.some((k) => !k.startsWith(prefix))) throw new Error("Upload does not belong to this order.");

      for (const key of r2Keys) {
        const head = await headStored(key);
        if (!head.contentType || !ALLOWED_IMAGE_TYPES.test(head.contentType)) throw new Error("One of the files is not a supported photo.");
        if (!head.contentLength || head.contentLength <= 0 || head.contentLength > MAX_UPLOAD_BYTES) throw new Error("One of the files is over 25 MB.");
      }

      if (r2Keys.length) {
        await tx.insert(assets).values(
          r2Keys.map((r2Key) => ({
            businessId: order.businessId,
            orderId: order.id,
            type: "reference" as const,
            storage: "r2" as const,
            r2Key,
            uploadedBy: null, // the customer, no internal user
          })),
        );
      }
      if (cleanNote) {
        const stamp = new Date().toISOString().slice(0, 10);
        const line = `Customer note (${stamp}): ${cleanNote}`;
        await tx
          .update(orders)
          .set({ notes: order.notes ? `${order.notes}\n\n${line}` : line, updatedAt: new Date() })
          .where(eq(orders.id, order.id));
      }
      await tx.insert(activityLog).values({
        businessId: order.businessId,
        orderId: order.id,
        actorId: null,
        action: "asset.uploaded",
        metadata: { type: "reference", count: r2Keys.length, via: "upload_link", hasNote: !!cleanNote, devStore: usingDevStore() },
      });

      let status = order.status;
      if (order.status === "awaiting_photos" && r2Keys.length) {
        try {
          const res = await runTransition(tx, { id: SYSTEM_ACTOR_ID, role: "system" }, {
            orderId: order.id,
            to: "ready_to_assign",
            expectedFrom: "awaiting_photos",
            metadata: { via: "upload_link", photoCount: r2Keys.length },
          });
          status = res.status;
        } catch (err) {
          // A stale/illegal transition must not lose the customer's photos: the
          // assets are already in this tx; surface it to staff instead.
          if (!(err instanceof OrderTransitionError)) throw err;
          await notifyStaff(tx, order, `Photos arrived but the order could not move on automatically (${err.message}).`);
        }
      } else {
        // Nothing moves automatically here (awaiting_details / already in the
        // pipeline); tell the VAs new photos arrived.
        await notifyStaff(tx, order, `${r2Keys.length} new photo${r2Keys.length === 1 ? "" : "s"}${cleanNote ? " and a note" : ""} from the customer.`);
      }

      const received = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.orderId, order.id), eq(assets.type, "reference"), isNull(assets.deletedAt)));
      return { ok: true as const, receivedCount: received.length, status };
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Could not save your photos. Please try again." };
  }
}

async function notifyStaff(tx: Tx, order: OrderRow, body: string): Promise<void> {
  const staff = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.role, ["admin", "va"]), eq(users.active, true)));
  if (!staff.length) return;
  await tx.insert(notifications).values(
    staff.map((s) => ({
      businessId: order.businessId,
      userId: s.id,
      type: "customer.photos_received",
      orderId: order.id,
      title: `Photos received for ${order.platformOrderName ?? order.platformOrderId}`,
      body,
      href: `/orders/${order.id}`,
    })),
  );
}
