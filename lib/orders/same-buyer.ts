import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import {
  activityLog,
  assets,
  customers,
  orderItems,
  orderShippingAddresses,
  orders,
  type ProductOption,
} from "@/lib/db/schema";
import { buildPortraitSlots } from "@/lib/orders/portraits";
import { sizeFromOptions } from "@/lib/orders/size-option";
import { stageWithRound } from "@/lib/orders/stage-timeline";
import { styleLabel } from "@/lib/utils";

/**
 * One buyer, several orders (incident 16 Oct 2026: a buyer's second PixArt
 * order was drawn and proofed with the first order's two-dog file because
 * nobody working on it was told the buyer had another order).
 *
 * This is the single place that answers "what else did this buyer order?":
 * the order page, QC, Approve, the designer brief and board, and the reply
 * agent all read it. Never matched on a name alone: the same customer row, the
 * same email (case and spaces ignored), the same Etsy buyer id for Etsy orders
 * that have no customer row, or an order number the notes themselves name.
 */

/** How many other orders a surface lists unless it asks for more. */
export const DEFAULT_SIBLING_LIMIT = 8;
/** Safety cap on joined rows (orders x lines) read per anchor in one query. */
const ROWS_PER_ANCHOR = 60;

// ---------------------------------------------------------------------------
// Pure helpers (no database): order numbers, product lines, wording
// ---------------------------------------------------------------------------

/** The order number every screen shows: the shop's name for it, else the platform id. */
export function orderNumberOf(o: { platformOrderName: string | null; platformOrderId: string }): string {
  return o.platformOrderName?.trim() || o.platformOrderId;
}

/**
 * A comparable form of an order number: "#cps10282" -> "CPS10282",
 * "LEGACY-3933552614-B" -> "3933552614". The SQL twin is KEY_SQL below; keep
 * the two in step.
 */
export function orderNumberKey(number: string): string {
  return number.trim().toUpperCase().replace(/^(#|LEGACY-)|-[A-Z]$/g, "");
}

const KEY_SQL = sql<string>`upper(regexp_replace(btrim(coalesce(nullif(${orders.platformOrderName}, ''), ${orders.platformOrderId})), '^(#|LEGACY-)|-[A-Za-z]$', '', 'gi'))`;

/** Statuses where the buyer already has the finished art (approved onward). */
const DELIVERED_LIKE = new Set(["approved", "printing", "shipped", "delivered", "complete"]);

export function isDeliveredLike(status: string | null | undefined): boolean {
  return !!status && DELIVERED_LIKE.has(status);
}

/** The platform's stable buyer id from an Etsy receipt; null for anything unusable. */
export function buyerUserIdOf(raw: unknown): string | null {
  const v = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  return v && v !== "0" && v.toLowerCase() !== "null" ? v : null;
}

export type NoteMention = {
  /** The number in the form the shop shows it ("PC32131", "#CPS10282", "4201339918"). */
  number: string;
  key: string;
  shape: "pc" | "cps" | "etsy" | "other";
  /** Certain enough to list even when AlphaOS has no such order. */
  strong: boolean;
  /** What the notes say about it ("Parker & Saiya together, landscape"), or null. */
  hint: string | null;
};

const MENTION_RE = /(?<![A-Za-z0-9])(?:#?CPS(\d{4,7})|PC(\d{4,7})|(\d{10}))(?![A-Za-z0-9])/gi;
const CUE_RE =
  /\b(also|same\s+(?:customer|buyer|person)|other\s+order|another\s+order|previous\s+order|earlier\s+order|first\s+order|second\s+order|bought|ordered|purchased)\b/i;
const HINT_RE = /^\s*(?:=|:|\(|[-\u2013\u2014]\s)\s*([^\n:;.)]{3,80})/;

/** A hint is plain words about the product; anything that looks like contact data is dropped. */
function cleanHint(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 3 || /@|https?:|www\.|\d{5,}/i.test(t)) return null;
  return t.length > 80 ? `${t.slice(0, 79).trimEnd()}\u2026` : t;
}

/**
 * Order numbers a block of notes names, other than the order's own. PixArt
 * (PC32131) and CPS (#CPS10282) shapes are certain; an Etsy receipt (a 10-digit
 * 3xxxxxxxxx / 4xxxxxxxxx) only counts without an order in AlphaOS when a cue
 * word ("also", "same customer", "bought") comes just before it, because the
 * 17xxxxxxxx numbers in notes are usually Etsy conversation ids.
 */
export function orderNumbersMentioned(notes: string | null | undefined, ownNumber: string): NoteMention[] {
  const text = notes ?? "";
  if (!text) return [];
  const ownKey = orderNumberKey(ownNumber);
  const ownDigits = new Set(ownNumber.match(/\d{6,}/g) ?? []);
  const out: NoteMention[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const [whole, cps, pc, ten] = m;
    const number = cps ? `#CPS${cps}` : pc ? `PC${pc}` : ten;
    const key = orderNumberKey(number);
    if (key === ownKey || ownDigits.has(key) || seen.has(key)) continue;
    const shape = cps ? "cps" : pc ? "pc" : /^[34]/.test(ten) ? "etsy" : "other";
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 60), at);
    const strong = shape === "cps" || shape === "pc" || (shape === "etsy" && CUE_RE.test(before));
    const after = text.slice(at + whole.length, at + whole.length + 140);
    const found = HINT_RE.exec(after);
    // A capture that stops at "https" is the front of a link, not a hint.
    const hint = found && !after.slice(found[0].length).startsWith("://") ? cleanHint(found[1]) : null;
    seen.add(key);
    out.push({ number, key, shape, strong, hint });
  }
  return out;
}

