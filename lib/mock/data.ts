/**
 * Mock integration data (2026-09-08).
 *
 * Deterministic, time-driven fixtures for every external system AlphaOS talks
 * to, so the whole pipeline runs end to end with credentials that LOOK real
 * (shpat_mock_…, etsy mock_… keystrings, a Gmail refresh token, a Gelato key)
 * but never leave the process. Everything here is a pure function of the
 * clock and a seed string, so two calls agree, a cron tick that runs twice
 * sees the same orders, and "new" orders keep arriving on a schedule:
 *
 *   - a Shopify shop places one order every ORDER_INTERVAL_MIN minutes,
 *   - an Etsy shop one receipt every ETSY_INTERVAL_MIN minutes,
 *   - the shop mailbox gets an Etsy notification every MAIL_INTERVAL_MIN
 *     minutes (sale, then a buyer message, then a proof reply, repeating).
 *
 * No real people: every buyer is generated, every email is @example.com,
 * every photo is a picsum placeholder. Used by lib/mock/transport.ts.
 */

export const ANCHOR_MS = Date.parse("2026-09-01T00:00:00.000Z");
export const ORDER_INTERVAL_MIN = 25;
export const ETSY_INTERVAL_MIN = 40;
export const MAIL_INTERVAL_MIN = 30;
/** How far back a first sync may reach: keeps a fresh mock shop to a few dozen orders. */
export const MAX_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

const FIRST = ["Alice", "Ben", "Chloe", "Daniel", "Erin", "Finn", "Grace", "Hugo", "Isla", "Jack", "Kira", "Liam", "Maya", "Noah", "Olivia", "Priya", "Quinn", "Rosa", "Sam", "Tessa"];
const LAST = ["Nguyen", "Carter", "Diaz", "Evans", "Ford", "Gray", "Hill", "Iyer", "Jones", "Kerr", "Lowe", "Moreno", "Novak", "Osei", "Patel", "Quist", "Reid", "Silva", "Tan", "Walsh"];
const PETS = ["Milo", "Luna", "Bella", "Charlie", "Max", "Coco", "Daisy", "Rocky", "Poppy", "Ollie", "Nala", "Ziggy"];
const CITIES: [string, string, string, string][] = [
  ["Austin", "Texas", "TX", "78701"],
  ["Denver", "Colorado", "CO", "80202"],
  ["Portland", "Oregon", "OR", "97205"],
  ["Nashville", "Tennessee", "TN", "37203"],
  ["Tampa", "Florida", "FL", "33602"],
  ["Phoenix", "Arizona", "AZ", "85004"],
  ["Columbus", "Ohio", "OH", "43215"],
  ["Raleigh", "North Carolina", "NC", "27601"],
  ["Melbourne", "Victoria", "VIC", "3000"],
  ["Sydney", "New South Wales", "NSW", "2000"],
];
const STREETS = ["Maple St", "Oak Ave", "Cedar Ln", "Pine Ct", "Elm Dr", "Birch Rd", "Willow Way", "Lakeview Blvd"];
const SIZES = ['Poster Print 8"X10" / 20X25cm', 'Poster Print 12"X16" / 30X40cm', 'Canvas 16"X20" / 40X50cm', "Digital File Only"];
const STYLES = ["Cartoon", "Watercolor", "Renaissance", "Line Art"];
const PRODUCTS: { title: string; sku: string; kind: "pet" | "family" | "couple" }[] = [
  { title: "Custom Hand-Drawn Cartoon Pet Portrait", sku: "PET-CARTOON", kind: "pet" },
  { title: "Custom Family Portrait from Photo", sku: "FAM-ILLUS", kind: "family" },
  { title: "Custom Couple Portrait, Personalised Anniversary Gift", sku: "CPL-ILLUS", kind: "couple" },
  { title: "Custom Watercolor Pet Portrait from Photo", sku: "PET-WATER", kind: "pet" },
];
const BACKGROUNDS = ["Sunset", "Studio Grey", "Forest", "Beach", "Plain White", "Night Sky"];
const NOTES = [
  "Please make the collar red like in the photo.",
  "Can you include our dog's bandana?",
  "It's a surprise gift, no rush but please keep the eyes accurate.",
  "",
  "Same pose as the second photo please.",
  "",
];

