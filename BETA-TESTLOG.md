# AlphaOS Beta Tester Log

Branch: `beta-debugger/polish-2026-08-10`. Workflow B (test + fix in one pass).
Started 2026-08-10 (AEST). Never pushed/merged to main.

## Phase 0/1 — Setup (done)

- Cloned `ayxstudios/alphaos` (main @ a4aaf8a) into
  `~/Documents/projects/alphaos`, branch created.
- Read: `CLAUDE.md`, `AGENTS.md`, `docs/README.md`, `docs/HANDOFF.md`,
  `docs/PROGRESS.md`, `docs/GMAIL_SETUP.md`, `.env.example`, the MVP brief
  (Google Drive). Full route map built from `app/` tree (below).
- **Test environment: an isolated Neon Postgres DB was provisioned
  specifically for this beta test** (via `vercel integration add neon`
  under this agent's own Vercel team, project `almacorp/alphaos`), NOT the
  real production database. Migrations + RLS (`app_user` role) applied.
  Reason: CRUD/auth/QC/proof-portal testing needs to freely create, edit,
  and delete orders — doing that against the real 2,000-orders/month
  production DB would risk visible corruption of live business data. This
  keeps the hard "real data stays read-only" rule intact while still
  allowing a genuine, full-depth functional test.
- Seeded via the project's own `npm run db:seed`: 2 businesses (PixArt,
  Lumina), 6 users (1 admin, 2 VA, 3 designer), 4 shops, 11 customers, 20
  orders across all statuses (some overdue, some due soon), 14 active
  assignments. Login: `admin@aystudios.io` / `alphaos123` (matches the
  real prod credentials given by the user, by the seed script's own
  design — safe here since this is the isolated test DB only).
- `npm install`, dev server boots clean (`npm run dev`, ready in 2.5s,
  `/api/health` returns `{"status":"ok"}`).

### Known gaps going in (from docs/PROGRESS.md, confirmed by reading code)

- Etsy integration: never made a live call against a real Etsy account.
- Gmail email layer: no business has connected Gmail live.
- Print provider (Lumaprints/Gelato) API: not wired, manual tracking-entry
  path only.
- Earnings/payout reporting UI: `earnings` are written on completion, no
  report screen yet.
- 48h photo reminder + background SLA/overdue sweep: not built (overdue is
  read-time only).

### Credentials/access this agent does NOT have (flagged, not fabricated)

- No Cloudflare R2 credentials → cannot test the real file-upload path
  end-to-end (manual order entry drag-drop, designer submission upload).
  Will test the UI/validation around it and note this gap explicitly in
  the report rather than claim it works.
- No `ANTHROPIC_API_KEY` → Auto-QC button cannot be live-tested.
- No real Etsy/Shopify/Gmail OAuth credentials → those connect flows can
  be UI-tested (does the form appear, validate, etc.) but not completed
  end-to-end. Matches the known-untested surface above.
- Asked the user (2026-08-10) whether to provide any of these; proceeding
  with everything else in the meantime rather than blocking.

## Route map (from `app/` tree) — testing checklist

- [ ] `(auth)/login` — login, wrong password, session persistence
- [ ] `(app)/dashboard`
- [ ] `(app)/board`
- [ ] `(app)/queue`
- [ ] `(app)/orders` (list)
- [ ] `(app)/orders/new`
- [ ] `(app)/orders/[id]` (detail)
- [ ] `(app)/orders/[id]/complete`
- [ ] `(app)/customers`, `(app)/customers/[id]`
- [ ] `(app)/designers`
- [ ] `(app)/qc`, `(app)/qc/[orderId]`
- [ ] `(app)/settings`
- [ ] `(app)/styles`
- [ ] `/proof/[token]` (public customer proof portal)
- [ ] `/styleguide`
- [ ] Role coverage: repeat key flows as VA and as Designer, not just Admin

## Findings

(populated as testing proceeds)

## Findings — running log

### F1. Login (auth flows) — PASS
- Wrong password: correct generic "Invalid email or password." error, no
  user-enumeration leak. Password field clears on failure (form resets
  fully, including email — worth a UX look, see below).