/** One order line as far as the product line needs it. */
export type LineItem = {
  title: string | null;
  variation?: string | null;
  sku?: string | null;
  options: ProductOption[] | null;
  figureCount: number | null;
  style: string | null;
  quantity?: number | null;
};

const MAX_TITLE = 56;
const PRINT_ON_NAME = /^\s*print\s*on\s*:?\s*$/i;
const MUG_SIZE_NAME = /^\s*mug\s*size\s*:?\s*$/i;
const ORIENTATION_NAME = /orientation|layout/i;
const ORIENTATION_VALUE = /\b(landscape|portrait|square|vertical|horizontal)\b/i;
const COUNT_NAME = /^\s*number\s+of\s+(?:pets?|people|persons?|figures?|children|kids)(?:\s*\/\s*(?:pets?|people|persons?|figures?))?\s*:?\s*$/i;
const NAMES_NAME = /^\s*(?:pet|people|person|child|children|kid|kids|dog|cat)?\s*names?\s*(?:\(s\))?\s*:?\s*$/i;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, "")}\u2026`;
}

/** "Custom Cartoon Pet Portrait | Cat, Dog ..." -> "Custom Cartoon Pet Portrait"; "Frame | Custom ..." keeps the real name. */
function shortTitle(title: string | null | undefined): string {
  const segments = (title ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return "";
  const first = segments.length > 1 && segments[0].length < 12 ? segments[1] : segments[0];
  return clip(first, MAX_TITLE);
}

function optionValue(options: ProductOption[] | null | undefined, name: RegExp): string {
  const hit = (options ?? []).find((o) => name.test(String(o?.name ?? "")) && String(o?.value ?? "").trim());
  return hit ? String(hit.value).replace(/\s+/g, " ").trim() : "";
}

function sizeText(options: ProductOption[] | null | undefined, title: string): string {
  const size = sizeFromOptions(options) || optionValue(options, PRINT_ON_NAME);
  if (size) return clip(size, 48);
  const mug = optionValue(options, MUG_SIZE_NAME);
  if (!mug) return "";
  return /\bmug\b/i.test(title) ? clip(mug, 20) : `Mug ${clip(mug, 20)}`;
}

const PEOPLE_STYLE = /\b(people|persons?|family|couple|wedding)\b/i;
const PETS_WORD = /\bpets?\b/i;
const FIGURES_WORD = /\b(figures?|people|persons?)\b/i;

/**
 * "pet" or "figure" for the count. The style decides first (a "Watercolor
 * People" order is people), then the title; an option named "Number of Pets" is
 * pets, but the CPS option "Number Of Figures/Pets" is on every CPS listing, so
 * it says nothing and the count reads as figures.
 */
function countNoun(line: LineItem): "pet" | "figure" {
  if (PEOPLE_STYLE.test(line.style ?? "")) return "figure";
  if (PETS_WORD.test(line.style ?? "") || PETS_WORD.test(line.title ?? "")) return "pet";
  const named = (line.options ?? []).map((o) => String(o?.name ?? ""));
  return named.some((name) => PETS_WORD.test(name) && !FIGURES_WORD.test(name)) ? "pet" : "figure";
}

function countText(line: LineItem): string {
  const fromOption = Number.parseInt(optionValue(line.options, COUNT_NAME), 10);
  const n = line.figureCount ?? (Number.isFinite(fromOption) && fromOption > 0 ? fromOption : null);
  if (!n) return "";
  const noun = countNoun(line);
  const names = optionValue(line.options, NAMES_NAME);
  return `${n} ${noun}${n === 1 ? "" : "s"}${names ? `: ${clip(names, 40)}` : ""}`;
}

/**
 * The orientation an order was bought in ("portrait" or "landscape") from its
 * lines' orientation/layout option, else from notes that say "portrait
 * orientation" or "landscape orientation". Null when it is not stated, mixed
 * between lines, or square.
 */
export function orientationOf(lines: LineItem[], notes?: string | null): "portrait" | "landscape" | null {
  const found = new Set<"portrait" | "landscape">();
  const norm = (v: string): "portrait" | "landscape" | null => {
    const w = v.toLowerCase();
    return w === "portrait" || w === "vertical" ? "portrait" : w === "landscape" || w === "horizontal" ? "landscape" : null;
  };
  for (const l of lines) {
    const hit = ORIENTATION_VALUE.exec(optionValue(l.options, ORIENTATION_NAME))?.[1];
    const o = hit ? norm(hit) : null;
    if (o) found.add(o);
  }
  if (found.size === 1) return [...found][0];
  if (found.size > 1) return null;
  const note = /\b(portrait|landscape)\s+orientation\b/i.exec(notes ?? "")?.[1];
  return note ? norm(note) : null;
}

function lineText(line: LineItem): string {
  const orientation = optionValue(line.options, ORIENTATION_NAME);
  const title = shortTitle(line.title) || "Portrait";
  const parts = [
    title,
    sizeText(line.options, title),
    line.style ? styleLabel(line.style) : "",
    ORIENTATION_VALUE.exec(orientation)?.[1]?.toLowerCase() ?? "",
    countText(line),
  ];
  const kept: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    const low = p.toLowerCase();
    if (kept.some((k) => k.toLowerCase().includes(low))) continue;
    kept.push(p);
  }
  const qty = line.quantity && line.quantity > 1 ? ` x${line.quantity}` : "";
  return `${kept.join(" \u00b7 ")}${qty}`;
}

/**
 * What an order is, in one short line: product, size, style, orientation, how
 * many pets or figures and their names, from the order's lines. Add-on lines
 * (print & ship, rush) are left out when a real portrait line exists. "" when
 * the order has no lines.
 */
export function productLineOf(items: LineItem[]): string {
  if (!items.length) return "";
  const slots = buildPortraitSlots(
    items.map((l, i) => ({ id: String(i), title: l.title, variation: l.variation ?? null, sku: l.sku ?? null, quantity: 1 })),
    null,
    { perLine: true },
  );
  const kept = slots.map((s) => items[Number(s.itemId)]).filter(Boolean);
  const shown = kept.slice(0, 2).map(lineText);
  const more = kept.length - shown.length;
  return `${shown.join(" + ")}${more > 0 ? ` + ${more} more` : ""}`;
}

export type ShipName = { name: string | null; firstName: string | null; lastName: string | null };
export type BuyerName = { firstName: string | null; lastName: string | null };

/** The full name an order ships to, or null when the address has none. */
export function shipToName(ship: ShipName | null | undefined): string | null {
  if (!ship) return null;
  const name = (ship.name ?? "").replace(/\s+/g, " ").trim();
  if (name) return name;
  const joined = [ship.firstName, ship.lastName].map((p) => (p ?? "").trim()).filter(Boolean).join(" ");
  return joined || null;
}

function nameTokens(full: string): string[] {
  return full
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The name a gift ships to, only when it is not the buyer: first and last name
 * compared, middle names and punctuation ignored. Null when it is the buyer,
 * when there is no ship-to name, or when the buyer's own name is unknown (a
 * gift cannot be told apart then).
 */
export function giftRecipient(buyer: BuyerName | null | undefined, ship: ShipName | null | undefined): string | null {
  const to = shipToName(ship);
  if (!to || !buyer) return null;
  const buyerTokens = nameTokens([buyer.firstName, buyer.lastName].map((p) => p ?? "").join(" "));
  if (!buyerTokens.length) return null;
  const shipTokens = nameTokens(to);
  if (!shipTokens.length) return null;
  const sameFirst = buyerTokens[0] === shipTokens[0];
  const buyerHasLast = !!(buyer.lastName ?? "").trim() && buyerTokens.length > 1;
  const sameLast = !buyerHasLast || buyerTokens[buyerTokens.length - 1] === shipTokens[shipTokens.length - 1];
  return sameFirst && sameLast ? null : to;
}

/** A pointer to the newest artwork file of an order, enough to build a thumbnail URL. */
export type ArtworkRef = { id: string; storage: string; url: string | null; r2Key: string | null };

export type SameBuyerOrder = {
  /** AlphaOS order id; null for an order only the notes name. */
  id: string | null;
  number: string;
  status: string | null;
  /** Plain-words stage ("In design", "Buyer approved"); "Not in AlphaOS" when the order is not here. */
  stage: string;
  productLine: string | null;
  /** The full ship-to name, only when it differs from the buyer (a gift); else null. Staff view only. */
  shipTo: string | null;
  placedAt: Date | null;
  artworkAssetId: string | null;
  artwork: ArtworkRef | null;
  /** Set when the notes name this order and AlphaOS has no such order. */
  notInAlphaOS?: true;
  /** buyer = same customer, email or Etsy buyer; notes = named in this order's notes. */
  linkedBy: "buyer" | "notes";
  /** What the notes say about an order AlphaOS does not have, or null. */
  noteHint: string | null;
};

/** What a designer may see about another order: number, product, and whether it is done. No email, name or address. */
export type DesignerSafeSibling = { number: string; productLine: string | null; delivered: boolean; noteHint?: string | null };

export function designerSafeSiblings(others: SameBuyerOrder[]): DesignerSafeSibling[] {
  const out: DesignerSafeSibling[] = [];
  for (const o of others) {
    if (o.status === "cancelled") continue;
    out.push({
      number: o.number,
      productLine: scrubForDesigner(o.productLine),
      delivered: isDeliveredLike(o.status),
      noteHint: o.id ? null : scrubForDesigner(o.noteHint),
    });
  }
  return out;
}

/** Product text is the shop's own words, but a designer-facing copy never carries an address, email or phone. */
function scrubForDesigner(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  return t && !/@|https?:|www\.|\d{5,}/i.test(t) ? t : null;
}

type SentenceSibling = { number: string; productLine: string | null; delivered?: boolean; status?: string | null; noteHint?: string | null };

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The persisted/line form of other orders merged by number; the first list wins. */
export function mergeSiblings(...lists: DesignerSafeSibling[][]): DesignerSafeSibling[] {
  const seen = new Set<string>();
  const out: DesignerSafeSibling[] = [];
  for (const list of lists) {
    for (const s of list) {
      const key = orderNumberKey(s.number);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/**
 * The one plain sentence a designer, QC or the reply agent reads. Null when the
 * buyer has no other order. Carries order numbers and product lines only.
 */
export function sameBuyerSentence(thisOrder: { number: string; productLine: string | null }, others: SentenceSibling[]): string | null {
  if (!others.length) return null;
  const described = others.slice(0, 3).map((s) => {
    const what = s.productLine || s.noteHint || "";
    const delivered = s.delivered ?? isDeliveredLike(s.status ?? null);
    const detail = [what, delivered && !/deliver/i.test(what) ? "already delivered" : ""].filter(Boolean).join(", ");
    return detail ? `${s.number} (${detail})` : s.number;
  });
  const more = others.length - described.length;
  const list = more > 0 ? `${described.join(", ")} and ${more} more` : joinList(described);
  const mine = thisOrder.productLine ? `This order is ${thisOrder.number}: ${thisOrder.productLine}.` : `This order is ${thisOrder.number}.`;
  return `This customer also ordered ${list}. ${mine} Keep them separate and never upload or send another order's file.`;
}