/* --- deterministic randomness -------------------------------------------- */

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: string): () => number {
  let a = hashSeed(seed) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, list: T[]): T => list[Math.floor(r() * list.length)];

export type MockBuyer = {
  firstName: string;
  lastName: string;
  email: string;
  address1: string;
  city: string;
  province: string;
  provinceCode: string;
  zip: string;
  countryCode: string;
  phone: string;
};

export function buyerFor(seed: string): MockBuyer {
  const r = rng("buyer:" + seed);
  const firstName = pick(r, FIRST);
  const lastName = pick(r, LAST);
  const [city, province, provinceCode, zip] = pick(r, CITIES);
  const au = provinceCode === "VIC" || provinceCode === "NSW";
  return {
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(r() * 90 + 10)}@example.com`,
    address1: `${Math.floor(r() * 900 + 100)} ${pick(r, STREETS)}`,
    city,
    province,
    provinceCode,
    zip,
    countryCode: au ? "AU" : "US",
    phone: au ? `+61 4${Math.floor(r() * 90000000 + 10000000)}` : `+1 ${Math.floor(r() * 900 + 100)} 555 ${String(Math.floor(r() * 9000 + 1000))}`,
  };
}

/** Index of the newest arrival at or before `atMs` for a given interval. */
export function arrivalsUpTo(atMs: number, intervalMin: number, seed: string): number[] {
  const r = rng("jitter:" + seed);
  const step = intervalMin * 60 * 1000;
  const out: number[] = [];
  for (let k = 0; ; k++) {
    const jitter = Math.floor(r() * step * 0.6) - step * 0.3;
    const t = ANCHOR_MS + k * step + jitter;
    if (t > atMs) break;
    out.push(t);
    if (k > 100000) break;
  }
  return out;
}

/* --- Shopify ----------------------------------------------------------- */

export type ShopifyMockOrder = {
  id: string;
  name: string;
  sourceName: string;
  legacyResourceId: string;
  createdAt: string;
  email: string;
  customer: { firstName: string; lastName: string; email: string };
  shippingAddress: {
    firstName: string;
    lastName: string;
    company: null;
    address1: string;
    address2: null;
    city: string;
    province: string;
    provinceCode: string;
    zip: string;
    countryCodeV2: string;
    phone: string;
  };
  lineItems: {
    nodes: {
      sku: string | null;
      title: string | null;
      variantTitle: string | null;
      quantity: number;
      requiresShipping: boolean;
      variant: { selectedOptions: { name: string; value: string }[] } | null;
      customAttributes: { key: string; value: string | null }[];
    }[];
  };
};

function orderPrefix(shopDomain: string): string {
  return shopDomain.toLowerCase().startsWith("lumina") ? "LM" : "PC";
}

export function shopifyOrderAt(shopDomain: string, k: number, createdMs: number): ShopifyMockOrder {
  const seed = `${shopDomain}:${k}`;
  const r = rng("order:" + seed);
  const buyer = buyerFor(seed);
  const product = pick(r, PRODUCTS);
  const figures = product.kind === "couple" ? 2 : product.kind === "family" ? Math.floor(r() * 3) + 2 : Math.floor(r() * 3) + 1;
  const size = pick(r, SIZES);
  const style = pick(r, STYLES);
  const digital = size === "Digital File Only";
  const names = Array.from({ length: figures }, () => pick(r, PETS)).join(" & ");
  const number = 32000 + k;
  const attrs: { key: string; value: string | null }[] = [
    { key: product.kind === "pet" ? "Pet Names" : "Names", value: names },
    { key: "Background", value: pick(r, BACKGROUNDS) },
  ];
  const note = pick(r, NOTES);
  if (note) attrs.push({ key: "Notes", value: note });
  const photos = Math.max(1, Math.min(figures, 3));
  for (let p = 1; p <= photos; p++) attrs.push({ key: `_photo_${p}`, value: `https://picsum.photos/seed/${orderPrefix(shopDomain)}${number}${p}/900/900` });
  const nodes: ShopifyMockOrder["lineItems"]["nodes"] = [
    {
      sku: `${product.sku}-${figures}F`,
      title: product.title,
      variantTitle: `${figures} ${figures === 1 ? "Figure" : "Figures"} / ${size} / ${style}`,
      quantity: 1,
      requiresShipping: !digital,
      variant: {
        selectedOptions: [
          { name: "Number of Figures", value: `${figures} ${figures === 1 ? "Figure" : "Figures"}` },
          { name: "Size", value: size },
          { name: "Style", value: style },
        ],
      },
      customAttributes: attrs,
    },
  ];
  if (r() < 0.2) {
    nodes.push({ sku: null, title: "Rush My Order (24h design)", variantTitle: null, quantity: 1, requiresShipping: false, variant: null, customAttributes: [] });
  }
  return {
    id: `gid://shopify/Order/${6100000000 + k}`,
    name: `${orderPrefix(shopDomain)}${number}`,
    sourceName: "web",
    legacyResourceId: String(6100000000 + k),
    createdAt: new Date(createdMs).toISOString(),
    email: buyer.email,
    customer: { firstName: buyer.firstName, lastName: buyer.lastName, email: buyer.email },
    shippingAddress: {
      firstName: buyer.firstName,
      lastName: buyer.lastName,
      company: null,
      address1: buyer.address1,
      address2: null,
      city: buyer.city,
      province: buyer.province,
      provinceCode: buyer.provinceCode,
      zip: buyer.zip,
      countryCodeV2: buyer.countryCode,
      phone: buyer.phone,
    },
    lineItems: { nodes },
  };
}

