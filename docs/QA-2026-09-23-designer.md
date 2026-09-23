# QA 2026-09-23: designer journey (staging, phone first)

Walked on https://alphaos-staging.vercel.app as staging-designer (VA used only
to assign and QC). Headless Chromium, phone 390x844 first, laptop 1280x800.
Screenshots: `var/e2e-shots/designer/` (gitignored).

## Walked

1. Sign-in, welcome card, 5-step tour with Try it (phone), "?" > Show me around
   (phone + laptop: focus trapped, Esc skips), Quick guide /help. No sideways
   scroll anywhere.
2. Home /dashboard: own orders only, no customer email in the DOM.
3. My Board: VA assigned PC32169 (brief + 4 photos) and PC32165. Designer:
   Start, open card, brief + photos, upload by file picker AND drag-drop
   (STAGING-TEST png), two versions listed, never overwritten, Submit for QC,
   upload locked after QC.
4. VA failed QC with feedback; designer saw it, uploaded v3, resubmitted. VA
   pass blocked on staging (see Environment).
7. Denied pages: /orders, /orders/new, /orders/[id]/complete, /settings,
   /customers(/id), /qc(/id), /today, /emails, /designers(/id), /styles,
   /queue/print redirect to /board; /health, /payouts to /dashboard;
   /payouts/export 403; another designer's /orders/[id] 404. No stack traces.

## Not walked yet

- Step 4 end: designer sees the pass (QC pass needs a send; email is off on staging).
- Step 5: earnings per completed order and blocked earning on a missing rate.
- Step 6: nudge / reassign as seen by the designer.
- API routes for orders as a designer (/api/alpha/chat role snapshot).
- Laptop walk of the board (drag between columns).

## Defects

### P1 (fixed)

- Customer email leaked to the designer: `loadCard` returned activity
  metadata as is, and `email.send_failed` / `email.sent` rows carry
  `to: <customer email>`. Seen in the POST /board response for PC32169.
  Fix 7369347 (lib/orders/card-detail.ts scrubs address keys and addresses
  for designers).
- Reference photos could not be opened full size on the card; the hero was
  cropped (object-cover) and thumbnails were 64px with no link. Fix 1471124.

### P2 (open)

- Designer sees the customer SLA (`orders.due_at`) on board, card, Home and
  My Week, while their own deadline (`assignments.due_at`, 24h) drives the
  WhatsApp nudges and the order page countdown. A freshly assigned late order
  shows "overdue 9d" on day one. The board also sorts by one date and shows the
  other ("Soonest deadline first" lists PC32169 +1d before PC32165 -1d).
  lib/orders/board-data.ts, lib/home/designer.ts, lib/designers/my-week.ts.
- Search for a designer goes to /orders and silently lands on /board (top bar
  search field on laptop, search icon on phone). components/shell/top-bar.tsx.
- Card in My Queue (not started) says "Uploads are locked after the card
  leaves design" and "Uploads locked after QC". It should say press Start first.
- Upload button reads "Replace" once a version exists, but nothing is
  replaced; each upload adds a version.

### P3 (log)

- Tap targets under 44px on phone: top bar hamburger 20x40, search 36x36,
  Alpha AI 40x36, bell 36x36, account 63x36; card modal Close 32x32, Upload
  95x32, Send 58x32.
- Card modal on phone puts status/meta above the upload panel; the designer
  scrolls past it to upload. Drop zone says "click" on a phone.
- A 0-byte upload is rejected as "over 25 MB" (board/actions.ts head check
  shares one message).
- Tour step 3 "Upload your portrait" spotlights the page header when no card
  is in design; step 1 spotlight edge sits 6px off screen on the bottom tab.
- First assignment shows as "reassigned" in the card activity.
- Designer on /orders/[id] sees "Unknown customer" (not the first name) and a
  "Review QC" next step they cannot open.
- /me shows due times in Asia/Jakarta while the designer timezone is "Not set".

### Out of lane (for the VA/admin testers)

- /orders/[id]/complete ("Edit") opens EMPTY for an imported Shopify order
  (no name, email, style, photos) and would save it to awaiting-photos.
- /qc/[id] throws React hydration error #418.
- QC fail dialog pre-selects every unticked checklist item.

## Environment

- The R2 bucket CORS allows alphaos-kappa and localhost but not
  alphaos-staging, so every browser upload fails on staging (preflight 403).
  Uploads above were verified with a test-side CORS shim; the bucket rule is
  production infra and was not changed.
- Email sending is off on staging, so QC Pass ("Send email & pass QC") always
  fails and the order stays in Awaiting QC.
