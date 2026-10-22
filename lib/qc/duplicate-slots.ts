/**
 * Two portraits, one file (22 Oct 2026). Designers handed in the very same
 * file for two portraits the buyer asked to be different: Shelby PC32228
 * (Lucille on Blue and on Blush, the blue file twice) and Kara PC32205's first
 * round (Winnie on Purple and on Grass, one file twice). Kara's then went out
 * as two identical frames. The hand-in (in_design -> awaiting_qc) and a QC pass
 * now stop on it.
 *
 * Only a byte-identical file counts: the same picture hashes and size on
 * record, then the same stored size and ETag in R2. The same pet on two
 * background colours hashes alike in grey, so a hash match alone is never
 * called a copy. Across two lines it stops only when a portrait option she set
 * differs (a background, a pet name); copies, a digital file plus its print and
 * lines with no readable options may share a file. Staff who looked send it
 * with a reason (logged on the order); a designer uploads the right file.
 */
import { eq, inArray } from "drizzle-orm";

import type { RequestUser, Tx } from "@/lib/db";
import { activityLog, assets, orderItems, orders } from "@/lib/db/schema";
import { orderNumberOf } from "@/lib/orders/same-buyer";
import { loadProofFilePick } from "@/lib/proofs/files";
import { MIN_OVERRIDE_REASON } from "@/lib/qc/wrong-file";
import { headObject, isR2Configured } from "@/lib/storage/r2";

export const DUPLICATE_SLOTS_OVERRIDE_ACTION = "order.duplicate_slots_override";

export type SlotFile = {
  /** 1-based portrait number. */
  n: number;
  assetId: string;
  /** The order item the portrait slot belongs to (what she asked for). */
  itemId: string | null;
  dhash: string | null;
  fineSig: string | null;
  width: number | null;
  height: number | null;
  /** The item's options, [{ name, value }]. */
  options: { name?: unknown; value?: unknown }[] | null;
};
export type DuplicatePair = { a: SlotFile; b: SlotFile };
export type DuplicateSlotsRefusal = { code: "duplicate_slots"; message: string };
export type StoredHead = { contentLength: number | null; eTag: string | null };

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
/** Options about the product, not the portrait: a digital file and a canvas of the same drawing share one file. */
const FORMAT_RE = /print|size|frame|canvas|poster|format|finish|72 hours|rush|deliver|ship|digital|quantity|add-?on/i;
const optionMap = (o: SlotFile["options"]) =>
  new Map(
    (Array.isArray(o) ? o : [])
      .map((x) => [String(x?.name ?? "").replace(/:+\s*$/, "").trim(), String(x?.value ?? "").trim()] as const)
      .filter(([k]) => k && !FORMAT_RE.test(k)),
  );

/** What she asked for differently on the two portraits: shared portrait options with different values. */
function portraitDifferences(a: SlotFile, b: SlotFile): string[] {
  const ma = optionMap(a.options);
  const mb = optionMap(b.options);
  const out: string[] = [];
  for (const [k, v] of ma) if (mb.has(k) && norm(mb.get(k)) !== norm(v)) out.push(`${k}: ${v} / ${mb.get(k)}`);
  return out;
}

/** Pairs of portraits whose files match on every stored hash and the size (pure; the bytes are confirmed after). */
export function duplicateCandidates(files: SlotFile[]): DuplicatePair[] {
  const out: DuplicatePair[] = [];
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = files[i];
      const b = files[j];
      const same =
        a.assetId === b.assetId ||
        (!!a.dhash && !!a.fineSig && a.dhash === b.dhash && a.fineSig === b.fineSig && a.width === b.width && a.height === b.height);
      if (!same) continue;
      // two portraits of one line are always two drawings; across lines only a portrait option she set differently
      // (a background, a name) says so: copies, a digital file plus its print, or lines we cannot read share a file
      if ((a.itemId && a.itemId === b.itemId) || portraitDifferences(a, b).length) out.push({ a, b });
    }
  }
  return out;
}

/** The same stored object: the same size and ETag. A missing answer is never a match. */
export function sameBytes(x: StoredHead | null, y: StoredHead | null): boolean {
  return !!x && !!y && !!x.eTag && x.eTag === y.eTag && x.contentLength != null && x.contentLength === y.contentLength;
}

/** What she asked for differently on the two portraits, for the message ("Background: Blue / Blush"). */
export function optionDifference(a: SlotFile, b: SlotFile): string | null {
  if (a.itemId && a.itemId === b.itemId) return null;
  const diffs = portraitDifferences(a, b);
  return diffs.length ? diffs.slice(0, 2).join("; ") : null;
}

