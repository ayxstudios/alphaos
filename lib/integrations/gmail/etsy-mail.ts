/**
 * Etsy has no messaging API and never will (CLAUDE.md). Every buyer message and
 * every sale notification instead arrives as an EMAIL to the shop's connected
 * Gmail mailbox, from Etsy's own notification system. This module recognises
 * those emails and turns them into structured facts (kind, receipt id, buyer
 * name, shop name, cleaned body, conversation link); lib/integrations/gmail/
 * inbound.ts does the DB matching/attach with that structured output.
 *
 * Pure, dependency-free string parsing — easy to unit test against fixtures in
 * scripts/fixtures/etsy-mail/ (see scripts/test-etsy-mail.ts).
 */

export type EtsyEmailKind = "message" | "sale" | "shipped";

export type ParsedEtsyEmail = {
  kind: EtsyEmailKind;
  /** Etsy receipt id / human order number, when the email states one. */
  receiptId: string | null;
  /** Buyer's Etsy display name or (for sale emails) real name. */
  buyerName: string | null;
  /** The seller's shop name, when the email states it. */
  shopName: string | null;
  itemTitle: string | null;
  /** Cleaned, chrome-free body (the message text for `message`; a short summary otherwise). */
  body: string;
  /** Link back to the conversation/order on etsy.com, for the VA to open and reply. */
  link: string | null;
};

/** True when the From header is Etsy's own notification system, not a buyer. */
export function isEtsyNotificationSender(fromHeader: string | null): boolean {
  if (!fromHeader) return false;
  const m = fromHeader.match(/@([a-z0-9.-]+)/i);
  const domain = (m?.[1] ?? "").toLowerCase();
  return domain === "etsy.com" || domain.endsWith(".etsy.com");
}

const FOOTER_MARKERS = [
  /\n--\s*\n[\s\S]*$/i,
  /this email was sent by etsy[\s\S]*$/i,
  /etsy,?\s*inc\.?,?\s*\d+[\s\S]*$/i,
  /manage your notification settings[\s\S]*$/i,
  /unsubscribe from these emails[\s\S]*$/i,
];

function stripFooter(text: string): string {
  let out = text;
  for (const re of FOOTER_MARKERS) out = out.replace(re, "");
  return out.trim();
}

function firstMatch(re: RegExp, text: string): string | null {
  const m = text.match(re);
  return m?.[1]?.trim() || null;
}

function classify(subject: string): EtsyEmailKind | null {
  if (/new message from|sent you a message|new conversation/i.test(subject)) return "message";
  if (/you made a sale|you have a new order|new order notification/i.test(subject)) return "sale";
  if (/has shipped|shipping label|your order has been marked as shipped/i.test(subject)) return "shipped";
  return null;
}

/**
 * Parse an Etsy notification email. Returns null when the subject doesn't match
 * a recognised pattern (Etsy sends plenty of other mail — marketing, weekly
 * stats — that carries nothing actionable; those are deliberately ignored
 * rather than cluttering the messages table).
 */
export function parseEtsyEmail(input: { subject: string; body: string }): ParsedEtsyEmail | null {
  const subject = input.subject ?? "";
  const kind = classify(subject);
  if (!kind) return null;

  const rawBody = input.body ?? "";
  const withoutFooter = stripFooter(rawBody);

  const receiptId =
    firstMatch(/\border\s*#\s*(\d{6,})\b/i, subject) ??
    firstMatch(/\border\s*#\s*(\d{6,})\b/i, withoutFooter) ??
    firstMatch(/etsy\.com\/your\/orders\/(?:sold|open)\/(\d{6,})/i, withoutFooter);

  const shopName =
    firstMatch(/in your shop,\s*([^!\n.]+)[!.]/i, withoutFooter) ??
    firstMatch(/\bshop,\s*([^!\n.]+)[!.]/i, withoutFooter) ??
    firstMatch(/on\s+([A-Za-z0-9_][A-Za-z0-9_\s]{1,40})\s*\(your shop\)/i, withoutFooter);

  const itemTitle = firstMatch(/item:\s*(.+)/i, withoutFooter);

  let buyerName: string | null = null;
  if (kind === "message") {
    buyerName =
      firstMatch(/new message from\s+([^\n]+)/i, subject) ??
      firstMatch(/^\s*([^\n"]{2,60}?)\s+(?:wrote|sent you a message)/im, withoutFooter);
  } else {
    buyerName = firstMatch(/buyer:\s*(.+)/i, withoutFooter);
  }
  buyerName = buyerName?.replace(/[."]+$/, "").trim() || null;

  const link = firstMatch(/(https?:\/\/(?:www\.)?etsy\.com\/[^\s)]+)/i, rawBody);

  let body = withoutFooter;
  if (kind === "message") {
    const quoted = firstMatch(/"([^"]{2,4000})"/, withoutFooter);
    if (quoted) {
      body = quoted;
    } else {
      body = withoutFooter
        .replace(/^[\s\S]*?(?:wrote|sent you a message)\s*:?\s*/i, "")
        .replace(/^you have a new message[^\n]*\n+/i, "")
        .trim();
    }
  }
  // Drop the "Reply on Etsy: <url>" line wherever it ended up — it's carried
  // separately as `link`.
  body = body.replace(/^reply on etsy:.*$/gim, "").trim();

  return { kind, receiptId, buyerName, shopName, itemTitle, body, link };
}
