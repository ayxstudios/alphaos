# QA 2026-09-25: customer + security lane

Owner order: "test every function of alphaOs. go in like every user level and
test everything. do not stop until you have tested and then debugged and
uncamelled every section and that you are 1000% happy with it and that this
work is the best work youve ever created."

This lane plays the buyer who never logs in (upload link, proof link, 404s,
customer email) and every trust boundary (API routes, server actions, RLS,
headers, tokens, rate limits). Laptop 1440x900 and phone 390x844 for every
page. Staging only (https://alphaos-staging.vercel.app, mocks armed), plus a
LOCAL database `alphaos_cs25` (dev server :3474, proxy :5500) and a local CI
database `alphaos_ci_cs25` (proxy :4460) for the suites. Production was not
touched. No secret, password or token appears in this file.

Branch `lane/2026-09-25-customer-security`, worktree
`~/Documents/projects/alphaos-wt-customer-security`, based on
`task/alpha-program` 9e7ec97 (what staging runs). Staging runs the UNFIXED
build: every fix below is "verified locally" until the merge is deployed.

Machine note: the iMac ran at a load average of 380 to 620 during this run
(four lanes), so every step ran one dev server and one browser at a time.

## Fixes (commit per concern)

| P | What the user or attacker saw | Fix | Commit |
|---|---|---|---|
| P2 | A .png (or any photo type) that was really an HTML page or a PDF was accepted by the upload link, the board and manual orders: only the browser's Content-Type was checked. | Bytes are sniffed before any asset row (lib/uploads/sniff.ts, verify.ts). | 3219f00, 3b8fa1b |
| P2 | Manual order: `r2Keys` from the browser were stored with no check, so a VA call could attach any stored file (another order's, another business's) to a new order; photo links took any scheme. | Keys must match `<business>/<order>/reference/<uuid>.<ext>`, stored bytes checked, links must be http(s). | 3b8fa1b |
| P2 | Default proof emails (every proof template in code, used by a new business or after Reset) linked `/proof/<token>.` with the sentence's full stop inside the href: the customer's click answered "Link not found". Staging and production templates are stored edits that put the link on its own line, so live mail was not hit. | Trailing punctuation stays outside the link; long links wrap. | 3dc15be |
| P2 | Sign-in timing told which emails have accounts: a wrong password took 1.80 s on a real email and 1.40 s on an unknown one (staging, 4 tries each, bcrypt skipped). | A dummy bcrypt compare on every no-account path. | ab761a4 |
| P3 | No security headers: pages could be framed (the proof page's Approve button behind a token), no nosniff, full-URL referrers (the token is the credential), `X-Powered-By: Next.js`. | CSP frame-ancestors none, X-Frame-Options, nosniff, strict-origin-when-cross-origin, Permissions-Policy, HSTS, no powered-by. A full script CSP needs per-request nonces (left, below). | cdfacbe |
| P3 | `/nope` answered Next's default "404: This page could not be found"; a thrown page error showed Next's default text; proof and upload 404 tabs read "AlphaOS". | Branded app 404, error and global-error pages; 404 tabs read "Page not found" / "Link not found". | f35190e |
| P3 | A business named "The Custom Portrait Shop" got "Your The Custom Portrait Shop portrait" in 13 subjects and bodies. | The renderer drops the name's own "The" after your/the (stored templates too). | d1178e4 |
| P3 | Admin `POST /api/etsy/sync`, `POST /api/shopify/sync`, `GET /api/etsy/connect` with a bad shop id: HTTP 500 with an empty body. | 404 JSON / back to Settings. | 9cb0435 |
| P3 | Proof and upload pages ran the staff auth middleware: one extra round trip to the function region per buyer page load, and the buyer's browser got `authjs.csrf-token` and `callback-url` cookies. | Matcher skips `/proof/` and `/upload/`. | 0c1849c |
| P3 | A designer's card feed showed an email address a VA typed into a comment (metadata was scrubbed, comment bodies were not). | Same scrub on comment bodies for designers. | 0afb89c |
| P3 | `/api/upload/dev/*` (unauthenticated PUT to the function disk) relied on R2 env being present to refuse. | Refuses on every Vercel deployment as well. | 63dc8d5 |

## Round 1

### API matrix on staging (B7)

Every `app/api` route, as nobody, designer, VA and admin (curl, saved
cookies). Staging runs the unfixed build.

| Route | none | designer | VA | admin |
|---|---|---|---|---|
| GET /api/health | 200 `{"status":"ok"}` (15 bytes, nothing else) | same | same | same |
| GET /api/cron/{sync,gmail-poll,notifications,print-reconcile,reminders,retention,daily-health} | 401 | 401 | 401 | 401 |
| GET, POST /api/alpha/events; GET /api/alpha/rundown; GET /api/alpha/order/:id | 401 | 401 | 401 | 401 |
| POST /api/alpha/chat | 401 | 200, own queue only | 200 | 200 |
| POST /api/assets/sweep | 403 | 403 | 403 | 200 |
| POST /api/etsy/sync, /api/shopify/sync (`shopId: "x"`) | 403 | 403 | 403 | **500 empty** (fixed 9cb0435: 404) |
| GET /api/etsy/connect?shopId=x | 307 /login | 307 /login | 307 /login | **500** (fixed: 307 Settings) |
| GET /api/etsy/callback, /api/gmail/callback (bad state) | 307 /login | 307 /login | 307 /login | 307 Settings?error=...state |
| POST /api/gmail/poll | 403 | 403 | 403 | 200 |
| GET /api/gmail/connect?businessId=x | 307 /login | 307 /login | 307 /login | 307 Settings?error=no_gmail_client |
| POST /api/shopify/webhook (no domain) | 400 | 400 | 400 | 400 |
| POST /api/webhooks/gelato (no business / unknown) | 400 / 401 | same | same | same |
| PUT /api/upload/dev/a/b.png | 404 | 404 | 404 | 404 |
| GET /api/proof/nope/preview (and HEAD) | 404 | 404 | 404 | 404 |
| GET /api/auth/session | `null` | own user | own user | own user |

Wrong machine secrets (all 401, never data, never 500): cron wrong/empty
bearer and secret-in-query; Alpha wrong `x-alpha-secret` and wrong bearer
(GET and POST); Shopify unknown domain ("unknown shop"), known domain with a
bad or missing HMAC ("invalid signature"); Gelato wrong query secret, wrong
signature header, bad JSON, not-a-uuid business. `OPTIONS /` 204, `TRACE`
405.

### Server actions (B8)

Read every exported action in the 19 action files (93 exports). Every staff
action checks the role first (`requireStaff` / `requireVa` / `requireAdmin` /
`sessionActor` + `isAdmin` in lib/team) and then runs inside
`withUserContext`, so tenant and ownership come from RLS. Designer-reachable
actions: `moveOrder` (transition rules per role), `loadCard`, `postComment`
(RLS, calm "Order not found"), `presignCardAssetUploads` /
`saveCardAssetUploads` (submission only, in_design only, key prefix; bytes
now checked), `askAlphaAboutOrder` (RLS-scoped order), `recordTourEvent`,
`markAllNotificationsRead` (own rows), `setBusiness` (forged id falls back),
`signOutAction`. Public: proof `trackView` / `approveAction` /
`revisionAction` and upload `presignAction` / `saveAction` (IP + token rate
limits, token-scoped system context).

Replayed on staging with the designer cookie and a Next-Action id taken from
the admin bundle: `bulkChangeOrderStatus` answers "Only admin and VAs can
manage orders." and writes nothing. `makeSignInLink`, `setEmailSendingEnabled`,
`resetMemberPassword`, `approveAndSend`, `voidEarningAction` answer `{}` with
no action run for a designer (the VA cookie on the same path runs
`makeSignInLink` and gets "Only an admin can make sign-in links"), so the
designer never reaches them. Local replay below proves the in-code guards.

Raw `db` in request paths: `lib/auth/login.ts`, `login-link.ts`,
`session-check.ts`, `lib/proofs/rate-limit.ts` only, all before a session
exists, on tables with no tenant data (documented in each file).
`withSystemContext` in `app/`: the Alpha routes (secret-gated), the Shopify
and Gelato webhooks (HMAC/secret, no user). In `lib/`: background jobs, the
public proof and upload data (token-scoped), and `sendMessage` /
`transitionAsSystem`, whose request-path callers (approveAndSend,
sendComposedEmail, confirmQcPassAndSend) first read the row under
`withUserContext`. No request path serving a signed-in user escalates.

### Headers and cookies (B9)

Staging (unfixed): only Vercel's HSTS; `x-powered-by: Next.js`; no
frame-ancestors, nosniff or referrer policy (fixed cdfacbe, verified
locally). Session cookie `__Secure-authjs.session-token`: HttpOnly, Secure,
SameSite=Lax, 30 days. `__Host-authjs.csrf-token`: HttpOnly, Secure. Business
cookie: HttpOnly, SameSite=Lax, Secure in production. Buyer pages were handed
the csrf and callback-url cookies (fixed 0c1849c).

### Customer emails (A6)

`scripts/email-preview.ts`: 13 templates x 2 businesses (PixArt, and "The
Custom Portrait Shop" to test a name starting with The), first name
`<b>Ann & "Bo"</b>`. Opened each at 390 and 700 px in Chromium: no `{{vars}}`
left, every link absolute https, the name escaped in HTML (shown as text),
plain-text part present (multipart/alternative), From is the business name,
never a person. Found: the full stop inside the proof link (P2 above), long
links pushing the phone view sideways, and "Your The ..." (both fixed).
Subjects carry the raw first name as header text (RFC 2047 encoded when
non-ASCII), which is correct for a plain-text header.

### Local suites

`test:security` (now 7 more checks), `test:rls`, `test:login-link` on
`alphaos_ci_cs25`: all pass.

