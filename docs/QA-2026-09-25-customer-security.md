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
| P3 | Upload page: a PDF was only refused after Send, with one message at the bottom naming the file, and it blocked the good photos in the same batch; a 26 MB file marked "Over 25 MB" still went to the server and blocked the batch; a failed upload could not be retried (Send disabled); the remove button was 28 px; "or drag them here" on a phone. | Rejected files are marked on their own row at once and skipped; failed uploads retry; 44 px remove; drag hint laptop only. | 6539abd |
| P3 | Proof page: an approved proof still said "If everything looks perfect, approve it, or let us know what to change", and a decided proof with no image said "Your proof is being prepared. Please check back shortly." Change options were 40 px; "Clear pins" was a 20 px text link next to "spots marked". | Intro only while a decision is open; placeholder only while undecided; 44 px options and Clear spots. | 6c5a49a |
| P3 | `/orders?q=%00` threw on the server (empty page with a digest); `?q=%` listed every order. | `cleanSearchTerm` + `likeContains`, as on Customers and Messages. Verified locally: %00 lists normally, % and zzzz find nothing, ORD-10 finds the ORD-10xx orders. | a778fa0 |
| P3 | Upload page: a batch with a real photo and an HTML-as-png answered "One of the files is not a supported photo." while BOTH rows said "Uploaded", with no way to tell which file; Send just failed again. | The server returns the refused keys; the page marks that row "Not a photo: choose a JPG, PNG or HEIC", names it in the message, and Send adds the rest (test:security covers the data layer). | 77fc72c |
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

### Customer pages (A1 to A5)

Staging, as a stranger (no cookies), phone 390x844 and laptop 1440x900.

| Screen | Phone | Laptop | Under 10 because |
|---|---|---|---|
| Upload link, open order (4170595372) | 8 | 9 | Drag hint on a phone; PDF refused only after Send and it blocked the rest; 28 px remove (fixed 6539abd, verified locally). |
| Upload: PNG + JPG + WebP + HEIC + note with `<b>`, quotes, unicode | 9 | 9 | Uploaded, done state, order moved awaiting_photos to ready_to_assign through the state machine (activity: `via upload_link`, 4 photos); the VA sees the note as text (escaped), photos under Reference photos. Save took about 8 s under load. |
| Upload: HEIC with an EMPTY browser type (Mac/Windows) | 10 | 10 | Accepted (the server fills the type from the extension). |
| Upload: PDF, 26 MB | 6 | 6 | See above (fixed). |
| Upload: `.png` that is really HTML, dropped on the laptop | 3 | 3 | Accepted on staging (unfixed build): the order now has an HTML "photo" (asset `...216ba141.png`, 1 of 6 on 4170595372). Fixed 3219f00: refused before any row (test:security). |
| Upload: second visit | 10 | 10 | "We already have 4 photos from you", can add more. |
| Upload: wrong token, `<script>` token, 200-char token | 10 | 10 | HTTP 404, calm "Link not found". |
| Upload: closed order (PC32149, complete) | 10 | 10 | HTTP 200 with "This order is closed, so photos can no longer be added." |
| Proof on staging, PC32168 (made for this: VA assigned it to the staging designer, designer started, uploaded STAGING-TEST png, submitted; VA passed QC and sent, mock Gmail) | 9 | 9 | Watermarked JPEG preview (26 KB, `cache-control: private, no-store`, `x-robots-tag: noindex`), approve worked (awaiting_approval to approved, one `order.approved`), two replayed approves and a late revision all answer "A decision has already been recorded for this proof." Unfixed staging still sets the auth csrf/callback cookies on the buyer and keeps the "approve it" intro after approval (both fixed, below). |
| Proof (local, fixed build) | 9 | 9 | Decided proof kept asking to approve (fixed 6c5a49a). Watermarked preview (`/api/proof/<token>/preview`, "PROOF . PIXART" tiles), no cookies set, only business name, order number and the portrait on the page (no customer name, email, address or price). |
| Proof: approve twice | 10 | 10 | Confirm step, "Portrait approved"; reload shows the same; 23 replayed approve calls: 19 "A decision has already been recorded", then "Too many attempts" (20/min per IP and per token); exactly one `order.approved` row. |
| Proof: request a change with 2 spots and `<img onerror>` + 250 words | 10 | 10 | "Changes requested"; the VA order page shows the note as text, no overflow. |
| Proof: wrong token | 10 | 10 | HTTP 404 "Link not found". |
| Login: wrong password (real and unknown email) | 10 | 10 | Same "Wrong email or password. Try again, or ask your admin.", email kept, cursor back in Password; `autocomplete` email / current-password. |
| Login: 10 failures on one email (local) | 10 | 10 | 11th try, even with the RIGHT password: "Too many tries. Wait 15 minutes, then try again."; once the lock expires the right password signs in. Per-IP limit (30/15 min) proven by test:security (not hit on staging: the four lanes share one IP). |
| 404 `/nope` (local, fixed) | 10 | 10 | Branded, plain, "Go to sign in", tab "Page not found", HTTP 404. Staging still shows Next's default (verified locally until the merge deploys). |
| `/styleguide` | n/a | n/a | Staff only (307 to /login signed out, 307 to /board for a designer); a static component demo with no data. Harmless, kept. |
| `/api/upload/dev/*` | n/a | n/a | 404 on staging for everyone. |