/** The rule both reply-agent prompts carry when the buyer has more than one order. */
export const BUYER_ORDERS_RULE =
  "This buyer has more than one order. An email on one order's thread can be about another. Work out which order and which product they mean, name it by order number and product, and never answer about one order with another's status, file or proof. If you cannot tell which, say the team will check that order and confirm.";

/** The prompt block listing a buyer's orders plus the rule; "" when there are no other orders. */
export function buyerOrdersPromptBlock(thisOrder: { number: string; productLine: string | null; stage?: string | null }, others: SameBuyerOrder[]): string {
  if (!others.length) return "";
  const line = (n: string, what: string | null, stage: string | null | undefined, tag = "") =>
    `- ${n}${tag}: ${[what, stage ? `stage: ${stage}` : ""].filter(Boolean).join("; ") || "details unknown"}`;
  return [
    "THIS BUYER'S ORDERS",
    line(thisOrder.number, thisOrder.productLine, thisOrder.stage, " (this email's order)"),
    ...others.map((o) => line(o.number, o.productLine || o.noteHint, o.notInAlphaOS ? "not in our system, mentioned in the notes" : o.stage)),
    BUYER_ORDERS_RULE,
  ].join("\n");
}

/** The buyer's other orders (with an AlphaOS id) whose number the text names. */
export function detectMentionedOrders(text: string, others: SameBuyerOrder[]): SameBuyerOrder[] {
  if (!text || !others.length) return [];
  const keys = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) keys.add(orderNumberKey(m[1] ? `#CPS${m[1]}` : m[2] ? `PC${m[2]}` : m[3]));
  return others.filter((o) => !!o.id && keys.has(orderNumberKey(o.number)));
}

