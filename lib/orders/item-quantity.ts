/**
 * Line quantity for portrait slots (two portraits in one email, 2026-10-14).
 * One order line x quantity N is N portraits to draw and send, so every import
 * stores the platform's quantity on order_items.quantity. Pure helpers only.
 */
import type { ProductOption } from "@/lib/db/schema";

/** No real order needs more portraits than this on one line; a typo cannot make 500 slots. */
export const MAX_ITEM_QUANTITY = 20;

/** A platform quantity as the stored integer: floored, at least 1, at most 20; unreadable is 1. */
export function clampItemQuantity(n: unknown): number {
  const v = typeof n === "string" && n.trim() ? Number(n) : n;
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.floor(v)));
}

/** An order_items row, as far as matching it to an import line needs. */
export type QuantityItem = { id: string; title: string | null; options: ProductOption[] | null };
/** One import line (an Etsy receipt transaction), already clamped. */
export type QuantityLine = { title: string | null; options: ProductOption[]; quantity: number };
export type QuantityMatch = {
  itemId: string;
  /** The line's quantity, or null when the row could not be matched safely. */
  quantity: number | null;
  /**
   * single = the only row for the only line; matched = same title and options;
   * leftover = the one row and the one line nothing else claimed; the rest are skipped.
   */
  how: "single" | "matched" | "leftover" | "ambiguous" | "unmatched";
};

const optionsKey = (options: ProductOption[] | null | undefined) =>
  JSON.stringify((options ?? []).map((o) => [o.name, o.value]));
const lineKey = (title: string | null, options: ProductOption[] | null | undefined) =>
  JSON.stringify([title ?? "", optionsKey(options)]);

function group<T>(list: T[], keyOf: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of list) m.set(keyOf(t), [...(m.get(keyOf(t)) ?? []), t]);
  return m;
}

/**
 * Pair each stored row with the import line it was created from. order_items
 * keeps no transaction id, so the pairing is the one the import itself made:
 * one row per line, carrying the line's title and options. A lone row for a
 * lone line is paired outright (a VA may since have retitled it). Otherwise a
 * row is paired only when its title and options match the same number of
 * lines as rows and those lines agree on the quantity; when exactly one row and
 * exactly one line are left over after that (a VA retitled that row), they are
 * each other's pair. Anything else is left alone rather than guessed.
 */
export function matchItemQuantities(items: QuantityItem[], lines: QuantityLine[]): QuantityMatch[] {
  if (items.length === 1 && lines.length === 1) {
    return [{ itemId: items[0].id, quantity: lines[0].quantity, how: "single" }];
  }
  const itemsByKey = group(items, (i) => lineKey(i.title, i.options));
  const linesByKey = group(lines, (l) => lineKey(l.title, l.options));
  const matches = items.map((item): QuantityMatch => {
    const key = lineKey(item.title, item.options);
    const sameLines = linesByKey.get(key) ?? [];
    if (!sameLines.length) return { itemId: item.id, quantity: null, how: "unmatched" };
    const quantity = sameLines[0].quantity;
    if ((itemsByKey.get(key) ?? []).length !== sameLines.length || sameLines.some((l) => l.quantity !== quantity)) {
      return { itemId: item.id, quantity: null, how: "ambiguous" };
    }
    return { itemId: item.id, quantity, how: "matched" };
  });
  const orphanRows = matches.filter((m) => m.how === "unmatched");
  const orphanLines = lines.filter((l) => !itemsByKey.has(lineKey(l.title, l.options)));
  if (orphanRows.length !== 1 || orphanLines.length !== 1) return matches;
  return matches.map((m): QuantityMatch =>
    m === orphanRows[0] ? { ...m, quantity: orphanLines[0].quantity, how: "leftover" } : m,
  );
}
