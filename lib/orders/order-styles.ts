/**
 * An order's portrait styles as a set (2026-10-29, owner: "customers give
 * multiple portraits in different styles ... even if there is multiple
 * designers in the mix"). One receipt is one order and ONE designer, so the
 * designer must draw EVERY style the order's portraits need. Pure, no DB.
 */

const key = (s: string) => s.trim().toLowerCase();

/** activity_log action of the note left when a designer draws a style they do not list (styleFallbackNote). */
export const STYLE_FALLBACK_ACTION = "order.style_fallback";

/** Distinct (any case), trimmed, non-empty styles, first spelling kept, order kept. */
export function distinctStyles(styles: (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of styles ?? []) {
    const t = s?.trim();
    if (!t || seen.has(key(t))) continue;
    seen.add(key(t));
    out.push(t);
  }
  return out;
}

/** The styles a caller asked about: `styles` when given, else the one `style`. */
export function stylesOfInput(input: { style?: string | null; styles?: (string | null)[] | null }): string[] {
  return distinctStyles(input.styles ?? [input.style]);
}

/** True when the designer's styles hold every one of `styles` (any case). No styles asked = true. */
export function coversStyles(designerStyles: string[] | null | undefined, styles: string[]): boolean {
  const own = new Set((designerStyles ?? []).map(key));
  return styles.every((s) => own.has(key(s)));
}

/** The styles of `styles` the designer does not draw. */
export function missingStyles(designerStyles: string[] | null | undefined, styles: string[]): string[] {
  const own = new Set((designerStyles ?? []).map(key));
  return styles.filter((s) => !own.has(key(s)));
}

/** "Watercolor People + Disney Pet". */
export function stylesLabel(styles: string[]): string {
  return styles.join(" + ");
}

/** "both" for two styles, "all of them" for more. */
function allWord(n: number): string {
  return n === 2 ? "both" : "all of them";
}

/**
 * Why an order with portraits in 2+ styles has nobody: no one designer on the
 * roster draws every style. Null when it has one style, or someone does.
 * "two styles on one order (Watercolor People + Disney Pet): no designer does both"
 */
export function multiStyleGap(styles: string[], roster: (string[] | null | undefined)[]): string | null {
  if (styles.length < 2) return null;
  if (roster.some((r) => coversStyles(r, styles))) return null;
  const count = styles.length === 2 ? "two" : String(styles.length);
  return `${count} styles on one order (${stylesLabel(styles)}): no designer does ${allWord(styles.length)}`;
}

/**
 * What to do about that gap: who draws each style, and the two ways out (one
 * designer takes every portrait, or a designer adds the missing style).
 */
export function multiStyleAdvice(styles: string[], roster: { name: string | null; styles: string[] | null }[]): string {
  const who = styles.map((s) => {
    const names = roster.filter((r) => coversStyles(r.styles, [s])).map((r) => r.name ?? "a designer");
    return `${s}: ${names.length ? names.join(", ") : "nobody"}`;
  });
  return (
    `Nobody draws ${allWord(styles.length) === "both" ? "both " : "every one of "}${styles.join(" and ")}, and one designer draws the whole order. ` +
    `${who.join("; ")}. Give it to one designer who can do ${allWord(styles.length)} (an owner or admin can), or add the missing style to a designer's styles.`
  );
}

/** "A", "A and B", "A, B and C". */
function joinAnd(list: string[]): string {
  return list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** "a" or "an" before a style name. */
function article(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? "an" : "a";
}

/** How many of `styles` the designer draws. */
export function coveredCount(designerStyles: string[] | null | undefined, styles: string[]): number {
  return styles.length - missingStyles(designerStyles, styles).length;
}

/**
 * The note on an order given to a designer who does not list every style on
 * it (2026-10-29 fallback: nobody draws both, so the designer of the primary
 * portrait draws the other one in its own style). Null when they list them
 * all, or the order has one style. `nobodyListsAll` = no designer on the
 * roster lists every style (else the ones who do were busy or passed over).
 * "Also has a Watercolor Pets portrait; no designer lists both Watercolor
 * People and Watercolor Pets: Abdul draws it in that style."
 */
export function styleFallbackNote(
  styles: string[],
  designerStyles: string[] | null | undefined,
  designerName: string | null | undefined,
  nobodyListsAll: boolean,
): string | null {
  if (styles.length < 2) return null;
  const missing = missingStyles(designerStyles, styles);
  if (!missing.length) return null;
  const who = designerName?.trim() || "The designer";
  const listed = styles.length === 2 ? `both ${styles[0]} and ${styles[1]}` : `all of ${joinAnd(styles)}`;
  const also = missing.length === 1 ? `${article(missing[0])} ${missing[0]} portrait` : `${joinAnd(missing)} portraits`;
  const nobody = nobodyListsAll ? `no designer lists ${listed}` : `no free designer lists ${listed}`;
  return `Also has ${also}; ${nobody}: ${who} draws ${missing.length === 1 ? "it in that style" : "them in those styles"}.`;
}