// ---------------------------------------------------------------------------
// Matching one order against candidate rows (pure, so it is tested)
// ---------------------------------------------------------------------------

/** An order we look siblings up for. */
export type BuyerAnchor = {
  id: string;
  businessId: string;
  number: string;
  customerId: string | null;
  notes: string | null;
  /** lower(trim(email)) of the buyer; staff view only. */
  emailKey?: string | null;
  /** Etsy buyer id from the receipt, for orders with no customer row; staff view only. */
  buyerUserId?: string | null;
  buyer?: BuyerName | null;
};

/** The identity columns of a candidate order. */
export type CandidateIdentity = {
  id: string;
  businessId: string;
  customerId: string | null;
  emailKey: string | null;
  buyerUserId: string | null;
  key: string;
};

/** Why `row` is another order of the same buyer as `anchor`: buyer, notes, or not related. Never by name. */
export function siblingLink(anchor: BuyerAnchor, row: CandidateIdentity, mentionKeys: ReadonlySet<string>): "buyer" | "notes" | null {
  if (row.id === anchor.id || row.businessId !== anchor.businessId) return null;
  if (anchor.customerId && row.customerId === anchor.customerId) return "buyer";
  if (anchor.emailKey && row.emailKey === anchor.emailKey) return "buyer";
  const buyerId = buyerUserIdOf(anchor.buyerUserId);
  if (buyerId && buyerUserIdOf(row.buyerUserId) === buyerId) return "buyer";
  if (mentionKeys.has(row.key)) return "notes";
  return null;
}

