import { and, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { businesses, orderItems, orders, styles } from "@/lib/db/schema";
import { isDisneyOrder } from "@/lib/orders/assign";

/**
 * PixArt Disney orders that include a person go to the Disney people designer
 * (Yousif 2026-10-21: "If a pixart order contains a person it should also be
 * sent to Wahyu. Find a non-AI or cheap way to filter orders"). PixArt sells
 * pet listings only, so a person shows up in the buyer's own words: the
 * personalization box, her Etsy order note, her upload-page note or the photo
 * chat. Plain keyword rules, no model. A hit restyles the order's Disney lines
 * to the business's "Disneyfy People" style (locked), so every routing path
 * (auto-assign, SLA sweep, limbo, manual pins) only offers designers who draw
 * Disney people. Nothing on Shopify or Etsy is touched.
 */
export const DISNEY_PEOPLE_STYLE = "Disneyfy People";
const PEOPLE_BUSINESSES = new Set(["pixart"]);

const REL =
  "(?:husband|wife|son|daughter|boyfriend|girlfriend|partner|fianc[eé]e?|kids?|children|child|baby|babies|toddler|family|mom|mum|mommy|mummy|dad|daddy|mother|father|parents?|grandma|grandpa|grandmother|grandfather|nana|sister|brother|niece|nephew|owner|owners|self)";
const PET = "(?:dogs?|cats?|pets?|pupp(?:y|ies)|pups?|kittens?|kitty|horses?|bunn(?:y|ies)|rabbits?|fur ?bab(?:y|ies))";

const PEOPLE_PATTERNS: RegExp[] = [
  /\bhumans?\b/i,
  /\bpersons?\b/i,
  /\bpeople\b/i,
  /\bmyself\b/i,
  /\bselfie\b/i,
  /\b(?:me|us)\s+(?:and|&|with|holding|hugging|cuddling|kissing|next to|beside)\b/i,
  /\b(?:and|&|with|plus|include|including|add|adding|draw|drawing)\s+(?:me|us|myself)\b/i,
  new RegExp(
    String.raw`\b(?:add|adding|include|including|with|plus|holding|hugging|next to|beside|draw|drawing)\s+(?:my|our|her|his|their|the|a)\s+(?:\w+\s+)?${REL}\b`,
    "i",
  ),
  new RegExp(String.raw`\b${REL}\s+(?:and|&|with|holding|hugging)\s+(?:my|our|the|their|her|his)\s+(?:\w+\s+)?${PET}\b`, "i"),
  /\bfamily\s+(?:portrait|photo|picture|pic|drawing)\b/i,
];

/** Leaving the person OUT ("leave out the person in photo 5", "no people please") is not a person order. */
const NEGATION = /\b(?:no|not|without|leave(?:s|ing)? out|leave off|remove|removing|crop(?:ping)? out|exclude|excluding|except|don'?t|do not|only (?:the|my|our))\b[^.!?\n]{0,30}$/i;

/** Option rows that hold no buyer wording (or name a pet count), so a person can't be named there. */
const NON_TEXT_OPTION = /background|print|size|mug|72 hours|frame|canvas|number of pets|variant/i;
const PEOPLE_OPTION_NAME = /\b(?:number of (?:people|persons|humans|adults|kids|children)|add (?:a )?(?:person|human|people))\b/i;

/**
 * A PixArt Disney line: styled cartoon / Disney Pet, or unstyled with a Disney or
 * cartoon listing title ("Custom Cartoon Hand Drawn Pet Portrait" on Etsy). The
 * Print & Ship add-on and the watercolor / renaissance / line-art listings are not.
 */
export function isDisneyLine(i: { style?: string | null; title?: string | null }): boolean {
  const s = (i.style ?? "").trim().toLowerCase();
  if (s) return s === "cartoon" || s === "disney pet";
  const t = i.title ?? "";
  return isDisneyOrder([{ title: t }]) || (/cartoon/i.test(t) && !/watercolou?r|renaissance|line ?art|add on|print & ship/i.test(t));
}

export type PeopleSource = {
  options?: { name?: string | null; label?: string | null; value?: string | null }[] | null;
  notes?: string | null;
  messageFromBuyer?: string | null;
};

/** The buyer's own words on the order (never our boilerplate): option values, her order note, note segments in her words. */
export function buyerWords(src: PeopleSource): string[] {
  const out: string[] = [];
  for (const o of src.options ?? []) {
    const name = (o.name ?? o.label ?? "").trim();
    const value = (o.value ?? "").trim();
    if (!value || NON_TEXT_OPTION.test(name)) continue;
    out.push(value);
  }
  if (src.messageFromBuyer?.trim()) out.push(src.messageFromBuyer.trim());
  // Notes mix our own lines with hers; only the parts marked as hers count.
  const notes = src.notes ?? "";
  for (const m of notes.matchAll(/(?:Customer note \([^)]*\):|Her own words:)\s*([\s\S]*?)(?=\n|Added \d{4}-\d\d-\d\d|Customer note \(|Her own words:|$)/g)) {
    if (m[1]?.trim()) out.push(m[1].trim());
  }
  return out;
}

/** The matched phrase when the buyer's words put a person in the portrait, else null. Pure, no model. */
export function peopleMention(src: PeopleSource): string | null {
  for (const o of src.options ?? []) {
    const name = (o.name ?? o.label ?? "").trim();
    const value = (o.value ?? "").trim();
    if (PEOPLE_OPTION_NAME.test(name) && value && !/^(?:0|none|no)\b/i.test(value)) return `${name}: ${value}`;
  }
  for (const text of buyerWords(src)) {
    for (const p of PEOPLE_PATTERNS) {
      const re = new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g");
      for (const m of text.matchAll(re)) {
        const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
        if (NEGATION.test(before)) continue;
        return m[0];
      }
    }
  }
  return null;
}

/**
 * PixArt only: when a Disney order's buyer words include a person, restyle its
 * Disney lines to "Disneyfy People" (locked) and return that style, so ranking
 * offers only the Disney people designer. Null = no change.
 */
export async function routeDisneyPeople(tx: Tx, orderId: string, businessId: string): Promise<string | null> {
  const [biz] = await tx.select({ slug: businesses.slug }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (!biz || !PEOPLE_BUSINESSES.has(biz.slug)) return null;
  const [target] = await tx
    .select({ name: styles.name })
    .from(styles)
    .where(and(eq(styles.businessId, businessId), eq(styles.name, DISNEY_PEOPLE_STYLE)))
    .limit(1);
  if (!target) return null;

  const items = await tx
    .select({ id: orderItems.id, style: orderItems.style, title: orderItems.title, options: orderItems.options })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (!items.some(isDisneyLine)) return null;
  if (items.some((i) => (i.style ?? "").trim().toLowerCase() === DISNEY_PEOPLE_STYLE.toLowerCase())) return null;

  const [o] = await tx
    .select({ notes: orders.notes, rawImport: orders.rawImport })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  const raw = (o?.rawImport ?? null) as { message_from_buyer?: unknown } | null;
  const messageFromBuyer = typeof raw?.message_from_buyer === "string" ? raw.message_from_buyer : null;
  const options = items.flatMap((i) => (Array.isArray(i.options) ? (i.options as PeopleSource["options"]) ?? [] : []));
  if (!peopleMention({ options, notes: o?.notes ?? null, messageFromBuyer })) return null;

  // Restyle the Disney lines (the Print & Ship add-on with no style stays as it is).
  for (const i of items) {
    if (!isDisneyLine(i)) continue;
    await tx.update(orderItems).set({ style: target.name, styleLocked: true }).where(eq(orderItems.id, i.id));
  }
  return target.name;
}
