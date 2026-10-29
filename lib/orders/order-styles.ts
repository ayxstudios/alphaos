/**
 * An order's portrait styles as a set (2026-10-29, owner: "customers give
 * multiple portraits in different styles ... even if there is multiple
 * designers in the mix"). One receipt is one order and ONE designer, so the
 * designer must draw EVERY style the order's portraits need. Pure, no DB.
 */

const key = (s: string) => s.trim().toLowerCase();

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
