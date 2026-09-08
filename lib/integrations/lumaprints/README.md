# Luma Prints integration

Client for the [Luma Prints API](https://api-docs.lumaprints.com/) (`lib/integrations/lumaprints/client.ts`).
Researched 2026-09-08 via the public docs at api-docs.lumaprints.com; no API key
was available to test against a live account, so treat the request/response
shapes below as "documented", not "verified live" - `PRINT_PROVIDER_MOCK=1`
fixtures (`fixtures.ts`) stand in until a key is entered in Settings.

Verdict: **the real API is usable for reconciliation, not thin.** It covers
everything reconcile.ts needs to read (order status, shipments/tracking). The
one real gap is the missing/known-limitation section below, which reconcile.ts
and the client work around rather than falling back to email parsing.

## Base URLs

- Sandbox: `https://us.api-sandbox.lumaprints.com`
- Production: `https://us.api.lumaprints.com`

## Auth

HTTP Basic Authentication: `Authorization: Basic base64(username:password)`.
Credentials ("an API key, provided after registration") are issued per Luma
Prints account after signup; stored as `{ username, password, storeId,
sandbox? }` in `businesses.print_credentials.lumaprints` (`lib/db/credentials.ts`,
`getBusinessPrintCredentials`).

## Endpoints used

| Purpose | Method | Path | Docs |
|---|---|---|---|
| Get one order | GET | `/api/v1/orders/{orderNumber}` | [Get an order](https://api-docs.lumaprints.com/api-5384558) |
| List orders | GET | `/api/v1/orders?storeId=&page=&orderDateStart=&orderDateEnd=` | [Get multiple orders](https://api-docs.lumaprints.com/api-5384559) |
| Shipments/tracking | GET | `/api/v1/shipments/{orderNumber}` | [Get shipments of an order](https://api-docs.lumaprints.com/api-5384566) |
| Submit an order | POST | `/api/v1/orders` | [Submit a new order](https://api-docs.lumaprints.com/api-5384560) - not used; the VA submits through Luma's own dashboard |
| Store list | GET | `/api/v1/stores` | [Get all stores](https://api-docs.lumaprints.com/api-5384565) - not used yet, would let Settings validate `storeId` |
| Webhook subscription | dashboard only | dashboard.lumaprints.com/developer/webhook | [Webhook](https://api-docs.lumaprints.com/doc-513534) |

Getting started overview: [api-docs.lumaprints.com/doc-420499](https://api-docs.lumaprints.com/doc-420499).

## Known limitation: no filter by our own reference

`GET /api/v1/orders` filters only by `storeId` and an order-date range, and
pages results (`page`, `totalPages`). **There is no `externalId` / order-number
query parameter.** Since the VA never tells us Luma's own `orderNumber`, the
only way to find "the order for our platform order X" is to page through the
store's orders in a date window and match `externalId` (Luma's name for the
reference we'd have passed in) client-side.

`LumaPrintsClient.findByReference()` implements exactly that scan, capped at
`MAX_SCAN_PAGES` (10) pages per call so a wide reconcile window can't turn into
an unbounded loop; an order older than what those pages cover reads as "not
found" (reconcile.ts then treats it the same as "never sent"). If this becomes
a real problem at volume, `GET /api/v1/stores` + narrowing the date window per
run, or asking Luma support for a reference filter, are the next steps -
tracked as a TODO, not solved here.

## Webhooks

Luma has exactly one event type, `shipping` (fires once a shipment exists for
an order), configured through their dashboard rather than an API call - you
paste your endpoint URL in and optionally set Basic Auth credentials for it to
send. **There is no documented signature/HMAC scheme.** Because subscribing
happens on Luma's side (nothing to build against our own DB per business
without asking every business owner to click through Luma's dashboard), this
build does not add an `app/api/webhooks/lumaprints` route - reconciliation for
Luma Prints runs entirely off the polling cron
(`app/api/cron/print-reconcile`, `lib/print/reconcile.ts`), same cost as
Gelato's poll fallback for any business that hasn't got the Gelato webhook
wired up either. Revisit if per-business webhook self-service is ever worth
building.

## Fields worth knowing

- `orderStatus` is a free-text status string; the only value shown in the docs
  is `"Awaiting Fulfillment"`. `client.ts` `statusToNormalized()` matches on
  substrings (`shipped`, `cancel`, `hold`/`fail`/`reject`, `production`/
  `printed`) rather than an exact enum, since the full status vocabulary isn't
  published - re-check against live orders once a key exists.
- The shipments response gives `trackingNumber` and `carrier` but **no tracking
  URL and no explicit "shipped" status field**; reconcile.ts treats "a shipment
  exists" as the shipped signal (a filled `shipments[]` array), independent of
  whatever `orderStatus` says.

## TODO

- [ ] Verify all shapes above against a live account once API credentials exist.
- [ ] `GET /api/v1/stores` to validate `storeId` from the Settings UI instead of
      trusting whatever the admin types in.
- [ ] Decide whether per-business Luma webhook self-service is worth the UX cost
      given subscription is dashboard-only.
