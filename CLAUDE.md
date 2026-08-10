# AlphaOS

> This file applies to any AI coding assistant working in this repository (Claude
> Code, Codex, or otherwise), not just Claude Code. It is the source of truth for
> project context, conventions, and constraints.

Order management for a multi-shop portrait business. Replaces Trello. Single
source of truth for every order from intake to delivery.

Scale: 14 shops (9 Etsy accounts, 5 Shopify stores), ~2000 orders/month,
50 designers, 6 VAs, 1 admin.

## Stack

- Next.js 15 (App Router), React 19, TypeScript
- Drizzle ORM on Neon serverless Postgres (`lib/db`)
- NextAuth v5 (`lib/auth`)
- Tailwind CSS v4
- nodemailer / Gmail API for customer email

Scripts: `db:generate`, `db:migrate`, `db:push`, `db:studio` (drizzle-kit).

## Layout

- `app/(app)` — authenticated app; `app/(auth)` — login
- `app/api` — auth + health routes
- `components/ui` — shared UI primitives
- `lib/db` — schema and client; `lib/auth` — session
- `lib/integrations/{etsy,shopify}` — shop connectors

## Order states

`awaiting_photos`, `ready_to_assign`, `in_design`, `awaiting_qc`,
`awaiting_approval`, `approved`, `printing`, `shipped`, `delivered`,
`complete`, `on_hold`, `cancelled`.

Every state transition writes an immutable `activity_log` row:
actor, action, from_state, to_state, timestamp.

## Roles

- **admin** — everything, all businesses
- **va** — all orders and all designer boards; QC, approves outbound email,
  reassigns
- **designer** — own assigned orders only; sees customer first name, never
  their email

## Design tokens

Direction: **"Ledger"** — a calm, cobalt-and-paper operations palette
(redesigned 2026-08-10, see `redesign/from-scratch-ui-2026-08-10`), chosen via
the `ui-ux-pro-max` skill for a dense, all-day operational dashboard. Warm
paper canvas, deep cobalt-navy primary (replaces the earlier violet
"pigment"), forest/ochre/berry status colours. No component may introduce a
colour outside these (defined in `app/globals.css` `@theme`):

```
--canvas #F7F5EF   --surface #FFFFFF   --ink #121B26   --slate #55697C
--line #E4E0D4     --pigment #2C4A85   --pigment-soft #E8EEF8
--sage #1C7A52     --amber #966405     --rose #B23A56
```

(Token names are unchanged from v1 to avoid a mechanical rename across the
codebase — `--pigment` is the brand/primary accent slot regardless of hue.)

- Fonts: display `Calistoga` (slab-serif, page titles/section identity only,
  used sparingly) + body/UI `Inter` + tabular data `JetBrains Mono` (order
  codes, timestamps, counts) — wired via `next/font` in `app/layout.tsx`.
- Type scale: 12/14/16/20/28/40/48px
- Radius: 10 inputs / 8 chips / 16 cards / 20 modals
- Three shadow levels only, ink-tinted
- Motion: 120ms hover, 220ms layout, 400ms page; `prefers-reduced-motion`
  respected globally
- Light theme only — hard requirement, no dark mode
- Status chips (`StatusChip`) are pill-shaped (workflow state); metadata
  badges (`Badge`) are rectangular chips — different silhouettes so state
  vs. tag never rely on colour alone to be told apart.

## Conventions

- Server components by default; server actions preferred over API routes
- All queries through Drizzle; no raw SQL outside migrations
- Multi-tenancy enforced by Postgres row-level security on `business_id`,
  not only by UI filtering
- Credentials encrypted at rest, scoped per shop, never committed

## Data access (RLS)

- **Never use the raw `db` export in a request path** (server action, route
  handler, server component). It bypasses tenant scoping. Request-path queries
  MUST go through `withUserContext(user, tx => …)` (`lib/db/index.ts`), which
  opens a transaction and sets the `app.user_id` / `app.role` GUCs the RLS
  policies read. Raw `db` is only for migrations and seeds. Treat this as a
  lint-level rule.
- `withSystemContext(tx => …)` runs as an admin-scoped RLS context for
  **background jobs only** — the Etsy sync, cron tasks, and route handlers that
  act on behalf of no signed-in user. It grants full cross-tenant access, so
  system-initiated writes set `actor_id = null`. **Never call it from a request
  path serving a logged-in user** — that silently escalates that request to
  full access. Those paths use `withUserContext` with the real session user.
- `shops` has RLS, so `getShopCredentials` / `setShopCredentials` take a `tx`
  and must run inside `withUserContext` (admin) or `withSystemContext`.
- RLS is enforced by the app connecting as the non-owner role `app_user`;
  migrations run on the owner connection. See the header of
  `lib/db/migrations/0001_rls_policies.sql` for the required role/DATABASE_URL
  ops steps — until DATABASE_URL points at `app_user`, policies are defined but
  not enforced.
- Designers never read the `customers` table; they read the `customer_public`
  view (id, business_id, first_name only). Admin/VA read `customers`.
- Shop credentials: read only via `getShopCredentials(shopId)`
  (`lib/db/credentials.ts`, AES-256-GCM, `ENCRYPTION_KEY`). Never log or return
  the decrypted value.

## Deadlines

- `orders.due_at` — customer-facing SLA deadline. Set at import; does NOT move
  on reassignment.
- `assignments.due_at` — the assigned designer's deadline for their attempt.
  Reassignment inserts a new assignment row with a fresh `due_at` while
  `orders.due_at` stays put.

## Integration rules

- Each of the 9 Etsy accounts has its OWN Seller App: a separate keystring
  and shared secret per business. There is no single shared Etsy app.
- Etsy: cap our own requests at 5/sec (their limit is 10), exponential
  backoff on 429, log every call.
- Never scrape or automate the Etsy web dashboard — it violates their ToS.
- Etsy has no messaging API and never will. Customer photos arrive through
  our own upload link, emailed to the buyer on order import.
- Customer-facing email sends via Gmail API from each business's own
  Google Workspace tenant, not a transactional provider.