// ---------------------------------------------------------------------------
// The shared database core
// ---------------------------------------------------------------------------

export type FindOptions = {
  /** Read what only staff can (customer email and name, ship-to, Etsy buyer id). Default true. */
  staff?: boolean;
  /** Include each order's newest artwork file. Default false. */
  artwork?: boolean;
  /** Most orders per anchor. Default 8. */
  limit?: number;
};

type CandidateRow = CandidateIdentity & {
  platformOrderId: string;
  platformOrderName: string | null;
  status: string;
  revisionCount: number;
  placedAt: Date | null;
  createdAt: Date;
  custFirst: string | null;
  custLast: string | null;
  shipName: string | null;
  shipFirst: string | null;
  shipLast: string | null;
  artwork: unknown;
  title: string | null;
  variation: string | null;
  sku: string | null;
  options: ProductOption[] | null;
  figureCount: number | null;
  style: string | null;
  quantity: number | null;
};

function asArtwork(value: unknown): ArtworkRef | null {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== "string" || typeof a.storage !== "string") return null;
  return {
    id: a.id,
    storage: a.storage,
    url: typeof a.url === "string" ? a.url : null,
    r2Key: typeof a.r2Key === "string" ? a.r2Key : null,
  };
}

function inList(values: string[]): SQL {
  return sql.join(values.map((v) => sql`${v}`), sql`, `);
}

function uniq<T>(values: (T | null | undefined)[]): T[] {
  return [...new Set(values.filter((v): v is T => v != null && (v as unknown) !== ""))];
}