/** Orders created at or after `sinceMs`, up to now, oldest first. */
export function shopifyOrdersSince(shopDomain: string, sinceMs: number, nowMs = Date.now()): ShopifyMockOrder[] {
  const floor = Math.max(sinceMs, nowMs - MAX_LOOKBACK_MS);
  return arrivalsUpTo(nowMs, ORDER_INTERVAL_MIN, shopDomain)
    .map((t, k) => ({ t, k }))
    .filter(({ t }) => t >= floor)
    .map(({ t, k }) => shopifyOrderAt(shopDomain, k, t));
}

export function shopifyOrderByLegacyId(shopDomain: string, legacyId: string, nowMs = Date.now()): ShopifyMockOrder | null {
  const k = Number(legacyId) - 6100000000;
  if (!Number.isInteger(k) || k < 0) return null;
  const arrivals = arrivalsUpTo(nowMs, ORDER_INTERVAL_MIN, shopDomain);
  if (k >= arrivals.length) return null;
  return shopifyOrderAt(shopDomain, k, arrivals[k]);
}

/* --- Etsy -------------------------------------------------------------- */

export type EtsyMockReceipt = {
  receipt_id: number;
  created_timestamp: number;
  name: string;
  buyer_email: string;
  first_line: string;
  second_line: null;
  city: string;
  state: string;
  zip: string;
  country_iso: string;
  formatted_address: string;
  transactions: {
    transaction_id: number;
    title: string;
    sku: string;
    quantity: number;
    is_digital: boolean;
    listing_id: number;
    variations: { property_id: number; formatted_name: string; formatted_value: string }[];
  }[];
};

