import { decodeHtmlEntities } from "../integrations/etsy/html-entities";

/**
 * Does the customer on an order belong to the order? Pure helpers, no db.
 *
 * Etsy never gives us the buyer's email, so a VA types a name + email while
 * completing an order. Typing the wrong person (another order's customer, or a
 * stale customer row for that email) used to go through silently and the buyer
 * then got "Hi Amanda" in an email meant for Maya. The receipt itself says who
 * bought the order, so every place that links a customer compares against it.
 */

export type NameMatch = "match" | "mismatch" | "unknown";

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

/**
 * Lower-case words of a name with accents, punctuation and repeated spaces
 * gone: "  Mary-Kate  O'Brien " -> ["mary", "kate", "obrien"]. Titles and
 * suffixes (Mrs, Jr) are dropped so they never decide a match.
 */
export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  const cleaned = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’‘`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!cleaned) return [];
  const all = cleaned.split(/\s+/);
  const kept = all.filter((t) => !HONORIFICS.has(t) && !SUFFIXES.has(t));
  return kept.length ? kept : all;
}

/** Equal words, or an initial standing for a name that starts with it ("J" ~ "John"). */
function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);
  if (b.length === 1) return a.startsWith(b);
  return false;
}

/**
 * Compare two people's names.
 * - "match": same full name, or first and last words agree, or one name is
 *   contained in the other with the first name or the surname agreeing
 *   ("Mary Kate Sheppard" ~ "Mary Sheppard", "Maya" ~ "Maya Scopin").
 * - "mismatch": two different people ("Audrea Sanchez" vs "Colleen Luczak").
 * - "unknown": one side has no name, so nothing can be said.
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): NameMatch {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return "unknown";

  // First and last words agree even if a middle name differs.
  if (ta.length > 1 && tb.length > 1 && sameToken(ta[0], tb[0]) && sameToken(ta[ta.length - 1], tb[tb.length - 1])) {
    return "match";
  }
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const contained = short.every((s) => long.some((l) => sameToken(s, l)));
  if (!contained) return "mismatch";
  // Same words in any order ("Sheppard, Mary Kate"), or one name is the other
  // with parts left out and either its first name or its surname still agrees.
  if (short.length === long.length) return "match";
  const firstAgrees = sameToken(short[0], long[0]);
  const lastAgrees = sameToken(short[short.length - 1], long[long.length - 1]);
  return firstAgrees || lastAgrees ? "match" : "mismatch";
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
  return t || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Who the platform says bought the order, from the raw payload stored with it.
 * - Etsy: the receipt's `name` (the Gmail sale-email stub keeps `buyerName`).
 * - Shopify: a stored `buyerName` or the customer's first + last name. Shopify's
 *   own `name` is the order number ("#1001"), never the buyer, so it is not read.
 * Everything else (manual, legacy, trello) has no receipt: null.
 * Trimmed, HTML entities decoded and repeated spaces collapsed.
 */
export function receiptBuyerName(source: string | null | undefined, rawImport: unknown): string | null {
  const raw = asRecord(rawImport);
  if (!raw) return null;
  if (source === "etsy") return cleanName(raw.name) ?? cleanName(raw.buyerName);
  if (source === "shopify") {
    const direct = cleanName(raw.buyerName) ?? cleanName(raw.customerName);
    if (direct) return direct;
    const customer = asRecord(raw.customer);
    if (!customer) return null;
    const first = cleanName(customer.firstName ?? customer.first_name);
    const last = cleanName(customer.lastName ?? customer.last_name);
    return [first, last].filter(Boolean).join(" ") || null;
  }
  return null;
}

/** "Etsy buyer" / "Shopify buyer" for the order page line; null when the source has no receipt. */
export function buyerSourceLabel(source: string | null | undefined): string | null {
  if (source === "etsy") return "Etsy buyer";
  if (source === "shopify") return "Shopify buyer";
  return null;
}

/** First + last name the way the customers table holds them. */
export function joinCustomerName(firstName: string | null | undefined, lastName: string | null | undefined): string {
  return [firstName, lastName]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * The receipt buyer to flag when the customer linked to an order is someone
 * else, or null when there is nothing to flag (no receipt buyer, no customer
 * name, or the names agree). Drives the amber line on the order page.
 */
export function buyerMismatchNotice(args: {
  source: string | null | undefined;
  rawImport: unknown;
  customerFirstName: string | null | undefined;
  customerLastName: string | null | undefined;
}): { label: string; buyer: string } | null {
  const buyer = receiptBuyerName(args.source, args.rawImport);
  const label = buyerSourceLabel(args.source);
  if (!buyer || !label) return null;
  const verdict = namesMatch(joinCustomerName(args.customerFirstName, args.customerLastName), buyer);
  return verdict === "mismatch" ? { label, buyer } : null;
}

/** "shellie" -> "Shellie", "mary-kate" -> "Mary-Kate"; mixed or upper case is left alone. */
function titleCaseWhenLower(word: string): string {
  if (word !== word.toLowerCase() || word === word.toUpperCase()) return word;
  return word.replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * The first name an email greets the customer with. It is the customer's own
 * first name, unless the order has a receipt buyer and the customer row belongs
 * to someone else: then the buyer's first name, so "Hi Amanda" never goes to
 * Maya. Null means "no name known" (the caller says "there").
 */
export function greetingFirstName(args: {
  customerFirstName: string | null | undefined;
  customerLastName: string | null | undefined;
  receiptBuyer: string | null | undefined;
}): string | null {
  const own = args.customerFirstName?.trim() || null;
  const buyer = args.receiptBuyer?.trim();
  if (!buyer) return own;
  const verdict = namesMatch(joinCustomerName(args.customerFirstName, args.customerLastName), buyer);
  if (verdict !== "mismatch") return own;
  const buyerFirst = buyer.split(/\s+/)[0]?.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return buyerFirst ? titleCaseWhenLower(buyerFirst) : own;
}

/**
 * The refusal shown to a VA who is about to attach the wrong person to an
 * order. Names both people and the order; no pronouns, a name says nothing
 * about them. `otherOrderNumber` is the other person's latest other order.
 */
export function buyerMismatchMessage(args: {
  receiptBuyer: string;
  otherName: string;
  otherEmail: string | null;
  otherOrderNumber: string | null;
  /** The button that overrides it: "Save anyway" on the order form, "Link anyway" on a reply. */
  overrideLabel?: string;
}): string {
  const detail = [args.otherEmail, args.otherOrderNumber ? `also on order ${args.otherOrderNumber}` : null]
    .filter(Boolean)
    .join(", ");
  return (
    `This order was bought by ${args.receiptBuyer}, but these details are for ${args.otherName}` +
    `${detail ? ` (${detail})` : ""}. Check you are on the right order, or choose ${args.overrideLabel ?? "Save anyway"}.`
  );
}
