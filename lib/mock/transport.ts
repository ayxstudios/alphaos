/**
 * Mock transport (2026-09-08): one fetch interceptor for every external API.
 *
 * Installed once per process by `installMockTransport()` (instrumentation.ts
 * when MOCK_INTEGRATIONS=1, or explicitly from a script). It decides per
 * request, by the CREDENTIAL the caller presents, whether to answer from
 * lib/mock/data.ts or pass the call through untouched:
 *
 *   Shopify   X-Shopify-Access-Token starts with "shpat_mock"
 *   Etsy      x-api-key starts with "mock_" (token refresh: refresh_token mock_…)
 *   Gmail     Authorization: Bearer mock_… (token refresh: refresh_token mock_…)
 *   Anthropic x-api-key starts with "mock_"
 *   Gelato    X-API-KEY starts with "mock_"   (also PRINT_PROVIDER_MOCK=1)
 *   Luma      Basic auth user starts with "mock_"
 *
 * So a real shop with a real key on the same deployment is never touched:
 * the mock is a property of the credential, not of the environment. The
 * bodies returned are the exact subset of each API the app's clients read.
 */
import {
  etsyReceiptsSince,
  mailboxSince,
  mockClassifierAnswer,
  mockNarrative,
  shopifyOrderByLegacyId,
  shopifyOrdersSince,
  type MockMail,
} from "./data";

type Handler = (req: Request, url: URL) => Promise<Response | null>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let installed = false;
let realFetch: typeof fetch;

/** Sent mail the mock remembers so a customer "reply" can land on its thread. */
const sentProofThreads: { threadId: string; to: string; subject: string; sentAt: number; replied: boolean }[] = [];

export function mockState() {
  return { installed, sentProofThreads };
}

function headerOf(req: Request, name: string): string {
  return req.headers.get(name) ?? "";
}

async function bodyText(req: Request): Promise<string> {
  try {
    return await req.clone().text();
  } catch {
    return "";
  }
}

/* --- Shopify ----------------------------------------------------------- */

