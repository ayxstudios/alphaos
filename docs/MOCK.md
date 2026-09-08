# Mock integrations (2026-09-09)

AlphaOS runs its whole pipeline against fake shops, mailboxes, print
providers and an AI model, with credentials that look real but never leave
the process. This is how the demo deployment behaves "as if it had the API
keys", and how the pipeline is tested end to end with no vendor account.

## How it works

- `lib/mock/transport.ts` patches `fetch` once per process. Each request is
  answered from `lib/mock/data.ts` when the CREDENTIAL it presents carries the
  mock marker, otherwise it goes to the real API untouched:

  | System    | Mock marker                                   |
  |-----------|-----------------------------------------------|
  | Shopify   | access token starts with `shpat_mock`         |
  | Etsy      | keystring starts with `mock_`                 |
  | Gmail     | refresh token `mock_rt_<base64url address>`   |
  | Anthropic | `ANTHROPIC_API_KEY` starts with `mock_`       |
  | Gelato    | API key starts with `mock_`                   |
  | Luma      | basic-auth username starts with `mock_`       |

  So a real shop added next to the mock ones keeps working normally.
- `instrumentation.ts` installs the transport on every server start when
  `MOCK_INTEGRATIONS=1`. Scripts call `installMockTransport()` themselves.
- `lib/mock/data.ts` is deterministic and time driven: a Shopify shop places
  an order every 25 min, an Etsy shop a receipt every 40 min, the shop mailbox
  gets an Etsy sale or buyer message every 30 min, all from a fixed anchor,
  so every cron tick finds a little new work and the same order always looks
  the same. Buyers are generated, emails are `@example.com`, photos are
  picsum placeholders.
- A proof email the app "sends" is remembered; the next mailbox poll returns
  the customer's reply on that thread ("Looks great, approved!"), which the
  mock model classifies as an approval.
- Gelato and Luma resolve ANY mock order number: the last digit decides the
  stage (0-6 shipped with tracking, 7-8 printed, 9 created), on top of the
  static fixtures the print tests use.

## Switches

`.env.local` and the Vercel project (production + preview):

```
MOCK_INTEGRATIONS=1
PRINT_PROVIDER_MOCK=1
ANTHROPIC_API_KEY=mock_sk-ant-api03-demo
```

To go live with a real vendor: paste the real key into Settings (or the
env) and that system stops being mocked on its own. Remove
`MOCK_INTEGRATIONS` when the last mock shop is gone.

## Seed and walk

```
npm run db:seed          # 2 businesses, 4 onboarded mock shops, mailboxes, print creds, 20 orders
npm run mock:pipeline    # the end-to-end walk, 19 asserted steps, one table at the end
```

The walk runs the same code the cron routes and the UI run: shop sync,
mailbox poll, email flush, assign -> submit -> QC pass, proof email out,
customer reply in and classified, approval, send to print, reconcile pulls
tracking and fulfils on Shopify, SLA / reminder / designer sweeps queue
Alpha events, daily health narrative. From the iMac a full run takes several
minutes because every query crosses to the database in Virginia; on Vercel
(iad1) the same steps run in seconds.

Demo logins (password `alphaos123`): admin@aystudios.io, va1, va2, d1, d2,
d3 at aystudios.io.