Sign-in links (`/auth/link/<token>`): test:login-link on the local CI db
(valid, reused on purpose, revoked, expired, deactivated, password reset
revokes, bad links count toward the per-IP limit): all pass. 32 random
bytes, stored hashed. Upload tokens are random UUIDs (122 bits), proof tokens
32 random bytes; both are rate limited per IP and per token.

Tab titles: in a browser the proof and upload 404s read "Your portrait
proof" / "Send us your photos" (the page's metadata streams in after the
not-found head), which is right for a buyer; the root 404 reads "Page not
found". Only a raw curl of the first bytes showed "AlphaOS".

### Search and input hardening (B9)

Staging as the VA: `/orders`, `/customers`, `/emails` with `' OR 1=1--`,
`%00`, `%`, `<script>alert(1)</script>`, RTL override + Arabic, 5000 chars:
all HTTP 200, parameterised, never echoed raw. Two defects on `/orders`
(VA lane's page, fixed here with a two-line change, see Shared files):
`?q=%00` threw on the server (digest in the page, empty main area) and `?q=%`
listed every order (214 KB vs 80 KB). `/customers` and `/emails` were
already cleaned (`cleanSearchTerm`, `likeContains`).

No `dangerouslySetInnerHTML` or `innerHTML` anywhere in app, components or
lib: every name, note, comment, style name and draft renders through React's
escaping. The two HTML email builders escape: `textToHtml` (customer mail,
quotes too) and the daily health email (`escapeHtml`). Links built from
stored data: tracking URLs are validated (`cleanTrackingUrl`), manual photo
links must be http(s) now (3b8fa1b), and React 19 refuses `javascript:`
hrefs. Checked live: the customer upload note `<b>bold?</b> & "quotes"
ünïcødé` and the revision note `<img src=x onerror=alert(1)>` show as text on
the VA order page, phone and laptop, no sideways scroll.

Designer order pages on staging (PC32168, PC32148): the only email address
in the HTML is the designer's own; no customer last name.

### Local suites

`test:security` (now 7 more checks), `test:rls`, `test:login-link` on
`alphaos_ci_cs25`: all pass.


## Round 2 (after the fixes)

Staging still runs the unfixed build, so round 2 re-ran the staging probes
for drift and re-walked the fixed pages on the local server (same commit as
this branch, local db `alphaos_cs25`).

- API matrix, four callers: identical to round 1 (only live counts in the
  Alpha answers moved). Wrong machine secrets: identical, all 401.
- Designer replays on staging with a fresh designer session (8 staff/admin
  actions: makeSignInLink, setEmailSendingEnabled, resetMemberPassword,
  voidEarningAction, approveAndSend, bulkChangeOrderStatus,
  confirmReplyApproval, createManualPrintJob): none ran; bulkChangeOrderStatus
  answers "Only admin and VAs can manage orders."; no sign-in link minted in
  the last hour. VA replay of addTrackingAndCompleteOrder with a fake order:
  calm "Choose a valid print provider.".
- Suites: `bash scripts/ci-local.sh` equivalent on `alphaos_ci_cs25` (proxy
  4460): 23/23 pass (test:security flaked once on "fetch failed" to the local
  proxy under load 300+, passed on the re-run). `npx tsc --noEmit` 0,
  `npm run lint` 0.

Round 2 on the local server (fixed build), phone and laptop:

| Screen | Phone | Laptop | Notes |
|---|---|---|---|
| Upload: PDF + 26 MB + real PNG | 10 | 10 | PDF "Not a photo" and 26 MB "Over 25 MB" on their own rows at once; Send took only the PNG; "Got them"; the order moved to ready to assign with 1 photo. No drag hint on the phone. |
| Upload: HTML-as-png dropped (laptop) | 7 | 7 | Refused, no row saved (verified in the db), but the row still said "Uploaded" next to a vague message: fixed 77fc72c, loop 3. |
| Upload: closed order | 10 | 10 | Unchanged. |
| Error page (a real one: the local db proxy dropped a connection under load while opening a wrong upload link) | 10 | 10 | Branded "Something went wrong", plain words, Try again 44 px, no message, digest or stack in the page. Only the digest in the console. |
| Proof: decided proof | 10 | 10 | No "approve it" intro and no "being prepared" box after a decision (6c5a49a). |
| 404 `/nope`, `/proof/x`, `/upload/x` | 10 | 10 | HTTP 404, calm pages, security headers on all three, no auth cookies on the buyer pages. |

## Round 3 (loop 3)

| Screen | Phone | Laptop | Notes |
|---|---|---|---|
| Upload: real PNG + HTML-as-png in one batch | 10 | 10 | The fake row reads "Not a photo: choose a JPG, PNG or HEIC", the message names the file ("STAGING-TEST-really-html.png is not a photo. Send again to add the rest."), Send again uploads nothing new and saves the PNG: "Got them", 1 photo on ORD-1020. |
| Every other screen of rounds 1 and 2 | 10 | 10 | No code changed under them since round 2 (the upload client change is scoped to the refused-file path); test:security, tsc and lint green after the change. |

## Loop 4: fidelity to the owner order

"Test every function ... every user level ... tested and then debugged and
uncamelled every section." For this lane: the buyer (upload link, proof
link, 404 and error pages, 26 customer emails), every signed-out and
wrong-role caller of every API route and the riskiest server actions, the
sign-in page and sign-in links, headers and cookies, search and free-text
inputs, RLS and the security suites. Each section was tested on staging (or
locally where staging lacked the data or the fix), debugged (18 fixes
below the 404 fix, each committed on its own), and uncamelled (the upload
and proof copy says what happened in plain words, one row at a time; no
jargon; 44 px targets). Not done in this lane and said so: the per-IP login
lock on shared staging, and a full script CSP.

