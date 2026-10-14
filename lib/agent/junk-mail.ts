// No limbo, L2 (docs/NO_LIMBO.md): mail that matches no order is cleared, not
// queued. A reply from one of our buyers is linked to their order; spam,
// phishing and vendor pitches are closed and their exact sender ignored; only
// what is genuinely unclear stays open, with a recommendation for the owner.
import { and, eq, sql } from "drizzle-orm";

import { withSystemContext, type Tx } from "@/lib/db";
import { activityLog, customers, emailSenderIgnores, exceptions, messages, orders } from "@/lib/db/schema";
import { parseEmailAddress } from "@/lib/email/suppression";
import { openExceptionTx } from "./exceptions";
import { ensureLegacyStub, parseOrderNumber } from "./legacy-intake";
import { autoResolveTx } from "./limbo";

export type MailVerdict = { verdict: "customer" | "junk" | "unsure"; reason: string };

/** Brands phishing mail pretends to be, and the domains their real mail comes from. */
const BRANDS: { name: string; words: RegExp; domains: string[] }[] = [
  { name: "Shopify", words: /\bsho(?:p|pl)[il1]fy\b/i, domains: ["shopify.com"] },
  { name: "Meta", words: /\b(?:meta(?:\s*ads)?|facebook|faceb00k|instagram)\b/i, domains: ["meta.com", "facebook.com", "facebookmail.com", "instagram.com", "fb.com"] },
  { name: "Etsy", words: /\bets[yi]\b/i, domains: ["etsy.com"] },
  { name: "PayPal", words: /\bpay\s?pal\b/i, domains: ["paypal.com"] },
  { name: "Google", words: /\bgoogle\b/i, domains: ["google.com", "googlemail.com"] },
  { name: "Apple", words: /\b(?:apple|testflight|icloud support)\b/i, domains: ["apple.com"] },
  { name: "OpenAI", words: /\b(?:openai|chatgpt)\b/i, domains: ["openai.com"] },
  { name: "Stripe", words: /\bstripe\b/i, domains: ["stripe.com"] },
  { name: "Amazon", words: /\bamazon\b/i, domains: ["amazon.com", "amazon.com.au"] },
  { name: "Klarna", words: /\bklarna\b/i, domains: ["klarna.com"] },
  { name: "CapCut", words: /\bcapcut\b/i, domains: ["capcut.com"] },
  { name: "TikTok", words: /\btiktok\b/i, domains: ["tiktok.com"] },
];

/** Scam phrases: fake account, policy and verification warnings. */
const SCAM: [RegExp, string][] = [
  [/\bkyc\b|verify (?:your|the) (?:store|shop|account|identity|business)|identity verification|upload (?:your )?(?:company )?documents/i, "account verification scam"],
  [/\b(?:account|store|shop|page|ads?)\b[^.]{0,40}\b(?:suspended|restricted|disabled|deactivated|terminated|reported)\b/i, "account warning scam"],
  [/policy violation|violat(?:ed|ing|ion of) (?:our|the|community)|appeal (?:the|this) decision|copyright (?:issue|infringement|notice|violation)|trademark issues?/i, "policy warning scam"],
  [/\baction required\b[^.]{0,60}\baccount\b|\bcontinue using (?:your )?(?:\w+ )?account\b|\b(?:update|confirm|verify) your (?:information|details|phone|email|payment|billing)/i, "account warning scam"],
];