- Correct login: works, redirects through `/` -> `/dashboard`.
- **Minor UX nit:** on a failed login, BOTH email and password fields
  clear, not just password. Forces retyping the email too. Small but
  annoying for a tool used many times a day by 56 people.

### F2. Dashboard (admin) — mostly PASS, one real gap
- Renders real, well-structured operational data: active/overdue/VA
  actions/QC waiting counts, "Needs attention" overdue list, pipeline
  health (mailbox poll, sync status), orders workload. Matches the
  brief's intent well.
- **Gap vs brief (Core Feature #1, Multi-Business Command Bar):** the
  brief requires "All Businesses / [specific business]" with admin
  defaulting to All. The actual switcher (`components/shell/top-bar.tsx`
  + `lib/shell/context.ts`) only lets you pick ONE business at a time —
  there is no "All" option. This is confirmed as a **deliberate MVP
  scope cut**, not an accidental bug: `lib/shell/context.ts` has the
  comment "Staff work in one business at a time." The database layer
  already supports cross-business admin/VA access (RLS `app_is_staff()`
  grants it) — this is purely a missing UI capability. Given the brief
  calls this out as Core Feature #1 and the user asked to "complete the
  project," this is a real candidate for a Phase 5 fix, scoped as: add
  an "All Businesses" option to the switcher + aggregate dashboard
  summary cards + a business badge column on the orders list when
  active. NOT attempting full cross-business board merge in one pass —
  that's a bigger lift; will scope precisely before touching code.

### F3. Orders list (admin) — PASS, solid
- Rich saved-view tabs (Active/Overdue/Needs Details/etc. with live counts),
  filters (status/source/shop/designer/due), sortable columns, bulk
  reassign/status actions, status tooltips ("What 'Shipped' means"),
  per-row stage countdown. Matches brief well.
- Noted: a row can show order-level "Overdue" (orders.due_at passed) while
  its stage clock shows time still remaining (assignment.due_at, reset on
  reassignment) — this is the CLAUDE.md-documented dual-deadline model
  working as designed, not a bug, but could read as contradictory to a
  VA without context. Low-priority clarity item (a tooltip would help).

### F4. Order detail (admin) — PASS, solid
- Full detail: purchased items, notes/activity, quick actions (reassign,
  revision request — both correctly disabled until eligible, with a plain-
  English reason shown), reference photos, production/tracking, messages.
  Buttons gate correctly against the state machine (matches CLAUDE.md).

### F5. Board — PASS. Initial root-cause guess corrected after reading the code.
- Designer list + per-designer board render correctly (columns: My Queue,
  In Design, Failed QC, Awaiting QC, Revisions, Complete). Capacity badges
  (e.g. "Dana Designer 6/5") correctly show over-capacity designers per
  the seed fixture.
- **Correction:** first guessed this was the same workspace-scoping gap as
  F2 (board only showing 3 of Dana's 6 assigned orders because it's
  Lumina-only). Verified against the actual code and DB instead of
  assuming: `getDesignerBoard` (`lib/orders/board-data.ts`) has **no
  business filter at all** — a designer's board already spans every
  business they're attached to. Queried Dana's real assignments directly:
  6 active, split across PixArt and Lumina, but only 4 statuses
  (`ready_to_assign`, `in_design`, `awaiting_qc`, `complete`) are rendered
  on this kanban by design — her `printing`/`delivered` assignments
  correctly don't appear here, that's a fulfilment-stage order and this
  board is scoped to active design/QC work. So the 3-vs-6 mismatch is
  intentional status filtering, not a business-scoping bug. Board needs
  no change for the "All Businesses" fix (F2) — it was never business-
  scoped to begin with.

### F6. Portrait Styles page — FALSE POSITIVE, retracted
- Initial observation: adding "Classic" appeared to succeed server-side
  (DB row created correctly) but the page kept showing "No styles yet"
  right after the click, until a hard reload. Logged as a suspected
  missing-revalidation bug.
- **Retracted after code read + retest.** `createStyle` in
  `app/(app)/styles/actions.ts` does call `revalidatePath("/styles")`,
  the page has `export const dynamic = "force-dynamic"`, and
  `styles-manager.tsx` calls `router.refresh()` on success — the
  revalidation wiring is actually correct. Retested by adding a second
  style ("Modern") and explicitly waiting ~10s before checking (this dev
  server's round-trip is slow — Neon-over-websocket in dev mode, plus my
  own scratch diagnostic scripts written into `scripts/` mid-test
  triggering extra Next.js Fast Refresh rebuilds): "Modern" appeared
  correctly, no reload needed. The first observation was my own snapshot
  firing before that slow async refresh had finished, not an app defect.
  No code change needed here.

### Known test-data gaps (not app bugs, noted for the report)
- Lumina workspace had 0 portrait styles configured before this session —
  `orders.style` and `designer_profiles.styles[]` use freeform strings
  seeded directly, but the `styles` catalog table (used by Settings →
  Portrait Styles and the New Order form) was never seeded. Added one
  ("Classic") manually to unblock testing the New Order flow.
- Order items on several seeded orders show "Untitled item"/"No item
  details" — consistent with the Etsy header-only import design
  (HANDOFF.md: Etsy imports intentionally capture minimal item data until
  a VA completes details), so likely correct behaviour for those specific
  seeded rows, not a bug.

### F7. Role-based access — PASS, verified server-side (important, worth highlighting in report)
- Logged in as a designer (`d1@aystudios.io`): sidebar collapses to "My
  Board" only (no Orders/Designers/Portrait Styles/Customers/Settings).
  Customer names show first-name-only ("Chloe" not "Chloe Diaz") — matches
  the brief's and CLAUDE.md's privacy rule exactly.
- Confirmed this is **enforced server-side, not just hidden nav**:
  navigating a designer directly to `/settings` redirects back to
  `/board` rather than rendering the page. Real defense in depth.

### F8. Board — minor real bug: dnd-kit hydration mismatch (low severity)
- Visiting `/board` throws a React hydration-mismatch console error:
  `aria-describedby="DndDescribedBy-0"` (server) vs `"...-1"` (client).
  Root cause: `@dnd-kit/core`'s `DndContext` auto-generates this id from
  an internal incrementing counter that persists across client-side
  navigations within one browser session but always restarts at 0 on a
  fresh server render — a well-known dnd-kit SSR quirk, not a logic bug
  in this codebase. No visible or functional impact observed (drag/drop
  itself works); it is a real console error though, and would fail a
  strict "no console errors" bar. Low-severity, candidate for a Phase 5
  fix if a low-risk one exists (dnd-kit supports passing an explicit
  stable `id` to `DndContext` to make this deterministic).

## Phase 5 — Fixes implemented

### Fix 1: login form loses the typed email on a failed attempt (F1)
- `app/(auth)/login/actions.ts`: `LoginState` now carries back the
  submitted `email` on every failure path.
- `app/(auth)/login/page.tsx`: email input takes `defaultValue={state.email}`.
  Password is deliberately never echoed back.
- Verified: wrong password -> email field still shows what was typed,
  password field empty, ready to just retype the password.

### Fix 2: dnd-kit hydration mismatch on /board (F8)
- `components/board/designer-board.tsx`: `DndContext` now takes a stable
  `id="designer-board"` instead of letting dnd-kit auto-generate one from
  a module-level counter that drifts between server and client renders.
- Verified: clean reload of `/board?designer=...` shows zero console
  errors (previously showed the aria-describedby hydration-mismatch error
  on every load after the first in a session).

### Fix 3: "All Businesses" workspace option (F2)
Scoped deliberately, not a full rewrite:
- `lib/shell/constants.ts` / `lib/shell/context.ts`: added an `"all"`
  sentinel business id. Reused the exact literal `"all"` that
  `lib/qc/data.ts` (`getQcQueueIds`) and `lib/email/outbox.ts` already
  checked for and silently no-op'd on — a previous dev/agent had already
  built partial backend support for this that the switcher never
  activated. Admin/VA ("staff") now get "All Businesses" as the first
  switcher option; designers are unaffected (they never had a switcher).
- **Dashboard fully aggregates** across every business the user can see
  when "All" is selected: stat cards, the "Needs attention" list (each
  row now tagged with its business name), and shop sync health all query
  without a business filter. Per-business-only widgets (Gmail mailbox
  poll health) show an honest "pick one workspace" note instead of
  faking a value, since a mailbox is inherently per-business.
- **QC** (`/qc/[orderId]`) already works correctly with "All" with zero
  changes needed — `getQcQueueIds` was the dormant backend support
  mentioned above.
- **Orders, Customers, Designers, Settings, Portrait Styles, New order**
  — deliberately NOT rewritten to aggregate in this pass. These are
  larger, already-solid, working pages (Orders alone is 860+ lines with
  saved views/bulk actions/filters); rewriting their queries under time
  pressure carried more regression risk than value for this round. They
  now show a clean, on-brand "Pick a business first" prompt
  (`components/shell/pick-business-prompt.tsx`, reusing the existing
  `EmptyState` pattern) when "All" is selected, instead of either
  crashing or silently mis-filtering. This is an honest, bounded v1 —
  noted as a clear next slice in the report, not hidden.
- **Real bug found and fixed while wiring this up:** the dashboard's
  "Needs attention" list used `key={`${order.id}-${order.title ?? "item"}`}`
  — safe only when an order's items don't share a null/matching title.
  Verified via direct DB query: order ORD-1004 (PixArt, only reachable
  once "All Businesses" existed) has two `order_items` rows, both with
  `title: null`, producing an identical React key for both and a real
  "two children with the same key" console error. This was a
  **pre-existing latent bug**, not introduced by this fix — my change
  just made the first business-spanning order that happened to hit it
  reachable. Fixed by keying on `${order.id}-${index}` instead.
- Verified via `npx tsc --noEmit` (clean), `npm run build` (clean
  production build, all 19 routes compile) and the project's own test
  suites (`test:db`, `test:rls`, `test:transitions`, `test:nonportrait`,
  `test:reconcile`, `test:shopify-figures`, `test:etsy-review` — all
  pass, no regressions).

## Phase 6 — Regression retest (caught a real bug before it shipped)

- Retested every fix live in the browser, not just via `tsc`/`build`
  (which both passed cleanly but did NOT catch the next bug — Drizzle's
  types don't check that a `where()` condition's columns belong to the
  query's own `.from()` table).
- **Real bug caught: switching from "All Businesses" back to a specific
  business (e.g. Lumina) crashed the dashboard** with a Postgres error:
  `column "orders.business_id" does not exist` in the shop-health query.
  Root cause: my own Fix 3 edit reused the `businessFilter` variable
  (built as `eq(orders.businessId, ...)`, for the orders-table queries)
  inside the `shops`-table query, which needed `eq(shops.businessId,
  ...)` instead — a different table, different column. Fixed immediately
  by giving the shops query its own correctly-scoped condition. Re-
  verified via browser: switching every direction (All -> Lumina, All ->
  PixArt, Lumina -> All) now works cleanly, dashboard numbers match the
  pre-fix baseline exactly when a single business is selected (8 active /
  3 overdue for Lumina, matching the very first Phase 2 pass).
- Lesson for the record: a clean `tsc --noEmit` and `next build` are
  necessary but not sufficient — this exact class of bug (cross-table
  column reference, valid SQL string, wrong table) only surfaces at
  query-execution time. Live-browser retest after every fix remains
  non-negotiable, matching the skill's own "test, fix, then test again"
  rule.
- All five guarded pages (Orders, Customers, Designers, Settings,
  Portrait Styles, New order) re-checked with "All Businesses" active:
  each renders the clean "Pick a business first" prompt, zero console
  errors. Board re-checked with "All Businesses" active: renders fine
  (never business-scoped, per F5's correction).