export function etsyReceiptAt(etsyShopId: string, k: number, createdMs: number): EtsyMockReceipt {
  const seed = `etsy:${etsyShopId}:${k}`;
  const r = rng("receipt:" + seed);
  const buyer = buyerFor(seed);
  const product = pick(r, PRODUCTS);
  const figures = product.kind === "couple" ? 2 : Math.floor(r() * 3) + 1;
  const size = pick(r, SIZES);
  const digital = size === "Digital File Only";
  return {
    receipt_id: 3300000000 + k,
    created_timestamp: Math.floor(createdMs / 1000),
    name: `${buyer.firstName} ${buyer.lastName}`,
    buyer_email: buyer.email,
    first_line: buyer.address1,
    second_line: null,
    city: buyer.city,
    state: buyer.provinceCode,
    zip: buyer.zip,
    country_iso: buyer.countryCode,
    formatted_address: `${buyer.firstName} ${buyer.lastName}\n${buyer.address1}\n${buyer.city}, ${buyer.provinceCode} ${buyer.zip}\n${buyer.countryCode === "AU" ? "Australia" : "United States"}`,
    transactions: [
      {
        transaction_id: 4400000000 + k,
        title: `${product.title}, Personalised Gift`,
        sku: `${product.sku}-${figures}F`,
        quantity: 1,
        is_digital: digital,
        listing_id: 1700000000 + (hashSeed(product.sku) % 1000),
        variations: [
          { property_id: 100, formatted_name: product.kind === "pet" ? "Number of Pets" : "Number of People", formatted_value: `${figures}` },
          { property_id: 101, formatted_name: "Size", formatted_value: size },
        ],
      },
    ],
  };
}

export function etsyReceiptsSince(etsyShopId: string, minCreatedSec: number, nowMs = Date.now()): EtsyMockReceipt[] {
  const floor = Math.max(minCreatedSec * 1000, nowMs - MAX_LOOKBACK_MS);
  return arrivalsUpTo(nowMs, ETSY_INTERVAL_MIN, "etsy:" + etsyShopId)
    .map((t, k) => ({ t, k }))
    .filter(({ t }) => t >= floor)
    .map(({ t, k }) => etsyReceiptAt(etsyShopId, k, t));
}

/* --- Gmail (Etsy notifications landing in the shop mailbox) ----------- */

export type MockMail = {
  id: string;
  threadId: string;
  historyId: number;
  internalDate: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
};

const BUYER_QUESTIONS = [
  "Hi! Just checking, can you make the background a bit lighter than in my photo?",
  "Hello, when will I get to see the preview? So excited!",
  "Could you add our cat's name under the drawing? Her name is Nala.",
  "Is it possible to change the frame colour to black? Thanks so much.",
];

/**
 * The mailbox timeline for a business: every MAIL_INTERVAL_MIN a new Etsy
 * notification lands. Kinds rotate sale -> message -> sale -> message so the
 * inbound parser sees both shapes. `etsyShopName` must be the seeded Etsy
 * shop's name (the sale email names it, and the inbound matcher looks the
 * shop up by that name).
 */