/** Candidate orders for a set of anchors, one query: every order sharing an identity or a named number. */
async function queryCandidates(tx: Tx, anchors: BuyerAnchor[], mentionKeys: string[], opts: Required<FindOptions>): Promise<CandidateRow[]> {
  const staff = opts.staff;
  const customerIds = uniq(anchors.map((a) => a.customerId));
  const emailKeys = staff ? uniq(anchors.map((a) => a.emailKey)) : [];
  const buyerIds = staff ? uniq(anchors.map((a) => buyerUserIdOf(a.buyerUserId))) : [];
  const match = [
    customerIds.length ? inArray(orders.customerId, customerIds) : undefined,
    emailKeys.length ? sql`lower(btrim(${customers.email})) in (${inList(emailKeys)})` : undefined,
    buyerIds.length ? sql`${orders.rawImport}->>'buyer_user_id' in (${inList(buyerIds)})` : undefined,
    mentionKeys.length ? sql`${KEY_SQL} in (${inList(mentionKeys)})` : undefined,
  ].filter((c): c is SQL => !!c);
  if (!match.length) return [];
  const businessIds = uniq(anchors.map((a) => a.businessId));
  const artwork = opts.artwork
    ? sql<unknown>`(select jsonb_build_object('id', ${assets.id}, 'storage', ${assets.storage}, 'url', ${assets.url}, 'r2Key', ${assets.r2Key}) from ${assets} where ${assets.orderId} = ${orders.id} and ${assets.type} in ('submission', 'final') and ${assets.deletedAt} is null order by ${assets.createdAt} desc limit 1)`
    : sql<unknown>`null`;
  // The joins to customers and ship-to are always written; a designer's row
  // level security simply returns NULL for them, and a non-staff read selects
  // NULL for those columns so nothing private is ever carried out.
  const none = sql<string | null>`null`;
  const rows = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      customerId: orders.customerId,
      emailKey: staff ? sql<string | null>`lower(btrim(${customers.email}))` : none,
      buyerUserId: staff ? sql<string | null>`${orders.rawImport}->>'buyer_user_id'` : none,
      key: KEY_SQL,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
      status: orders.status,
      revisionCount: orders.revisionCount,
      placedAt: orders.placedAt,
      createdAt: orders.createdAt,
      custFirst: staff ? customers.firstName : none,
      custLast: staff ? customers.lastName : none,
      shipName: staff ? orderShippingAddresses.name : none,
      shipFirst: staff ? orderShippingAddresses.firstName : none,
      shipLast: staff ? orderShippingAddresses.lastName : none,
      artwork,
      title: orderItems.title,
      variation: orderItems.variation,
      sku: orderItems.sku,
      options: orderItems.options,
      figureCount: orderItems.figureCount,
      style: orderItems.style,
      quantity: orderItems.quantity,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .leftJoin(orderShippingAddresses, eq(orderShippingAddresses.orderId, orders.id))
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(and(inArray(orders.businessId, businessIds), or(...match)))
    .orderBy(sql`${orders.placedAt} desc nulls last`, sql`${orders.createdAt} desc`, orders.id, orderItems.id)
    .limit(Math.min(3000, 100 + ROWS_PER_ANCHOR * anchors.length));
  return rows as CandidateRow[];
}

type CandidateOrder = { head: CandidateRow; lines: LineItem[] };

function groupCandidates(rows: CandidateRow[]): CandidateOrder[] {
  const byId = new Map<string, CandidateOrder>();
  for (const r of rows) {
    let g = byId.get(r.id);
    if (!g) {
      g = { head: r, lines: [] };
      byId.set(r.id, g);
    }
    if (r.title !== null || r.options !== null || r.figureCount !== null || r.style !== null) {
      g.lines.push({ title: r.title, variation: r.variation, sku: r.sku, options: r.options, figureCount: r.figureCount, style: r.style, quantity: r.quantity });
    }
  }
  return [...byId.values()];
}

function assembleFor(anchor: BuyerAnchor, mentions: NoteMention[], candidates: CandidateOrder[], limit: number, shipTo: boolean): SameBuyerOrder[] {
  const mentionKeys = new Set(mentions.map((m) => m.key));
  const found: SameBuyerOrder[] = [];
  const foundKeys = new Set<string>();
  for (const c of candidates) {
    const link = siblingLink(anchor, c.head, mentionKeys);
    if (!link) continue;
    const art = asArtwork(c.head.artwork);
    const buyer: BuyerName | null =
      c.head.custFirst || c.head.custLast ? { firstName: c.head.custFirst, lastName: c.head.custLast } : (anchor.buyer ?? null);
    foundKeys.add(c.head.key);
    found.push({
      id: c.head.id,
      number: orderNumberOf(c.head),
      status: c.head.status,
      stage: stageWithRound(c.head.status, c.head.revisionCount),
      productLine: productLineOf(c.lines) || null,
      shipTo: shipTo ? giftRecipient(buyer, { name: c.head.shipName, firstName: c.head.shipFirst, lastName: c.head.shipLast }) : null,
      placedAt: c.head.placedAt,
      artworkAssetId: art?.id ?? null,
      artwork: art,
      linkedBy: link,
      noteHint: null,
    });
  }
  for (const m of mentions) {
    if (!m.strong || foundKeys.has(m.key)) continue;
    found.push({
      id: null,
      number: m.number,
      status: null,
      stage: "Not in AlphaOS",
      productLine: null,
      shipTo: null,
      placedAt: null,
      artworkAssetId: null,
      artwork: null,
      notInAlphaOS: true,
      linkedBy: "notes",
      noteHint: m.hint,
    });
  }
  return found.slice(0, limit);
}

