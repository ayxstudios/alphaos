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
| Auth           | Auth.js / NextAuth v5 (Google OAuth + magic link)  |
| Object storage | Cloudflare R2                                       |
| Email          | Gmail / Google Workspace                            |
| AI             | Anthropic API                                       |
| Background jobs| Trigger.dev                                         |

## Layout

```
app/
  (auth)/           public login pages
  (app)/            authenticated app shell
  api/              route handlers (incl. Auth.js catch-all)
lib/
  db/               Drizzle schema + client
  auth/             Auth.js configuration
  integrations/     etsy/ and shopify/ clients (stubs)
components/ui/      shared UI components
docs/               this folder
```

## Getting started

1. Copy `.env.example` to `.env.local` and fill in the values.
2. `npm install`
3. `npm run dev`

## Notes

- The Auth.js **magic-link (Nodemailer) provider is configured but has no
  database adapter yet** — it will not complete sign-in until the Drizzle
  adapter is wired up in `lib/auth/index.ts`.
- Database commands: `npm run db:generate`, `db:migrate`, `db:push`, `db:studio`.