const shopify: Handler = async (req, url) => {
  if (!url.hostname.endsWith(".myshopify.com")) return null;
  if (url.pathname.endsWith("/admin/oauth/access_token")) {
    const text = await bodyText(req);
    if (!/client_id=mock_|"client_id":"mock_/.test(text)) return null;
    return json({ access_token: "shpat_mock_cc_" + Date.now().toString(36), scope: "read_orders,write_orders", expires_in: 86399 });
  }
  const token = headerOf(req, "X-Shopify-Access-Token");
  if (!token.startsWith("shpat_mock")) return null;
  const shopDomain = url.hostname;
  const { query = "", variables = {} } = JSON.parse((await bodyText(req)) || "{}") as { query?: string; variables?: Record<string, unknown> };
  const cost = { requestedQueryCost: 10, actualQueryCost: 10, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } };
  const reply = (data: unknown) => json({ data, extensions: { cost } });

  if (/^\s*\{\s*shop\s*\{\s*name\s*\}\s*\}/.test(query) || /query\s*\{\s*shop\s*\{/.test(query)) {
    return reply({ shop: { name: shopDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) } });
  }
  if (/\borders\s*\(/.test(query)) {
    const q = String(variables.q ?? "");
    const m = q.match(/created_at:>=?'([^']+)'/);
    const since = m ? Date.parse(m[1]) : Date.now() - 24 * 3600 * 1000;
    const all = shopifyOrdersSince(shopDomain, since);
    const PAGE = 50;
    const start = variables.cursor ? Number(variables.cursor) : 0;
    const nodes = all.slice(start, start + PAGE);
    const hasNextPage = start + PAGE < all.length;
    return reply({ orders: { pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + PAGE) : null }, nodes } });
  }
  if (/webhookSubscriptionCreate/.test(query)) {
    const sub = variables.webhookSubscription as { callbackUrl?: string; uri?: string } | undefined;
    return reply({
      webhookSubscriptionCreate: {
        webhookSubscription: { id: "gid://shopify/WebhookSubscription/9001", topic: "ORDERS_CREATE", uri: sub?.callbackUrl ?? sub?.uri ?? null },
        userErrors: [],
      },
    });
  }
  if (/webhookSubscriptions/.test(query)) {
    const expected = process.env.SHOPIFY_WEBHOOK_URL || `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/webhooks/shopify/orders-create`;
    return reply({
      webhookSubscriptions: {
        nodes: [
          {
            id: "gid://shopify/WebhookSubscription/9001",
            topic: "ORDERS_CREATE",
            format: "JSON",
            createdAt: "2026-09-01T00:00:00Z",
            updatedAt: "2026-09-01T00:00:00Z",
            endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: expected },
          },
        ],
      },
    });
  }
  if (/fulfillmentCreate/.test(query)) {
    return reply({ fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/" + Date.now(), status: "SUCCESS" }, userErrors: [] } });
  }
  if (/orderClose/.test(query)) {
    const input = variables.input as { id?: string } | undefined;
    return reply({ orderClose: { order: { id: input?.id ?? "gid://shopify/Order/0" }, userErrors: [] } });
  }
  if (/fulfillmentOrders/.test(query)) {
    const id = String(variables.id ?? "gid://shopify/Order/0");
    return reply({
      order: {
        id,
        name: null,
        fulfillmentOrders: { nodes: [{ id: id.replace("Order", "FulfillmentOrder"), status: "OPEN", requestStatus: "UNSUBMITTED", supportedActions: [{ action: "CREATE_FULFILLMENT" }] }] },
      },
    });
  }
  if (/\border\s*\(/.test(query)) {
    const id = String(variables.id ?? "");
    const legacy = id.split("/").pop() ?? "";
    const order = shopifyOrderByLegacyId(shopDomain, legacy);
    if (/featuredImage|product\s*\{/.test(query)) {
      return reply({
        order: order
          ? {
              lineItems: {
                nodes: order.lineItems.nodes.map((li) => ({
                  sku: li.sku,
                  title: li.title,
                  variantTitle: li.variantTitle,
                  product: li.sku ? { title: li.title, handle: (li.sku || "").toLowerCase(), onlineStoreUrl: `https://${shopDomain}/products/${(li.sku || "p").toLowerCase()}`, featuredImage: { url: `https://picsum.photos/seed/${li.sku}/600/600`, altText: li.title } } : null,
                  variant: li.variant ? { title: li.variantTitle, image: null } : null,
                })),
              },
            }
          : null,
      });
    }
    return reply({ order });
  }
  return reply({});
};

/* --- Etsy -------------------------------------------------------------- */

const etsy: Handler = async (req, url) => {
  if (url.hostname !== "api.etsy.com") return null;
  if (url.pathname.endsWith("/oauth/token")) {
    const text = await bodyText(req);
    if (!/refresh_token=mock_|code=mock_/.test(text)) return null;
    const n = Date.now().toString(36);
    return json({ access_token: `31415926.mock_at_${n}`, token_type: "Bearer", expires_in: 3600, refresh_token: `mock_rt_${n}` });
  }
  const key = headerOf(req, "x-api-key");
  if (!key.startsWith("mock_")) return null;
  const shopsMatch = url.pathname.match(/\/users\/([^/]+)\/shops$/);
  if (shopsMatch) return json({ shop_id: 31415926, shop_name: "PixArt Etsy", results: [{ shop_id: 31415926 }] });
  const receiptsMatch = url.pathname.match(/\/shops\/([^/]+)\/receipts$/);
  if (receiptsMatch) {
    const minCreated = Number(url.searchParams.get("min_created") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const all = etsyReceiptsSince(receiptsMatch[1], minCreated);
    return json({ count: all.length, results: all.slice(offset, offset + limit) });
  }
  const shopMatch = url.pathname.match(/\/shops\/([^/]+)$/);
  if (shopMatch) return json({ shop_id: Number(shopMatch[1]) || 31415926, shop_name: "PixArt Etsy" });
  return json({ count: 0, results: [] });
};

/* --- Gmail ------------------------------------------------------------- */

function mailToGmailMessage(m: MockMail) {
  const headers = [
    { name: "From", value: m.from },
    { name: "To", value: m.to },
    { name: "Subject", value: m.subject },
    { name: "Date", value: new Date(m.internalDate).toUTCString() },
    { name: "Message-ID", value: `<${m.id}@mock.alphaos>` },
    ...(m.inReplyTo ? [{ name: "In-Reply-To", value: m.inReplyTo }] : []),
  ];
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: ["INBOX", "UNREAD"],
    snippet: m.body.slice(0, 120),
    internalDate: String(m.internalDate),
    historyId: String(m.historyId),
    payload: { mimeType: "text/plain", headers, body: { data: Buffer.from(m.body).toString("base64url"), size: m.body.length } },
  };
}

const mailCache = new Map<string, MockMail>();
/** Messages this mailbox sent (id -> decoded RFC 822 headers), for the post-send header lookup. */
const sentCache = new Map<string, { threadId: string; headers: { name: string; value: string }[] }>();

function mailboxFor(address: string): { etsyShopName: string; etsyShopId: string } {
  const lower = address.toLowerCase();
  if (lower.includes("lumina")) return { etsyShopName: "Lumina Etsy", etsyShopId: "27182818" };
  return { etsyShopName: "PixArt Etsy", etsyShopId: "31415926" };
}

const google: Handler = async (req, url) => {
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    const text = await bodyText(req);
    if (!/refresh_token=mock_|code=mock_/.test(text)) return null;
    // The seeded refresh token carries the mailbox address (mock_rt_<b64url>),
    // and the access token carries it on, so every later call knows whose
    // mailbox it is without any shared state.
    const tag = text.match(/refresh_token=mock_rt_([A-Za-z0-9_-]+)/)?.[1] ?? "";
    return json({ access_token: `mock_gat_${tag}`, expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly", token_type: "Bearer" });
  }
  if (url.hostname !== "gmail.googleapis.com") return null;
  const auth = headerOf(req, "Authorization");
  if (!/^Bearer mock_/.test(auth)) return null;
  const tag = auth.match(/^Bearer mock_gat_([A-Za-z0-9_-]+)/)?.[1] ?? "";
  let address = "orders@pixartcreatives.com";
  try {
    const decoded = Buffer.from(tag, "base64url").toString("utf8");
    if (decoded.includes("@")) address = decoded;
  } catch {}
  const box = mailboxFor(address);
  if (url.pathname.endsWith("/users/me/profile")) {
    const all = mailboxSince({ address, afterHistoryId: 0, ...box });
    const last = all[all.length - 1];
    return json({ emailAddress: address, historyId: String(last ? last.historyId : 1000), messagesTotal: all.length, threadsTotal: all.length });
  }
  if (url.pathname.endsWith("/users/me/history")) {
    const start = Number(url.searchParams.get("startHistoryId") ?? 0);
    const mails = mailboxSince({ address, afterHistoryId: start, ...box });
    // A customer replying to the most recent proof email we "sent": lands as
    // a reply on that thread so the classifier path is exercised too.
    const pending = sentProofThreads.find((t) => !t.replied && Date.now() - t.sentAt > 1000);
    if (pending) {
      pending.replied = true;
      const k = 900000 + sentProofThreads.indexOf(pending);
      mails.push({
        id: `mock-reply-${k}`,
        threadId: pending.threadId,
        historyId: (mails[mails.length - 1]?.historyId ?? start) + 1,
        internalDate: Date.now(),
        from: pending.to,
        to: address,
        subject: `Re: ${pending.subject}`,
        body: "Looks great, approved! Please go ahead and print it.\n\nOn " + new Date(pending.sentAt).toUTCString() + " you wrote:\n> Your portrait proof is ready",
        inReplyTo: `<${pending.threadId}@mock.alphaos>`,
      });
    }
    for (const m of mails) mailCache.set(m.id, m);
    const latest = mails.length ? mails[mails.length - 1].historyId : start;
    return json({
      historyId: String(latest),
      history: mails.map((m) => ({ id: String(m.historyId), messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: ["INBOX", "UNREAD"] } }] })),
    });
  }
  const getMatch = url.pathname.match(/\/users\/me\/messages\/([^/]+)$/);
  if (getMatch && req.method === "GET") {
    const sent = sentCache.get(getMatch[1]);
    if (sent) {
      return json({ id: getMatch[1], threadId: sent.threadId, labelIds: ["SENT"], internalDate: String(Date.now()), payload: { mimeType: "text/plain", headers: sent.headers, body: { data: "", size: 0 } } });
    }
    let m = mailCache.get(getMatch[1]);
    if (!m) {
      const all = mailboxSince({ address, afterHistoryId: 0, ...box });
      m = all.find((x) => x.id === getMatch[1]);
    }
    if (!m) return json({ error: { code: 404, message: "Not Found" } }, 404);
    return json(mailToGmailMessage(m));
  }
  if (url.pathname.endsWith("/users/me/messages/send") || url.pathname.includes("/upload/gmail/v1/users/me/messages/send")) {
    const n = Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
    const id = `mock-sent-msg-${n}`;
    // Peek at the raw message: keep its headers for the post-send lookup,
    // stay on the thread it replies to, and note a proof email so a
    // customer reply can be simulated on that thread.
    const text = await bodyText(req);
    let threadId = `mock-sent-${n}`;
    try {
      const parsed = JSON.parse(text) as { raw?: string; threadId?: string };
      if (parsed.threadId) threadId = parsed.threadId;
      const decoded = Buffer.from(parsed.raw ?? "", "base64url").toString("utf8");
      const head = decoded.split(/\r?\n\r?\n/)[0] ?? "";
      const headers = head
        .split(/\r?\n(?!\s)/)
        .map((line) => line.match(/^([\w-]+):\s*([\s\S]*)$/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .map((m) => ({ name: m[1], value: m[2].replace(/\r?\n\s+/g, " ").trim() }));
      if (!headers.some((h) => h.name.toLowerCase() === "message-id")) headers.push({ name: "Message-ID", value: `<${id}@mock.alphaos>` });
      sentCache.set(id, { threadId, headers });
      const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
      const to = headers.find((h) => h.name.toLowerCase() === "to")?.value ?? "";
      if (/proof/i.test(subject) && to) sentProofThreads.push({ threadId, to, subject, sentAt: Date.now(), replied: false });
    } catch {}
    return json({ id, threadId, labelIds: ["SENT"] });
  }
  return json({});
};

/* --- Anthropic ---------------------------------------------------------- */

const anthropic: Handler = async (req, url) => {
  if (url.hostname !== "api.anthropic.com") return null;
  if (!headerOf(req, "x-api-key").startsWith("mock_")) return null;
  const body = JSON.parse((await bodyText(req)) || "{}") as { model?: string; messages?: { content?: string }[] };
  const prompt = String(body.messages?.[0]?.content ?? "");
  let text: string;
  if (/Classify this customer reply/i.test(prompt)) {
    const reply = prompt.split(/Reply:\s*/i)[1] ?? prompt;
    text = mockClassifierAnswer(reply);
  } else if (/daily operations health briefing/i.test(prompt)) {
    text = mockNarrative(prompt);
  } else {
    text = "Understood. Here is a short, plain-English draft you can send: thank you for the photos, the designer starts today and a proof follows within 48 hours.";
  }
  return json({
    id: "msg_mock_" + Date.now().toString(36),
    type: "message",
    role: "assistant",
    model: body.model ?? "claude-sonnet-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: Math.ceil(text.length / 4) },
  });
};

/* --- install ------------------------------------------------------------ */

const HANDLERS: Handler[] = [shopify, etsy, google, anthropic];

export function installMockTransport(): void {
  if (installed) return;
  installed = true;
  realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return realFetch(input as RequestInfo, init);
    }
    for (const h of HANDLERS) {
      const res = await h(req, url);
      if (res) return res;
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  console.log(JSON.stringify({ ts: new Date().toISOString(), integration: "mock", event: "transport_installed" }));
}