/**
 * Other orders of the same buyer for many orders at once (the designer board):
 * one query for all of them. Customer-row and notes matching only (no email or
 * buyer-id lookups), so it also works under a designer's row-level security,
 * where it sees just the orders that designer is on.
 */
export async function loadSameBuyerForAnchors(tx: Tx, anchors: BuyerAnchor[], opts: FindOptions = {}): Promise<Map<string, SameBuyerOrder[]>> {
  const o: Required<FindOptions> = { staff: opts.staff ?? true, artwork: opts.artwork ?? false, limit: opts.limit ?? DEFAULT_SIBLING_LIMIT };
  const out = new Map<string, SameBuyerOrder[]>();
  if (!anchors.length) return out;
  const mentionsBy = new Map(anchors.map((a) => [a.id, orderNumbersMentioned(a.notes, a.number)]));
  const mentionKeys = uniq([...mentionsBy.values()].flat().map((m) => m.key));
  const rows = groupCandidates(await queryCandidates(tx, anchors, mentionKeys, o));
  for (const a of anchors) {
    out.set(a.id, assembleFor(a, mentionsBy.get(a.id) ?? [], rows, o.limit, o.staff));
  }
  return out;
}

export type ThisOrderSummary = {
  id: string;
  number: string;
  stage: string;
  status: string;
  productLine: string | null;
  /** The full name the order ships to (staff view), or null. */
  shipToName: string | null;
};

export type SameBuyerContext = { thisOrder: ThisOrderSummary; others: SameBuyerOrder[] };

