# AlphaOS docs

Project documentation lives here.

## Overview

AlphaOS is an operations platform for multi-channel commerce (Etsy + Shopify),
built on Next.js 15 (App Router).

## Stack

| Concern        | Choice                                             |
| -------------- | -------------------------------------------------- |
| Framework      | Next.js 15 (App Router, TypeScript strict)         |
| Styling        | Tailwind CSS v4                                     |
| Database / ORM | Neon (serverless Postgres) + Drizzle ORM           |
| Auth           | Auth.js / NextAuth v5 (email/password credentials) |
| Object storage | Cloudflare R2                                       |
| Email          | Gmail / Google Workspace                            |
| AI             | Anthropic API                                       |
| Background jobs| Vercel Cron                                         |

## Layout

```
app/
  (auth)/           public login pages
  (app)/            authenticated app shell
  api/              route handlers (incl. Auth.js catch-all)
lib/
  db/               Drizzle schema + client
  auth/             Auth.js configuration
  integrations/     Etsy, Shopify, Gmail, and scheduler code
components/ui/      shared UI components
docs/               this folder
```

## Getting started

1. Copy `.env.example` to `.env.local` and fill in the values.
2. `npm install`
3. `npm run dev`

## Notes

- Auth is email/password only. There is no signup, Google login, or magic-link
  provider; users are created with `npm run create-user` or by the seed script.
- Customer email uses each business's own Gmail mailbox via the Gmail API.
  Gmail OAuth client IDs/secrets and refresh tokens are stored encrypted per
  business in the database, configured from Settings.
- Scheduled jobs are Vercel Cron routes in `vercel.json`.
- Database commands: `npm run db:generate`, `db:migrate`, `db:push`, `db:studio`.