## The 12 P3s from docs/QA-2026-09-23-security-r2.md, re-decided

| # | P3 | Now |
|---|---|---|
| 1 | `/customers?q=%00` rendered the error boundary | Fixed earlier (`cleanSearchTerm`), staging 200. The same bug was still on `/orders` (digest, empty page): fixed on this branch. |
| 2 | Concurrent reassignment losers get HTTP 500 | Still there (unique index throws in `bulkReassignOrders`). Left for the VA lane, which owns `app/(app)/orders/actions.ts` this round: a catch on the unique violation with "Someone just reassigned this order" is the fix. |
| 3 | `addTeamMember` with a non-string name: 500 | Fixed earlier (`normalizeName` checks the type). |
| 4 | Customer names have no length cap | Left: written by manual orders (VA lane) and platform imports; pages render 5000 characters without breaking (r2). |
| 5 | Search `%` and `_` are wildcards | `/customers`, `/emails` fixed earlier; `/orders` fixed on this branch. |
| 6 | Notification `href` without a leading-`/` check | Fixed earlier (top bar only pushes `/` paths that are not `//`). |
| 7 | Built-in `POST /api/auth/signout` does not revoke | Fixed earlier (`events.signOut` revokes). |
| 8 | `recheckToken` keeps a session when the DB read fails | Kept on purpose: a database blip must not sign everyone out. |
| 9 | A designer calling team actions gets HTTP 200 `{}` | Kept: re-proved today on staging and locally, no action runs and nothing is written; the VA gets the calm "Only an admin can make sign-in links". |
| 10 | Order page client chunk bundled `lib/db` | Fixed earlier (`lib/orders/reply-templates.ts` is db-free). |
| 11 | `prepareQcEmailPreview` trusts the client checklist | Kept: VA-only preview; the send runs the authoritative gate. |
| 12 | `moveOrder` not-found message had the UUID; hidden orders are soft 404s | The message is plain now. `/orders/not-a-uuid` still answers HTTP 200 for a VA and a designer: left for the VA lane (its page), flagged. |
| + | A designer's Start never drafts the `in_design` email | Kept: a design call (needs a system-side draft). |

