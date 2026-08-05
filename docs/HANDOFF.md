# Handoff — Etsy simplification

_2026-08-05. See CLAUDE.md (conventions) and docs/PROGRESS.md (overall state)._

## Status: DONE and pushed — not partial

All work below is committed and pushed as **`efcdff2`** ("Simplify Etsy to
header-only import + VA completes details"). Working tree is clean, `npm run build`
passes, and all four test suites are green (`test:reconcile`, `test:nonportrait`,
`test:shopify-figures`, `test:transitions`). There is **no broken or uncommitted
state**. (The requested "WIP … partial" commit was not made because it would
misrepresent finished, green work.)

## The 4 tasks — all complete

1. **Schema — done.** `awaiting_details` order state + `orders.raw_import` (jsonb).
2. **Etsy import simplified — done.** Header-only; no items/resolution/email.
3. **Complete-details + duplicate lookup — done.** Case 1 form + Case 3 lookup.
4. **Needs-Details queue tab + reconcile test — done.**

## Code state, file by file (all committed)

- `lib/db/schema.ts` — `order_status` += `awaiting_details`; `orders.raw_import`.
- `lib/integrations/etsy/receipts.ts` — `importReceipt` now creates the order
  HEADER only (receipt_id, buyer name, email if present, date, `raw_import` =
  full receipt), status `awaiting_details`, no `order_items`, no figure/style
  resolution, no `needs_review`, no email. Resolver imports removed here but
  `etsy/figures.ts` is kept (unused). `syncShopReceipts` lost its
  `suppressCustomerEmail` opt (Etsy sends no email).
- `lib/orders/reconcile.ts` — added optional `rawImport` arg; fills it (and
  customer/photos) only when the manual row left them blank.
- `lib/orders/transitions.ts` — edges `awaiting_details -> ready_to_assign |
  awaiting_photos`, plus hold/resume/cancel. `OVERDUE_STATES` includes it.
- `app/(app)/orders/new/actions.ts` — added `completeOrderDetails` (fills an
  awaiting_details order → pipeline via `runTransition`, auto-assigns) and
  `lookupOrderByNumber` (Case 3).
- `components/orders/new-order-form.tsx` — dual mode: create (with debounced dup
  lookup) and complete (prefilled, read-only number/shop, raw-payload viewer).
- `app/(app)/orders/[id]/complete/page.tsx` — new; loads an awaiting_details
  order and renders the form in complete mode.
- `lib/orders/board-data.ts` — VA tab `needs_details` (status awaiting_details).
- `components/board/queue-card.tsx` + `app/(app)/queue/page.tsx` — "Complete
  details →" action for those cards.
- `components/ui/status-chip.tsx` — `awaiting_details` = "Needs details".
- `app/(app)/settings/actions.ts` — `backfillEtsyShop` no longer passes the
  suppress flag.
- `scripts/test-reconcile.ts` (+ `test:reconcile`) — proves Case 2.

## Migrations

- **0011** (`awaiting_details` enum + `orders.raw_import`) is generated **and
  applied** to the DB. Nothing is generated-but-unapplied.

## Design decisions made, now written

- **State choice:** new `awaiting_details`, NOT `triage` — triage is one-click
  classification; this is data entry, so its own state + its own queue tab + a
  "Complete details" action opening the manual form on the existing order.
- **Etsy = never-miss-an-order only.** No auto figure/style; a VA reads the
  personalization (shown from `raw_import`) and enters everything.
- **`raw_import` stores the whole runtime receipt** (TS types don't strip fields
  at runtime), so the VA sees note-to-seller/personalization even though our
  `EtsyReceipt` type is a subset.

## What the next agent should do FIRST

Etsy has still **never made a live call**. Before trusting it:

1. Connect PixArt's Etsy shop, then run a **read-only introspection** of 2–3 real
   receipts (mirror `scripts/_diag-pixart-*.ts` pattern; delete after) and verify
   the four open risks from the review:
   - Is `transactions` embedded, or does `getShopReceipts` need
     `includes=Transactions`?
   - Is the field `created_timestamp` (drives the cursor) or `create_timestamp`?
     A wrong name → `NaN` date + broken cursor.
   - Does `buyer_email` actually come back? (Likely restricted. If null: no
     customer/name; order still imports fine into awaiting_details.)
   - First-sync/backfill timeout at 75%-of-volume (offset pagination + 5/sec +
     one txn/receipt) — may need batch-and-resume for the Etsy backfill.
2. Fix only what the live payload proves is wrong. Header-only import already
   shrinks the blast radius (no variation/personalization parsing dependency);
   `created_timestamp` and `buyer_email` are the two that still matter.

## Other outstanding (from PROGRESS.md, unchanged)

- Retention sweep + all-shop sync are wired to Vercel Cron but need `CRON_SECRET`
  set in Vercel; schedules in `vercel.json`.
- Gmail not connected for any business; orders list/detail are stubs; no SLA
  background sweep (overdue is read-time).