export function mailboxSince(opts: { address: string; etsyShopName: string; etsyShopId: string; afterHistoryId: number; nowMs?: number }): MockMail[] {
  const nowMs = opts.nowMs ?? Date.now();
  const arrivals = arrivalsUpTo(nowMs, MAIL_INTERVAL_MIN, "mail:" + opts.address);
  const floor = nowMs - 24 * 60 * 60 * 1000;
  const out: MockMail[] = [];
  // Ids are per mailbox: the app deduplicates on the Gmail message id, so two
  // businesses must never share one.
  const box = hashSeed(opts.address).toString(36).slice(0, 5);
  arrivals.forEach((t, k) => {
    const historyId = 1000 + k;
    if (historyId <= opts.afterHistoryId || t < floor) return;
    const r = rng(`mail:${opts.address}:${k}`);
    const sale = k % 2 === 0;
    // Tie the sale email to a receipt this shop's Etsy mock will also serve.
    const receipts = etsyReceiptsSince(opts.etsyShopId, 0, t);
    const receipt = receipts[receipts.length - 1];
    if (sale && receipt) {
      out.push({
        id: `mock-mail-${box}-${k}`,
        threadId: `mock-thread-${box}-${k}`,
        historyId,
        internalDate: t,
        from: "Etsy <transaction@etsy.com>",
        to: opts.address,
        subject: `You made a sale on Etsy! Order #${receipt.receipt_id}`,
        body:
          `Congratulations! You made a sale in your shop, ${opts.etsyShopName}!\n\n` +
          `Order #${receipt.receipt_id}\n` +
          `Buyer: ${receipt.name}\n` +
          `Item: ${receipt.transactions[0].title}\n` +
          `Quantity: 1\n` +
          `Ship to:\n${receipt.formatted_address}\n\n` +
          `View the order: https://www.etsy.com/your/orders/sold/${receipt.receipt_id}\n\n` +
          `--\nThis email was sent by Etsy, Inc.`,
      });
    } else {
      const buyer = buyerFor(`mail:${opts.address}:${k}`);
      const name = `${buyer.firstName} ${buyer.lastName}`;
      const q = pick(r, BUYER_QUESTIONS);
      out.push({
        id: `mock-mail-${box}-${k}`,
        threadId: `mock-thread-${box}-${k}`,
        historyId,
        internalDate: t,
        from: "Etsy <convos@etsy.com>",
        to: opts.address,
        subject: `New message from ${name}`,
        body:
          `${name} sent you a message:\n\n"${q}"\n\n` +
          (receipt ? `Regarding Order #${receipt.receipt_id}\n` : "") +
          `Reply on Etsy: https://www.etsy.com/your/conversations/mock-${k}\n\n--\nThis email was sent by Etsy, Inc.`,
      });
    }
  });
  return out;
}

/* --- Anthropic ---------------------------------------------------------- */

export function mockClassifierAnswer(replyText: string): string {
  const t = replyText.toLowerCase();
  let intent = "unclear";
  let confidence = 0.42;
  let rationale = "Not enough in the reply to decide.";
  if (/approve|approved|looks great|love it|perfect|go ahead|print it|ship it|happy with/.test(t)) {
    intent = "approval";
    confidence = 0.94;
    rationale = "Customer clearly approves the proof and wants it to proceed.";
  } else if (/change|fix|wrong|instead|could you|can you make|please make|lighter|darker|bigger|smaller|remove|add /.test(t)) {
    intent = "revision_request";
    confidence = 0.9;
    rationale = "Customer asks for a visual change to the portrait.";
  } else if (/\?/.test(t)) {
    intent = "question";
    confidence = 0.72;
    rationale = "Customer asks a question without approving or requesting changes.";
  }
  return JSON.stringify({ intent, confidence, rationale });
}

export function mockNarrative(prompt: string): string {
  const jsonStart = prompt.indexOf("{");
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(prompt.slice(jsonStart)) as Record<string, unknown>;
  } catch {}
  const num = (k: string) => {
    const v = payload[k];
    return typeof v === "number" ? v : null;
  };
  const healthy = payload.healthy === true;
  if (healthy) return "Nothing needs attention today. Orders are moving on time, no proofs are waiting past their window, and print is keeping up.";
  const parts: string[] = [];
  const overdue = num("overdueOrders") ?? num("overdue");
  const awaitingQc = num("awaitingQc");
  const silent = num("silentCustomers") ?? num("customersSilent");
  const missingPrint = num("missingPrintOrders") ?? num("printMissing");
  if (overdue) parts.push(`${overdue} order${overdue === 1 ? " is" : "s are"} past due and should be reassigned or chased first.`);
  if (awaitingQc) parts.push(`${awaitingQc} proof${awaitingQc === 1 ? " is" : "s are"} waiting on QC, so the VA queue is the next bottleneck.`);
  if (silent) parts.push(`${silent} customer${silent === 1 ? " has" : "s have"} gone quiet after a question; reminders are running and day 7 approvals will apply.`);
  if (missingPrint) parts.push(`${missingPrint} approved order${missingPrint === 1 ? " has" : "s have"} no print order yet, which is the one thing that slips silently.`);
  if (!parts.length) parts.push("A few items need a look but nothing is on fire; the queue is moving and the numbers are in line with last week.");
  return parts.join(" ");
}