/** The order itself (number, product line, ship-to) and the buyer's other orders, in two queries. */
export async function loadSameBuyerContext(tx: Tx, orderId: string, opts: FindOptions = {}): Promise<SameBuyerContext | null> {
  const o: Required<FindOptions> = { staff: opts.staff ?? true, artwork: opts.artwork ?? false, limit: opts.limit ?? DEFAULT_SIBLING_LIMIT };
  const rows = await tx
    .select({
      id: orders.id,
      businessId: orders.businessId,
      customerId: orders.customerId,
      platformOrderId: orders.platformOrderId,
      platformOrderName: orders.platformOrderName,
      status: orders.status,
      revisionCount: orders.revisionCount,
      notes: orders.notes,
      buyerUserId: sql<string | null>`${orders.rawImport}->>'buyer_user_id'`,
      email: customers.email,
      custFirst: customers.firstName,
      custLast: customers.lastName,
      shipName: orderShippingAddresses.name,
      shipFirst: orderShippingAddresses.firstName,
      shipLast: orderShippingAddresses.lastName,
      title: orderItems.title,
      variation: orderItems.variation,
      sku: orderItems.sku,
      options: orderItems.options,
      figureCount: orderItems.figureCount,
      style: orderItems.style,
      quantity: orderItems.quantity,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .leftJoin(orderShippingAddresses, eq(orderShippingAddresses.orderId, orders.id))
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(eq(orders.id, orderId))
    .orderBy(orderItems.id)
    .limit(60);
  const head = rows[0];
  if (!head) return null;
  const number = orderNumberOf(head);
  const lines: LineItem[] = rows
    .filter((r) => r.title !== null || r.options !== null || r.figureCount !== null || r.style !== null)
    .map((r) => ({ title: r.title, variation: r.variation, sku: r.sku, options: r.options, figureCount: r.figureCount, style: r.style, quantity: r.quantity }));
  const thisOrder: ThisOrderSummary = {
    id: head.id,
    number,
    status: head.status,
    stage: stageWithRound(head.status, head.revisionCount),
    productLine: productLineOf(lines) || null,
    shipToName: o.staff ? shipToName({ name: head.shipName, firstName: head.shipFirst, lastName: head.shipLast }) : null,
  };
  const anchor: BuyerAnchor = {
    id: head.id,
    businessId: head.businessId,
    number,
    customerId: head.customerId,
    notes: head.notes,
    emailKey: o.staff && head.email ? head.email.trim().toLowerCase() : null,
    buyerUserId: o.staff ? buyerUserIdOf(head.buyerUserId) : null,
    buyer: { firstName: head.custFirst, lastName: head.custLast },
  };
  const others = (await loadSameBuyerForAnchors(tx, [anchor], o)).get(head.id) ?? [];
  return { thisOrder, others };
}

/**
 * The buyer's OTHER orders in the same business, newest first: same customer,
 * same email, same Etsy buyer, plus order numbers this order's notes name.
 * An order the notes name that AlphaOS does not have comes back as
 * `{ number, notInAlphaOS: true, productLine: null }`.
 */
export async function loadSameBuyerOrders(tx: Tx, orderId: string, opts: { limit?: number; staff?: boolean; artwork?: boolean } = {}): Promise<SameBuyerOrder[]> {
  return (await loadSameBuyerContext(tx, orderId, opts))?.others ?? [];
}

// ---------------------------------------------------------------------------
// Designers: a persisted, designer-safe note on the order
// ---------------------------------------------------------------------------

/** activity_log action for the designer-safe note written when a brief goes out. */
export const SAME_BUYER_NOTE_ACTION = "order.same_buyer_noted";

type NoteMetadata = { sentence?: unknown; siblings?: unknown };

/** The designer-safe siblings stored in an activity_log metadata blob; junk is ignored. */
export function siblingsFromNote(metadata: unknown): DesignerSafeSibling[] {
  const list = (metadata as NoteMetadata | null)?.siblings;
  if (!Array.isArray(list)) return [];
  const out: DesignerSafeSibling[] = [];
  for (const s of list) {
    const r = s as Record<string, unknown> | null;
    if (!r || typeof r.number !== "string" || !r.number) continue;
    out.push({
      number: r.number,
      productLine: typeof r.productLine === "string" ? r.productLine : null,
      delivered: r.delivered === true,
      noteHint: typeof r.noteHint === "string" ? r.noteHint : null,
    });
  }
  return out;
}

/**
 * Work out the buyer's other orders for `orderId` and, when there are any,
 * write the designer-safe note on the order (skipped when the latest note is
 * already the same). Returns the sentence, or null. Runs in a savepoint and
 * never throws, so a problem here can never block an assignment.
 */
export async function recordSameBuyerForDesigner(tx: Tx, orderId: string): Promise<string | null> {
  try {
    return await tx.transaction(async (sp) => {
      const ctx = await loadSameBuyerContext(sp, orderId);
      if (!ctx) return null;
      const siblings = designerSafeSiblings(ctx.others);
      const sentence = sameBuyerSentence(ctx.thisOrder, siblings);
      if (!sentence) return null;
      const [latest] = await sp
        .select({ metadata: activityLog.metadata })
        .from(activityLog)
        .where(and(eq(activityLog.orderId, orderId), eq(activityLog.action, SAME_BUYER_NOTE_ACTION)))
        .orderBy(sql`${activityLog.createdAt} desc`)
        .limit(1);
      if ((latest?.metadata as NoteMetadata | null)?.sentence === sentence) return sentence;
      const [row] = await sp.select({ businessId: orders.businessId }).from(orders).where(eq(orders.id, orderId)).limit(1);
      if (row) {
        await sp.insert(activityLog).values({
          businessId: row.businessId,
          orderId,
          actorId: null,
          action: SAME_BUYER_NOTE_ACTION,
          metadata: { sentence, siblings },
        });
      }
      return sentence;
    });
  } catch {
    return null;
  }
}

/**
 * The designer-safe siblings of many orders at once, for the board cards: the
 * buyer's other orders that this viewer's row-level security lets them see
 * (same customer row) and the ones each order's notes name, merged with the
 * note stored when the brief went out (which also knew the email and Etsy
 * buyer matches a designer cannot read). Reads only, so the caller runs it in
 * its own transaction and treats a failure as "no note". Orders with no other
 * order are left out of the map.
 */
export async function loadDesignerSiblings(tx: Tx, anchors: BuyerAnchor[]): Promise<Map<string, DesignerSafeSibling[]>> {
  const out = new Map<string, DesignerSafeSibling[]>();
  if (!anchors.length) return out;
  const ids = anchors.map((a) => a.id);
  const [live, noted] = await Promise.all([
    loadSameBuyerForAnchors(tx, anchors, { staff: false }),
    tx
      .select({ orderId: activityLog.orderId, metadata: activityLog.metadata })
      .from(activityLog)
      .where(and(inArray(activityLog.orderId, ids), eq(activityLog.action, SAME_BUYER_NOTE_ACTION)))
      .orderBy(desc(activityLog.createdAt)),
  ]);
  const latest = new Map<string, unknown>();
  for (const n of noted) if (n.orderId && !latest.has(n.orderId)) latest.set(n.orderId, n.metadata);
  for (const a of anchors) {
    const siblings = mergeSiblings(designerSafeSiblings(live.get(a.id) ?? []), siblingsFromNote(latest.get(a.id)));
    if (siblings.length) out.set(a.id, siblings);
  }
  return out;
}