/** Phrases only sales pitches use. Matched on display name + subject + excerpt. */
const PITCH: [RegExp, string][] = [
  [/(?:remove|delete|bury|get rid of)\b[^.]{0,30}\b(?:negative|bad|1-star|one star) reviews?|negative reviews? (?:driving|hurting|killing|costing|pushing)|reviews? disappearing|\btrustpilot\b/i, "reviews pitch"],
  [/\baffiliate\b|\bpartnership (?:idea|proposal|opportunity|offer)|\bsponsor(?:ship|ed post)\b|\bcollaboration (?:proposal|opportunity)\b/i, "partnership pitch"],
  [/\bseo\b|\bbacklinks?\b|\bguest post|\bsearch rankings?\b|\bfirst page of google\b|\btarget(?:ing)? city\b|city you(?:'|\u2019)re targeting/i, "SEO pitch"],
  [/\b(?:web(?:site)? design|redesign your (?:site|store|website)|landing page|conversion rate|cro audit)\b|\bproposal for your (?:website|store|shop|business)\b|\b(?:free|short|quick|comprehensive) (?:\w+ )?audit\b/i, "web design pitch"],
  [/\b(?:grow|scale|boost|skyrocket|increase|drive)\b[^.]{0,25}\b(?:sales|revenue|traffic|conversions|reach|engagement)\b/i, "growth pitch"],
  [/\b(?:marketing|advertising|ads) (?:services?|agency|expert|specialist|team|solutions)\b|\b(?:email|social media|digital|influencer) marketing\b|\bsocial media management\b|\bmanage your (?:ads|marketing|social)\b|\bad (?:fatigue|creative)\b|\bcase studies\b/i, "marketing pitch"],
  [/\b(?:business )?(?:funding|cash advance|working capital|line of credit)\b|\bbusiness loan\b/i, "funding pitch"],
  [/\bno upfront (?:cost|fee|payment)\b|\bonly pay if it works\b|\bpay (?:only )?(?:for|on) results\b/i, "pay-on-results pitch"],
  [/\btracking numbers?\b[^.]{0,40}\b(?:inject|upload|generat|valid)|\bcustomer service bandwidth\b|\bzero manual data entry\b/i, "fake tracking pitch"],
  [/\b(?:get|gain|buy|grow|boost(?:ing)?)\b[^.]{0,30}\bfollowers\b|\b\d[\d,]*\+? (?:real |organic |targeted )?(?:instagram |tiktok |ig )?followers\b/i, "followers pitch"],
  [/\bscreenconnect\b|\bsave the date\b|\byou(?:'ve| have) been invited\b|\bhas invited you to test\b|\bvia testflight\b/i, "invitation scam"],
  [/\bi (?:came across|noticed|found|visited|poked around) your (?:store|shop|site|website|etsy|brand)\b|\b(?:noticed|spotted|saw) (?:something|an issue|a few things|that)\b[^.]{0,40}\b(?:cart|store|site|website|checkout)\b/i, "cold sales email"],
  [/\bwe(?:'ve| have)? helped (?:\w+ )?(?:\w+ )?(?:brands|stores|shops|businesses|companies)\b|\b(?:book|schedule|hop on) a (?:quick |short |15[- ]minute )?(?:call|demo)\b|\bdashboard access\b|\breply with (?:your|a)\b/i, "sales pitch"],
  [/\bupsells?\b|\bcart drawer\b|\b(?:growth|pro) plan\b|\b(?:holiday|gift guide|retail|press|media) placements?\b|\bbuyers at (?:target|costco|walmart|nordstrom)\b/i, "sales pitch"],
];

/** Senders whose mail is bulk or notifications, never a buyer. */
const BULK_LOCAL = /^(?:no[-_]?reply|do[-_]?not[-_]?reply|donotreply|notifications?|notify|newsletters?|news|marketing|mailer|updates|digest|alerts?|promo(?:tions)?|bounces?)(?:[+._-].*)?$|[._-]no[-_]?reply$/i;
const BULK_DOMAINS = [
  "pinterest.com",
  "vistaprint.com",
  "printful.com",
  "buddify.com",
  "buddify.app",
  "canva.com",
  "mailchimp.com",
  "mcsv.net",
  "sendgrid.net",
  "brevosend.com",
  "sendinblue.com",
  "hubspotemail.net",
  "klaviyomail.com",
  "constantcontact.com",
  "substack.com",
  "linkedin.com",
  "trustpilot.com",
  "punchbowl.com",
  "screenconnect.com",
  "erfahrungen.app",
];
/** Free-mail domains: real people write from these. */
const FREE_MAIL = /(?:^|\.)(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|comcast|sbcglobal|att|verizon|proton|protonmail|gmx|mail|bigpond|optusnet)\.[a-z.]+$/i;

/** What a buyer writes about: the order, the art, the photos, the print, the pet. */
const BUYER_WORDS: RegExp[] = [
  /\b(?:my order|our order|the order i|i ordered|i (?:just )?(?:placed|purchased|bought)|cancel my order|refund)\b/i,
  /\b(?:my|the|our) (?:portrait|drawing|painting|artwork|print|proof|canvas|frame|package|parcel)\b/i,
  /\b(?:send|sent|attach(?:ed)?|here are|uploading|uploaded|share) (?:over |you )?(?:the |my |a )?(?:photos?|pictures?|pics?|images?)\b|\b(?:photos?|pictures?|pics?) (?:of|for) (?:my|our|the)\b/i,
  /\b(?:crease[sd]?|creased|damaged?|torn|smudged|faded|arrived broken|bent)\b/i,
  /\b(?:my|our) (?:dog|cat|pet|puppy|kitten|pup|baby|son|daughter|husband|wife|mom|mum|dad|family|grandma|grandpa)\b|\b(?:bichon|goldendoodle|doodle|retriever|labrador|poodle|terrier|husky|shepherd|chihuahua|dachshund|pug|bulldog|beagle|spaniel)\b/i,
];
/** Questions someone asks before they buy. */
const PRESALE = /\b(?:do|can|could) you (?:ship|deliver|post|draw|paint|make|do)\b|\bhow (?:much|long) (?:is|does|would|will)\b|\bhow (?:can|do) i (?:order|buy)\b|\bcomo posso\b/i;
/** A subject that is just "Photos" / "Pictures". */
const PHOTO_SUBJECT = /^\s*(?:re:\s*|fwd?:\s*)?(?:my |the )?(?:photos?|pictures?|pics?|images?)\b/i;
/** Order-number shapes our shops use: CPS10275, PC32131, an Etsy receipt. */
const ORDER_TOKEN = /\b(?:CPS|PC|DT|PF)\s?#?\d{3,7}\b|(?:^|[^\d])#?\s?4\d{9}(?!\d)/i;

function domainOf(email: string | null): string {
  return email ? (email.split("@")[1] ?? "").toLowerCase() : "";
}

function displayName(from: string | null): string {
  if (!from) return "";
  const m = from.match(/^\s*"?([^"<]*?)"?\s*</);
  return (m ? m[1] : "").trim();
}

/** "MetaAdsSupport" -> "Meta Ads Support", so brand words match inside run-together names. */
function splitWords(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ");
}

function fromBrand(domain: string, brand: { domains: string[] }): boolean {
  return brand.domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** True when the address is a big brand's own (real Etsy/Apple/Shopify mail): close, but never ignore it. */
export function isBrandSender(address: string | null): boolean {
  const domain = domainOf(parseEmailAddress(address));
  return !!domain && BRANDS.some((b) => fromBrand(domain, b));
}

/** Order numbers an email names: "order #123456", CPS10275, PC32131, an Etsy receipt. */
export function orderNumbersIn(subject: string | null, body: string | null): string[] {
  const text = `${subject ?? ""}\n${(body ?? "").slice(0, 4000)}`;
  const out = new Set<string>();
  const parsed = parseOrderNumber(subject, body);
  if (parsed) out.add(parsed);
  for (const m of text.matchAll(new RegExp(ORDER_TOKEN.source, "gi"))) {
    const n = m[0].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (n) out.add(n);
  }
  return [...out].slice(0, 5);
}

/**
 * Is this unmatched email from a buyer, junk, or unclear? Pure, and
 * conservative: junk means sure, because junk also ignores the sender for good.
 * An order number always keeps a mail; brand impersonation is judged on the
 * sender (display name, address), never on a subject a buyer quotes back; a
 * mail with both buyer words and pitch phrases is "unsure", not junk.
 */
export function classifyUnmatchedMail(input: { from: string | null; subject: string | null; excerpt: string | null }): MailVerdict {
  const email = parseEmailAddress(input.from);
  const local = email ? email.split("@")[0] : "";
  const domain = domainOf(email);
  const name = displayName(input.from);
  const subject = input.subject ?? "";
  const body = `${subject}\n${input.excerpt ?? ""}`;
  const text = `${name}\n${body}`;
  const sender = `${name} ${splitWords(name)} ${local} ${splitWords(local)} ${domain}`;

  if (/^(?:mailer-daemon|postmaster)$/i.test(local) || /mail delivery (?:failed|subsystem)|undeliverable|delivery status notification/i.test(body)) {
    return { verdict: "unsure", reason: "an email we sent bounced" };
  }
  for (const b of BRANDS) {
    if (b.words.test(sender) && !fromBrand(domain, b)) return { verdict: "junk", reason: `pretends to be ${b.name}` };
  }
  const named = ORDER_TOKEN.test(body);
  const scam = SCAM.find(([re]) => re.test(body));
  if (scam && !named) {
    const brand = BRANDS.find((b) => b.words.test(`${subject}\n${(input.excerpt ?? "").slice(0, 300)}`) && !fromBrand(domain, b));
    return { verdict: "junk", reason: brand ? `pretends to be ${brand.name}` : scam[1] };
  }
  if (named) return { verdict: "customer", reason: "names an order" };

  if (BULK_LOCAL.test(local)) return { verdict: "junk", reason: "automated sender" };
  if (BULK_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return { verdict: "junk", reason: "newsletter or notification" };
  for (const b of BRANDS) {
    if (fromBrand(domain, b)) return { verdict: "junk", reason: `notification from ${b.name}` };
  }

  const pitches = PITCH.filter(([re]) => re.test(text));
  const buyerHits = BUYER_WORDS.filter((re) => re.test(body)).length + (PHOTO_SUBJECT.test(subject) ? 1 : 0);
  const presale = PRESALE.test(body);
  if (pitches.length && !buyerHits && !presale) return { verdict: "junk", reason: pitches[0][1] };
  if (pitches.length >= 2 && buyerHits <= 1) return { verdict: "junk", reason: pitches[0][1] };
  if (buyerHits && !pitches.length) return { verdict: "customer", reason: "talks about an order" };
  if (presale && !pitches.length) return { verdict: "customer", reason: "asks before buying" };
  if (pitches.length) return { verdict: "unsure", reason: "reads like a buyer and a sales pitch" };
  if (!email) return { verdict: "unsure", reason: "no sender address" };
  return { verdict: "unsure", reason: FREE_MAIL.test(domain) ? "a person we do not know" : "a company we do not know" };
}

/** The recommendation line the owner sees for mail that stays open. */
export function mailRecommendation(v: MailVerdict, candidates: { orderNumber: string }[] = []): string {
  if (v.reason === "an email we sent bounced") return "Check the buyer's email address on the order this was for, fix it, and resend.";
  if (candidates.length > 1) {
    return `From a buyer with ${candidates.length} orders (${candidates.map((c) => c.orderNumber).join(", ")}): attach it to the right one.`;
  }
  if (v.reason === "asks before buying") return "Someone asking before they buy: reply from the shop inbox, or press Ignore sender if it is spam.";
  if (v.verdict === "customer") return "Looks like a buyer: find their order by name and attach this email, or reply asking for their order number.";
  return "If it is not a buyer, press Ignore sender; if it is, attach it to their order.";
}

type MailRow = {
  exceptionId: string;
  createdAt: Date;
  detail: Record<string, unknown>;
  messageId: string | null;
  msgOrderId: string | null;
  msgArchived: boolean;
  msgSuppressed: boolean;
  address: string | null;
  subject: string | null;
  body: string | null;
};

type OrderRef = { id: string; number: string; live: boolean };

const orderNumberSql = sql<string>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`;

/**
 * Which order of this business an email belongs to. An order number it names
 * wins; otherwise the sender's orders: their one live order, or (no live one)
 * their latest order (an after-sale email is about the last thing they got).
 * Several live orders come back as candidates for the owner to pick from.
 */
export async function matchOrders(
  tx: Tx,
  businessId: string,
  input: { email: string | null; numbers: string[] },
): Promise<{ match: OrderRef | null; candidates: OrderRef[] }> {
  for (const raw of input.numbers) {
    const num = raw.replace(/^#/, "").toUpperCase();
    const byNumber = await tx
      .select({ id: orders.id, number: orderNumberSql, live: sql<boolean>`${orders.archivedAt} is null` })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          sql`(upper(${orders.platformOrderId}) = ${num} or upper(replace(${orders.platformOrderName}, '#', '')) = ${num})`,
        ),
      )
      .limit(2);
    if (byNumber.length === 1) return { match: byNumber[0], candidates: [] };
  }
  if (!input.email) return { match: null, candidates: [] };
  const theirs = await tx
    .select({
      id: orders.id,
      number: orderNumberSql,
      live: sql<boolean>`${orders.archivedAt} is null and ${orders.status}::text not in ('cancelled', 'complete', 'delivered', 'shipped')`,
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(
        eq(orders.businessId, businessId),
        sql`lower(${customers.email}) = ${input.email}`,
        sql`${orders.status}::text not in ('cancelled', 'fulfillment_only')`,
      ),
    )
    .orderBy(sql`coalesce(${orders.placedAt}, ${orders.createdAt}) desc`)
    .limit(8);
  const live = theirs.filter((o) => o.live);
  if (live.length === 1) return { match: live[0], candidates: [] };
  if (live.length > 1) return { match: null, candidates: live };
  return { match: theirs[0] ?? null, candidates: [] };
}

/**
 * Close the mail as not a customer: suppress it and ignore that exact address
 * for the business. A big brand's own address (real Etsy or Apple mail) is
 * never ignored, only this message is put away.
 */
async function clearJunkTx(tx: Tx, businessId: string, input: { messageId: string | null; address: string | null; reason: string }, now: Date) {
  const email = parseEmailAddress(input.address);
  if (email && !isBrandSender(email)) {
    await tx
      .insert(emailSenderIgnores)
      .values({ businessId, value: email, matchType: "email", note: `auto: not a customer (${input.reason})`, active: true, createdBy: null })
      .onConflictDoNothing();
  }
  if (input.messageId) {
    await tx
      .update(messages)
      .set({ suppressedAt: now, suppressedReason: `Not a customer: ${input.reason}` })
      .where(and(eq(messages.id, input.messageId), sql`${messages.suppressedAt} is null`));
  }
}

/** Link the email to its order and hand the order a reply card (an open one gets the message added). */
async function attachToOrderTx(tx: Tx, businessId: string, row: MailRow, order: OrderRef): Promise<string | null> {
  if (!row.messageId) return null;
  await tx.update(messages).set({ orderId: order.id }).where(and(eq(messages.id, row.messageId), sql`${messages.orderId} is null`));
  const opened = await openExceptionTx(tx, {
    businessId,
    orderId: order.id,
    kind: "reply_unclear",
    summary: `Buyer email on order ${order.number} needs a reply`,
    detail: {
      messageId: row.messageId,
      from: row.address,
      subject: row.subject,
      excerpt: typeof row.detail.excerpt === "string" ? row.detail.excerpt : (row.body ?? "").slice(0, 600),
      recommendation: "Read the buyer's email on the order page and reply.",
    },
  });
  if (!opened.created) {
    await tx
      .update(exceptions)
      .set({
        detail: sql`jsonb_set(${exceptions.detail}, '{messageIds}', coalesce(${exceptions.detail}->'messageIds', '[]'::jsonb) || to_jsonb(${row.messageId}::text))`,
      })
      .where(eq(exceptions.id, opened.id));
  }
  await tx.insert(activityLog).values([
    ...(opened.created
      ? [{ businessId, orderId: order.id, actorId: null, action: "agent.exception_opened", metadata: { exceptionId: opened.id, kind: "reply_unclear" } }]
      : []),
    {
      businessId,
      orderId: order.id,
      actorId: null,
      action: "agent.reply_escalated",
      metadata: { messageId: row.messageId, kind: "reply_unclear", exceptionId: opened.id, matchedFromUnmatched: true },
    },
  ]);
  return opened.id;
}

export type ClearMailResult = {
  checked: number;
  matched: number;
  legacy: number;
  junk: number;
  kept: number;
  gone: number;
  /** Rows closed (dry run: that would close). */
  closedIds: string[];
};

/** L2 over every open unmatched_reply of one business. */
export async function clearUnmatchedReplies(businessId: string, opts: { now?: Date; dryRun?: boolean } = {}): Promise<ClearMailResult> {
  const now = opts.now ?? new Date();
  return withSystemContext(async (tx) => {
    const rows: MailRow[] = await tx
      .select({
        exceptionId: exceptions.id,
        createdAt: exceptions.createdAt,
        detail: sql<Record<string, unknown>>`coalesce(${exceptions.detail}, '{}'::jsonb)`,
        messageId: sql<string | null>`${messages.id}`,
        msgOrderId: messages.orderId,
        msgArchived: sql<boolean>`${messages.archivedAt} is not null`,
        msgSuppressed: sql<boolean>`${messages.suppressedAt} is not null`,
        address: sql<string | null>`coalesce(${messages.address}, ${exceptions.detail}->>'from')`,
        subject: sql<string | null>`coalesce(${messages.subject}, ${exceptions.detail}->>'subject')`,
        body: messages.body,
      })
      .from(exceptions)
      .leftJoin(messages, sql`${messages.id} = ${exceptions.detail}->>'messageId'`)
      .where(and(eq(exceptions.businessId, businessId), eq(exceptions.kind, "unmatched_reply"), eq(exceptions.status, "open")));

    const res: ClearMailResult = { checked: rows.length, matched: 0, legacy: 0, junk: 0, kept: 0, gone: 0, closedIds: [] };
    const close: { id: string; businessId: string; orderId: string | null; kind: string; reason: string }[] = [];
    for (const row of rows) {
      const shut = (reason: string) => close.push({ id: row.exceptionId, businessId, orderId: null, kind: "unmatched_reply", reason });
      if (row.msgOrderId) {
        res.gone++;
        shut("already linked to an order");
        continue;
      }
      if (row.msgArchived || row.msgSuppressed) {
        res.gone++;
        shut(row.msgSuppressed ? "sender ignored" : "email archived");
        continue;
      }
      const email = parseEmailAddress(row.address);
      const excerpt = typeof row.detail.excerpt === "string" ? row.detail.excerpt : (row.body ?? "").slice(0, 600);
      const numbers = orderNumbersIn(row.subject, row.body ?? excerpt);
      const found = await matchOrders(tx, businessId, { email, numbers });
      if (found.match) {
        res.matched++;
        if (!opts.dryRun) await attachToOrderTx(tx, businessId, row, found.match);
        shut(`matched to order ${found.match.number}`);
        continue;
      }
      // An order number we do not have: an older (pre-AlphaOS) order. Same as
      // the inbox pass does for new mail: a stub order with one card.
      if (numbers.length && row.messageId && !found.candidates.length) {
        if (opts.dryRun) {
          res.legacy++;
          shut("moved to an older-order card");
          continue;
        }
        const stub = await ensureLegacyStub(tx, row.messageId);
        if (stub) {
          res.legacy++;
          await tx.insert(activityLog).values({
            businessId,
            orderId: stub.orderId,
            actorId: null,
            action: "agent.reply_escalated",
            metadata: { messageId: row.messageId, kind: "legacy_order", exceptionId: stub.exceptionId },
          });
          shut("moved to an older-order card");
          continue;
        }
      }
      const v = classifyUnmatchedMail({ from: row.address, subject: row.subject, excerpt });
      if (v.verdict === "junk" && !found.candidates.length) {
        res.junk++;
        if (!opts.dryRun) await clearJunkTx(tx, businessId, { messageId: row.messageId, address: row.address, reason: v.reason }, now);
        shut(`not a customer (${v.reason})`);
        continue;
      }
      res.kept++;
      const recommendation = mailRecommendation(v, found.candidates.map((m) => ({ orderNumber: m.number })));
      if (!opts.dryRun && row.detail.recommendation !== recommendation) {
        await tx
          .update(exceptions)
          .set({ detail: sql`coalesce(${exceptions.detail}, '{}'::jsonb) || ${JSON.stringify({ recommendation, verdict: v.verdict, verdictReason: v.reason })}::jsonb` })
          .where(eq(exceptions.id, row.exceptionId));
      }
    }
    if (!opts.dryRun) await autoResolveTx(tx, close, now);
    res.closedIds = close.map((c) => c.id);
    return res;
  });
}

/**
 * The inbox pass's gate for NEW mail, before it opens an unmatched_reply: junk
 * from a sender who names none of our orders is cleared on the spot (message
 * suppressed, address ignored, `agent.mail_cleared` logged so it is never
 * picked up again). Returns the verdict either way; the caller puts the
 * recommendation on the card it opens.
 */
export async function screenNewMailTx(
  tx: Tx,
  input: { businessId: string; messageId: string; from: string | null; subject: string | null; excerpt: string; hasCandidates: boolean },
  now: Date,
): Promise<{ cleared: boolean; verdict: MailVerdict }> {
  const verdict = classifyUnmatchedMail({ from: input.from, subject: input.subject, excerpt: input.excerpt });
  if (verdict.verdict !== "junk" || input.hasCandidates) return { cleared: false, verdict };
  await clearJunkTx(tx, input.businessId, { messageId: input.messageId, address: input.from, reason: verdict.reason }, now);
  await tx.insert(activityLog).values({
    businessId: input.businessId,
    orderId: null,
    actorId: null,
    action: "agent.mail_cleared",
    metadata: { messageId: input.messageId, reason: verdict.reason },
  });
  return { cleared: true, verdict };
}