export function duplicateSlotsMessage(pair: DuplicatePair, orderNumber: string | null, via: "submit" | "qc_pass"): string {
  const head = orderNumber ? `Order ${orderNumber}: ` : "";
  const diff = optionDifference(pair.a, pair.b);
  const what = `portrait ${pair.a.n} and portrait ${pair.b.n} are the same file, but she asked for two different portraits${diff ? ` (${diff})` : ""}.`;
  return via === "submit"
    ? `${head}${what[0].toUpperCase()}${what.slice(1)} Upload the right file for each portrait.`
    : `${head}${what[0].toUpperCase()}${what.slice(1)} Fail it back to the designer, or send it anyway only if you have checked it is right.`;
}

type Deps = { head?: (key: string) => Promise<StoredHead> };

/**
 * The gate a hand-in and a QC pass run: null when every portrait has its own
 * file (or staff gave a reason, logged on the order), else a refusal with the
 * plain message. The agent's own transitions are never stopped here.
 */
export async function duplicateSlotsGate(
  tx: Tx,
  actor: { id: string; role: RequestUser["role"] | "system" },
  input: { orderId: string; businessId: string; overrideReason?: unknown; via: "submit" | "qc_pass" },
  deps: Deps = {},
): Promise<DuplicateSlotsRefusal | null> {
  if (actor.role === "system") return null;
  const pick = await loadProofFilePick(tx, input.orderId);
  if (pick.mode !== "slots" || pick.files.length < 2) return null;
  const ids = [...new Set(pick.files.map((f) => f.assetId))];
  const rows = await tx
    .select({ id: assets.id, dhash: assets.dhash, fineSig: assets.fineSig, width: assets.width, height: assets.height, r2Key: assets.r2Key })
    .from(assets)
    .where(inArray(assets.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const itemIds = [...new Set(pick.files.map((f) => (f.slotKey ? f.slotKey.split(":")[0] : null)).filter((x): x is string => !!x))];
  const items = itemIds.length
    ? await tx.select({ id: orderItems.id, options: orderItems.options }).from(orderItems).where(inArray(orderItems.id, itemIds))
    : [];
  const optionsOf = new Map(items.map((i) => [i.id, (i.options as SlotFile["options"]) ?? null]));
  const files: SlotFile[] = pick.files.map((f) => {
    const r = byId.get(f.assetId);
    const itemId = f.slotKey ? f.slotKey.split(":")[0] : null;
    return {
      n: f.n,
      assetId: f.assetId,
      itemId,
      dhash: r?.dhash ?? null,
      fineSig: r?.fineSig ?? null,
      width: r?.width ?? null,
      height: r?.height ?? null,
      options: itemId ? optionsOf.get(itemId) ?? null : null,
    };
  });
  const candidates = duplicateCandidates(files);
  if (!candidates.length) return null;

  // the bytes decide: a hash match whose stored objects cannot be compared is let through
  const head = deps.head ?? (isR2Configured() ? headObject : null);
  const heads = new Map<string, StoredHead | null>();
  const headOf = async (assetId: string) => {
    if (heads.has(assetId)) return heads.get(assetId) ?? null;
    const key = byId.get(assetId)?.r2Key;
    let h: StoredHead | null = null;
    if (key && head) {
      try {
        h = await head(key);
      } catch {
        h = null;
      }
    }
    heads.set(assetId, h);
    return h;
  };
  let pair: DuplicatePair | null = null;
  for (const c of candidates) {
    if (c.a.assetId === c.b.assetId || sameBytes(await headOf(c.a.assetId), await headOf(c.b.assetId))) {
      pair = c;
      break;
    }
  }
  if (!pair) return null;

  const reason = typeof input.overrideReason === "string" ? input.overrideReason.trim().replace(/\s+/g, " ").slice(0, 500) : "";
  if ((actor.role === "admin" || actor.role === "va") && reason.length >= MIN_OVERRIDE_REASON) {
    await tx.insert(activityLog).values({
      businessId: input.businessId,
      orderId: input.orderId,
      actorId: actor.id,
      action: DUPLICATE_SLOTS_OVERRIDE_ACTION,
      metadata: { reason, via: input.via, portraits: [pair.a.n, pair.b.n], assetIds: [pair.a.assetId, pair.b.assetId] },
    });
    return null;
  }
  const [order] = await tx
    .select({ platformOrderName: orders.platformOrderName, platformOrderId: orders.platformOrderId })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  return { code: "duplicate_slots", message: duplicateSlotsMessage(pair, order ? orderNumberOf(order) : null, input.via) };
}
