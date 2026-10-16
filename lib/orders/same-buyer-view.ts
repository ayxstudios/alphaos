import { withUserContext, type RequestUser } from "@/lib/db";
import { sizedImageUrl } from "@/lib/images";
import { DEFAULT_SIBLING_LIMIT, isDeliveredLike, loadSameBuyerContext, type ArtworkRef, type SameBuyerContext } from "@/lib/orders/same-buyer";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import { isUuid } from "@/lib/utils";

/**
 * The staff-facing "same buyer" data as a screen draws it (order page, QC,
 * Approve): plain strings only, so it can be handed to a client component.
 * Staff only: it carries the ship-to name and links to the buyer's other
 * orders. Designers get lib/orders/same-buyer.ts's designer-safe sentence.
 */
export type SameBuyerCardOrder = {
  /** AlphaOS order id, or null for an order only the notes name. */
  id: string | null;
  number: string;
  productLine: string | null;
  /** Plain-words stage ("In design", "Buyer approved"). */
  stage: string;
  /** The buyer already has this order's art (approved onward). */
  delivered: boolean;
  cancelled: boolean;
  /** Who a gift ships to, when that is not the buyer. */
  shipTo: string | null;
  /** Small picture of the order's newest artwork, or null. */
  thumb: string | null;
  notInAlphaOS: boolean;
  /** What the notes say about an order AlphaOS does not have. */
  noteHint: string | null;
};

export type SameBuyerView = {
  thisOrder: { id: string; number: string; productLine: string | null; shipToName: string | null };
  others: SameBuyerCardOrder[];
};

async function thumbUrl(a: ArtworkRef | null): Promise<string | null> {
  if (!a) return null;
  if (a.url) return sizedImageUrl(a.url, 160);
  if (a.storage === "r2" && a.r2Key && isR2Configured()) {
    try {
      return await presignGet(a.r2Key);
    } catch {
      return null;
    }
  }
  return null;
}

/** The loaded context as the plain data a screen draws, thumbnails resolved. */
export async function buildSameBuyerView(ctx: SameBuyerContext): Promise<SameBuyerView> {
  const others = await Promise.all(
    ctx.others.map(
      async (o): Promise<SameBuyerCardOrder> => ({
        id: o.id,
        number: o.number,
        productLine: o.productLine,
        stage: o.stage,
        delivered: isDeliveredLike(o.status),
        cancelled: o.status === "cancelled",
        shipTo: o.shipTo,
        thumb: await thumbUrl(o.artwork),
        notInAlphaOS: !!o.notInAlphaOS,
        noteHint: o.noteHint,
      }),
    ),
  );
  return {
    thisOrder: { id: ctx.thisOrder.id, number: ctx.thisOrder.number, productLine: ctx.thisOrder.productLine, shipToName: ctx.thisOrder.shipToName },
    others,
  };
}

/**
 * What a person working an order is shown about the same buyer: this order in
 * a line and the buyer's other orders. One short read in its own connection, so
 * a page can start it beside its other reads. Staff only (anyone else gets
 * null), and it never throws: the screen simply shows nothing if this fails.
 */
export async function getSameBuyerView(
  user: RequestUser,
  orderId: string,
  opts: { limit?: number } = {},
): Promise<SameBuyerView | null> {
  if (user.role !== "admin" && user.role !== "va") return null;
  if (!isUuid(orderId)) return null;
  try {
    const ctx = await withUserContext(user, (tx) =>
      loadSameBuyerContext(tx, orderId, { staff: true, artwork: true, limit: opts.limit ?? DEFAULT_SIBLING_LIMIT }),
    );
    return ctx ? await buildSameBuyerView(ctx) : null;
  } catch (err) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "same_buyer_view_failed",
        orderId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}
