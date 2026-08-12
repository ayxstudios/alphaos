# AlphaOS — progress

_Last updated: 2026-08-12. Update this whenever a major piece lands._

Factual snapshot of what exists. See CLAUDE.md for conventions/constraints.

## Built and working (verified by tests or live round-trip)

- **Data + RLS.** Drizzle/Neon, migrations 0000–0021. Postgres row-level security
  on `business_id`; app connects as non-owner `app_user`. Request paths use
  `withUserContext`, background jobs `withSystemContext`.
- **Order state machine** (`lib/orders/transitions.ts`). All legal transitions +
  role gates in one graph; QC gate enforced in the transition, not just the UI.
  States include `triage` and `fulfillment_only` (non-portrait). Adversarial test
  (`test:transitions`, `test:nonportrait`) proves designers can't skip QC and
  `fulfillment_only` can't reach design/proof/earnings.
- **Boards + VA queue.** Designer board; VA queue tabs (triage, needs-photos,
  shopify-missing-photos, unassigned, awaiting-qc, revisions, awaiting-customer,
  fulfilment, ready-to-print, overdue). Auto-assignment algorithm.
- **QC screen.** Synced compare viewer, checklist gate, keyboard shortcuts.
- **Customer proof portal.** Token-scoped, watermarked preview, approve / request-
  revision with annotations; read-only after a decision.
- **Shopify integration.** Client-credentials grant (2026 Dev Dashboard) + legacy
  token fallback; token refresh; sync (60-day first window, incremental cursor);
  orders/create webhook; GraphQL re-fetch so figure count resolves the same on
  webhook + sync (`test:shopify-figures`). Webhook registration is automatic on
  connect and can be re-run from Settings. Shop sync health is visible on
  Settings + Dashboard. Verified against the live PixArt store.
- **Figure + style resolver.** Per-shop rules; case-insensitive, punctuation-
  tolerant; never guesses. Re-resolve action heals already-imported orders.
- **Orders list + detail.** VA operations table with saved views, date sorting,
  pagination, customizable columns, sticky left actions menu, bulk reassign/status
  actions, operational status labels, Shopify thumbnails/product links, tracking
  card, and Shopify fulfillment writeback for physical-order completion.
- **Manual order entry.** Fast keyboard-first form; drag-drop R2 upload + URL
  paste; auto-assign on ready-to-assign; never emails.
- **R2 storage.** Private bucket, presigned PUT (direct from browser) + presigned
  GET; keys `{businessId}/{orderId}/{assetType}/{uuid}.{ext}`; 180-day retention
  soft-delete. Verified end-to-end against the live bucket.
- **Reconciliation.** Manual orders promote in place when the platform later
  imports the same number (see decisions).
- **Scheduled jobs.** Vercel Cron routes exist for all-shop order sync, Gmail
  inbound polling + queued-email flushing, and R2 retention. Shop sync, Gmail
  poll health, queued email, and unmatched reply health are surfaced on the
  dashboard.
- **Daily health dashboard.** Dashboard computes fresh per-scope metrics on
  load: shop sync staleness, queued/failed email, stale unmatched replies,
  blocked earnings, stale intake, proof no-response, order throughput, delivery
  timeliness, QC/revision rates, capacity, and unassigned work. The narrative is
  generated once daily from aggregate-only metrics and cached in
  `daily_health_reports`; if Anthropic is unavailable, the numbers still render
  with a cached/plain fallback.
- **Morning health briefing delivery.** Vercel Cron calls
  `/api/cron/daily-health` at both UTC hours that can be 7am in Melbourne; the
  route checks `Australia/Melbourne` local time so daylight saving does not shift
  delivery (`test:daily-health`). Per-business delivery defaults off and is
  configured in Settings → Notifications with explicit active-admin recipients.
  The email sends via that business's Gmail integration, records sent/failure
  state on `daily_health_reports`, and creates in-app notifications linking to
  the dashboard. If Anthropic is unavailable, the numbers still send without an
  AI narrative; if Gmail is missing or needs reauth, admins get a visible failure
  notification.
- **Notification SLA sweep (in-app).** A 15-minute cron route detects due-soon,
  overdue, overdue escalations, stale intake, proof no-response, stale shop sync,
  and stale unmatched replies. `notification_fires` is the durable idempotency
  ledger; ordinary alerts fire once, admin escalations re-fire by window
  (`test:notifications`). The sweep is guarded by `NOTIFICATIONS_ENABLED` and
  defaults to dry-run/log-only; admins can run the same dry-run report from
  Settings → Notifications. In-app notifications now show recent unread alerts
  in the shell dropdown. Telegram/web-push/email delivery are not built yet.
