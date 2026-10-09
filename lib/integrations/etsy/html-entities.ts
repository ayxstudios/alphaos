/**
 * Etsy's API returns listing titles, variation text and buyer notes
 * HTML-encoded ("Father&#39;s Day Gift"). Decode them once at import so the
 * UI never shows raw entities. Tiny and dependency-free: the common named
 * entities plus any numeric (&#39; / &#x27;) one.
 */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

function codePoint(n: number, whole: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : whole;
}

export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  const once = (s: string) =>
    s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,8}));/g, (whole, dec, hex, name) => {
      if (dec) return codePoint(parseInt(dec, 10), whole);
      if (hex) return codePoint(parseInt(hex, 16), whole);
      return NAMED[name] ?? NAMED[String(name).toLowerCase()] ?? whole;
    });
  // Twice: Etsy sometimes double-encodes ("&amp;#39;").
  return once(once(input));
}