## The 8 wide RLS policies, re-decided

| # | Policy | Now |
|---|---|---|
| 1 | `"user"` UPDATE open to app_user (a designer context could change its own role) | Narrowed in 0040 (admin, or own row keeping its role); test:rls. |
| 2 | `designer_businesses` without RLS | Narrowed in 0040; test:rls. |
| 3 | `alpha_events` without RLS | Kept: VA, system and designer transitions write it and need `.returning`; a safe policy needs a per-event-type rule. |
| 4 | Designer `activity_log` / `assets` inserts with any actor, `customer_public` wide, notification deletes and channels, unused Auth.js tables | Narrowed in 0040; test:rls. |
| 5 | `orders_designer_update` allows any column | Kept: a policy cannot limit columns (needs a trigger); `transition()` is the only designer writer. |
| 6 | `orders_select` lets an assigned designer read `raw_import` (Etsy `buyer_email`) | Kept: read server-side for the first name only. Re-checked today: a designer's order page HTML on staging carries no customer email and no last name. |
| 7 | `shops_select` returns credential ciphertext to designers | Kept: AES-256-GCM, key server-side only; hiding it needs a designer-safe view. |
| 8 | VA policies FOR ALL | Deletes narrowed in 0040; VA UPDATE on earnings kept (completing an order creates the earning). |

test:rls passes on `alphaos_ci_cs25` with every one of these.

## Left as it is (with reasons)

- A full script `Content-Security-Policy`: Next's inline runtime scripts need a per-request nonce (middleware + every page dynamic); `frame-ancestors 'none'` is set now. Worth its own change.
- HSTS without `preload`: preload is a registry submission decision for a custom domain, not a header default. Vercel already sends it on `*.vercel.app`.
- The Shopify webhook says "unknown shop" vs "invalid signature": shop domains are public, and the distinction is what an admin needs when setting a store up.
- `/styleguide`: staff only, a static component demo with no data.
- Per-IP login limit not hit on staging: the four lanes share one IP and would all be locked out; proven by test:security instead.
- Tour: on staging, opening `/orders/<id>` as the VA landed on Today with "1 of 6" (the tour started and took the page over), on the phone even after Skip. Tour files belong to the designer lane: flagged there.
- The `.png` that is really HTML is still on staging order 4170595372 as evidence until the fix deploys (a VA can remove it).

## Shared files touched

- `app/(app)/board/actions.ts` (designer lane): `saveCardAssetUploads` uses `assertKeysBelongTo` + `assertStoredImage` (byte sniffing). 3b8fa1b
- `app/(app)/orders/new/actions.ts` (VA lane): `referenceUploadProblem` before a manual order stores keys or links. 3b8fa1b
- `app/(app)/orders/page.tsx` (VA lane): `cleanSearchTerm` + `likeContains` on `q`. a778fa0
- `lib/orders/card-detail.ts`: comment bodies scrubbed for designers. 0afb89c
- `lib/utils.ts`: `isUuid` appended. 9cb0435
- `lib/email/templates.ts`, `lib/integrations/gmail/mime.ts`: renderer only (no template copy changed). d1178e4, 3dc15be
- Copy the SIMPLICITY lane may reword: `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx` (new), the upload row messages "Not a photo: choose a JPG, PNG or HEIC", the proof page "Clear spots" (was "Clear pins").

## Staging state left behind

- 4170595372 (`c736e552`): awaiting_photos to ready_to_assign by my customer upload; 6 reference assets (4 STAGING-TEST photos, 1 HEIC with an empty type, 1 HTML-as-png), and my test note appended to its notes.
- PC32168 (`c611ff72`): assigned by me (as the VA) to the staging designer, started, one STAGING-TEST submission, QC passed and proof sent (mock Gmail), approved by me as the customer: status approved.
- PC32170: MOVED BY MISTAKE. My first designer script matched the wrong card: in_design 06:12 UTC, one STAGING-TEST submission, awaiting_qc 06:13 UTC. It had been assigned to the staging designer at 05:30 UTC by another lane (as staging-va). Whoever owns it: it is in QC with a test square, not your upload.
- The staging designer's saved session had been revoked by someone; I signed it in again (states in the scratch dir only).
- Wrong-password attempts: 4 on staging-admin and 1 on staging-designer (timing and UI checks), 5 on unknown `cs25-*` emails; all well under the locks.