- **Designer earnings + payouts.** Portrait styles carry per-figure rates.
  Completion writes one immutable earning per order with item-level JSON
  breakdown; revision round-trips do not duplicate pay; reassignment pays the
  active assignee; `fulfillment_only` never pays. Missing style/rate creates a
  blocked earning instead of blocking customer workflow. Admin Payouts page shows
  period totals, blocked rows, drilldown, paid marking, voided rows, and CSV
  export (`test:earnings`).
- **Manual print fulfilment.** Approved physical orders appear in
  `/queue/print`, oldest first, with the platform order number, shop, customer,
  latest/final portrait link, provider choice, and tracking controls. The VA
  triggers printing in Gelato/Luma Prints from the provider's own dashboard, then
  records "Sent to print" in AlphaOS; that creates a manual `print_jobs` row and
  moves the order to `printing` (`test:reply-print`). Product mapping/API
  submission UI is hidden because the connected sales platforms already carry the
  product/address into the providers. Tracking now moves AlphaOS orders only to
  `shipped`; `complete` remains a separate transition. Shopify/Etsy tracking
  writeback is attempted and any platform failure is recorded on the print job
  instead of silently stalling.
- **Designer submission upload.** Designers upload finished portraits from their
  own `in_design` board cards via direct-to-R2 drag/drop or file picker. Each
  upload creates a new `assets.type = 'submission'` row; uploads are versioned,
  never overwritten, and the state machine blocks `awaiting_qc` until at least
  one submission exists (`test:transitions`). Designers can add replacement
  versions while the card is in design, but uploads lock after QC.

## Built but NOT tested against a live API

- **Etsy integration** (OAuth PKCE, rate-limited client, receipts sync,
  classification). No live Etsy account has been connected — logic is unexercised
  against the real API. **This is the big untested surface.**
- **Gmail email layer** (per-business OAuth, DB templates, VA outbox approval
  gate, visible system-queued email backlog, scheduled queued flush + inbound
  reply poller, unmatched-replies tray with age/24h flags, dashboard health
  counts). QC pass now opens a customer email preview, shows the exact portrait
  attachment and completed checklist, sends through Gmail, and only then moves
  the order to awaiting approval; failures stay visible in Outbox and do not
  advance the order. Inbound replies attached to orders in `awaiting_approval`
  are quote-stripped and, when Anthropic is configured, classified as approval /
  revision / question / unclear; approval/revision are VA-confirmed suggestions,
  never automatic transitions, and VA decisions are logged for accuracy review
  (`test:reply-print`). If Anthropic is unavailable, inbound still arrives and
  notifies staff with no suggestion. No business has connected Gmail yet, so
  send + inbound have not run live. Photo requests are off by default regardless.

## Key decisions and why

- **Two DB connections.** A table owner bypasses non-forced RLS, so the app
  connects as a non-owner (`app_user`) to make RLS actually apply; migrations run
  on the owner connection (`DIRECT_URL`). Without this, policies are defined but
  unenforced.
- **Figure resolver never guesses.** `figure_count` drives designer payout, so a
  wrong number is worse than "unknown". Unresolved counts land in the review
  queue for a human rather than a silent default.
- **Photo requests off by default.** Shopify collects photos at checkout; the
  Etsy customer-email workflow isn't ready to change. Enabled per shop only when
  an admin opts in; a VA can still send one manually.
- **`fulfillment_only` is a state, not a flag.** The transition graph is the
  enforcement point — with no edges to `in_design`/`awaiting_approval`, a
  non-portrait order structurally cannot reach a designer, proof, or earnings. A
  flag would scatter that gating across many call sites and drift.
- **Reconciliation matches on `platform_order_name`.** Shopify's import key is the
  internal `legacyResourceId`, which a VA never has; the VA types the human number
  (`PC31972`). So a manual order stores that number + a `manual:` sentinel id, and
  the later import matches on the number and promotes the row in place — never a
  duplicate, never overwriting the VA's data.

## What's next (in order)

1. **Connect + live-test Etsy** for one shop (the largest untested surface).
2. **Connect Gmail** for one business; verify send, scheduled inbound polling,
   queued flush, unmatched reply linking, daily health email delivery, and
   dashboard health end-to-end.
3. **Add notification channels + routing settings**: Telegram, web push, digest
   email, per-type routing, batching delivery queue, and required-channel guards.
4. **Live-test designer payout flow** after configuring real style rates for
   PixArt/Lumina.
5. **Evaluate print API later only if needed.** Current direction is manual
   provider-dashboard triggering; Gelato/Luma Prints API submission/webhooks are
   intentionally not wired.

## Half-finished / stubs

- **48-hour photo reminder** (the second auto-send exception) is not built.
- **Notification external channels** (Telegram, web push, digest email) are not
  built yet; stages 1-3 are in-app only.
