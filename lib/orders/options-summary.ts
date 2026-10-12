/**
 * One human line for a line item's shop options, for places with no room for
 * the raw list (the designer's board card, the order page on a phone).
 *
 * Shop options arrive as the shop wrote them: long questions as names
 * ("Would you like a rush order? (+$10):"), answers like "No thanks", links to
 * uploaded files, and free-text personalisation. The line keeps the answers
 * that say what to make, drops the "no" answers and the machine fields, turns
 * a "Yes" into the thing that was said yes to, and trims long text. The full
 * list always stays one tap away wherever this line is shown.
 */
export type ShopOption = { name: string; value: string };

const NEGATIVE = /^(no|none|nope|n\/a|na|-|no thanks?|no,? thank you|no,? thanks?|not needed|not required|nothing|skip)[.!]?$/i;
const YES = /^(yes|yes please|yes,? please|yep|y)[.!]?$/i;
const URLISH = /^(https?:\/\/|www\.)\S+$/i;

/** "Would you like a rush order? (+$10):" -> "Rush order". */
export function shortOptionName(name: string): string {
  let n = name.replace(/[\s:]+$/, "");
  n = n.replace(/\s*\((?:[^)]*\$[^)]*|[+-]?\s*\d[^)]*)\)\s*/g, " "); // price or count asides
  n = n.replace(/^(would you like|do you want|do you need|add|include)\s+(to\s+(add|include|get)\s+)?(an?\s+|the\s+)?/i, "");
  n = n.replace(/\?+$/, "").trim();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : name.trim();
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, "")}…`;
}

// Option names that carry the customer's own text for the art: Etsy's
// "Personalization", PixArt's "Pet Name(s)", CPS Shopify's
// "Personalisation/Comments". A font or colour pick for the name, or an upload
// field, names a name but is not the text itself.
const PERSONALIZATION_NAME = /personali[sz]|\bnames?\b|\bwording\b|inscription|dedication|engrav|caption|\btext\b/i;
const NOT_PERSONALIZATION_NAME = /font|colou?r|upload|photo|image|e-?mail|phone/i;

export function isPersonalizationOption(name: string): boolean {
  const n = name.trim();
  return !!n && !n.startsWith("_") && PERSONALIZATION_NAME.test(n) && !NOT_PERSONALIZATION_NAME.test(n);
}

/**
 * The personalization the customer typed, verbatim, so a designer can copy it
 * onto the art exactly: line breaks kept, only stray spaces at line ends and
 * blank edges trimmed. Empty answers are skipped.
 */
export function personalizationOf(options: ShopOption[] | null | undefined): ShopOption[] {
  if (!options?.length) return [];
  const out: ShopOption[] = [];
  for (const o of options) {
    const name = String(o?.name ?? "");
    if (!isPersonalizationOption(name)) continue;
    const value = String(o?.value ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
    if (value) out.push({ name: name.trim(), value });
  }
  return out;
}

/** The summary line, or "" when no option says anything worth a line. */
export function optionsSummary(options: ShopOption[] | null | undefined, max = 90): string {
  if (!options?.length) return "";
  const parts: string[] = [];
  for (const o of options) {
    const name = String(o.name ?? "").trim();
    const value = String(o.value ?? "").trim();
    if (!value || name.startsWith("_")) continue;
    if (NEGATIVE.test(value) || URLISH.test(value)) continue;
    const part = YES.test(value) ? shortOptionName(name) : clip(value, 40);
    if (part && !parts.includes(part)) parts.push(part);
  }
  return clip(parts.join(" · "), max);
}
