import { builtInSuppressionReason, parseEmailAddress } from "@/lib/email/suppression";

/**
 * Is this inbound message a notification or marketing email rather than a
 * person writing to us? Such mail never counts toward "Needs you" (Home,
 * Today, Messages): nobody is waiting on a reply.
 *
 * Deliberately conservative. It only reads the sender, the subject and, for
 * Etsy mail, the parsed kind, and it only fires on patterns a real customer
 * never produces: platform notification senders (Etsy, Shopify), bulk-mail
 * services, no-reply / bounce / newsletter mailboxes, auto-replies and
 * delivery failures. Nothing is hidden: the message stays in All mail and on
 * the order, it just stops asking for a person.
 *
 * Ingest already suppresses no-reply senders and the business's ignore list
 * (lib/email/suppression.ts); this also covers mail stored before those
 * rules existed and the Etsy notices (sale, shipped) that arrive as messages.
 */
export type MailLike = {
  address: string | null;
  subject: string | null;
  channel?: string | null;
  /** metadata.kind on Etsy mail: "message" is a buyer, "sale"/"shipped" are notices. */
  kind?: string | null;
};

// Mailboxes that only ever send automated mail.
const NOISE_LOCAL =
  /^(mailer-?daemon|postmaster|bounces?|newsletters?|news|marketing|promos?|promotions?|notify|notifier|alerts?|updates?|digest|automated|auto-?confirm|mailer|info-?noreply)([+._-]|$)/i;

// Platform notification and bulk-mail domains (the domain itself or any subdomain).
const NOISE_DOMAINS = [
  "etsy.com",
  "etsymail.com",
  "shopify.com",
  "shopifyemail.com",
  "mcsv.net",
  "mcdlv.net",
  "rsgsv.net",
  "mailchimpapp.net",
  "mandrillapp.com",
  "klaviyomail.com",
  "klaviyo.com",
  "sendgrid.net",
  "amazonses.com",
  "sparkpostmail.com",
  "hubspotemail.net",
  "createsend.com",
  "cmail19.com",
  "cmail20.com",
  "omnisend.com",
  "mailgun.org",
];

const NOISE_SUBJECT = [
  /^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office)\b/i,
  /^\s*(undeliverable|undelivered mail|delivery status notification|mail delivery (failed|failure|subsystem)|returned mail|delivery failure)\b/i,
  /\byou made a sale\b/i,
  /^\s*\[shopify\]/i,
  /\byour (weekly|monthly|daily) (stats|summary|report|digest)\b/i,
];

export function noiseReason(m: MailLike): string | null {
  if (m.channel === "etsy") {
    // Etsy mail is parsed at ingest; a buyer's conversation is a person.
    if (m.kind === "sale" || m.kind === "shipped") return "Etsy notification";
    return null;
  }
  const builtIn = builtInSuppressionReason(m.address);
  if (builtIn) return "No-reply sender";
  const email = parseEmailAddress(m.address);
  if (email) {
    const [local = "", domain = ""] = email.split("@");
    if (NOISE_LOCAL.test(local)) return "Automated mailbox";
    if (local.includes("bounce")) return "Automated mailbox";
    if (NOISE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return "Platform or bulk mail";
  }
  const subject = m.subject ?? "";
  if (NOISE_SUBJECT.some((re) => re.test(subject))) return "Notification or auto-reply";
  return null;
}

export function isNoiseMail(m: MailLike): boolean {
  return noiseReason(m) !== null;
}

/**
 * Only the mail from people. The Today queue, Messages, the SLA sweep's
 * "unmatched reply is older than 24h" alert and the daily health report's
 * stale unmatched replies all leave out the same notifications and marketing.
 */
export function peopleMail<T extends MailLike>(rows: T[]): T[] {
  return rows.filter((r) => !isNoiseMail(r));
}
