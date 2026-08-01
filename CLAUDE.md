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
