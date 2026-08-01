# AlphaOS

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

No component may introduce a colour outside these:

```
--canvas #FBFAF8   --surface #FFFFFF   --ink #16222E   --slate #5C6B7A
--line #E6E2DC     --pigment #5B4BC4   --pigment-soft #EFEDFB
--sage #14705A     --amber #8F5B08     --rose #C6335B
```

- Type scale: 12/14/16/20/28/40px
- Radius: 8 inputs / 12 cards / 16 modals
- Three shadow levels only
- Motion: 120ms hover, 220ms layout, 400ms page; `prefers-reduced-motion`
  respected globally
- Light theme only for v1

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
