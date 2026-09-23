# Staging

A copy of production for end-to-end testing. Made 2026-09-23.

- URL: https://alphaos-staging.vercel.app (a Vercel PREVIEW of the
  `alphaos` project, aliased; production stays alphaos-kappa.vercel.app)
- Database: Neon project `shiny-pine-75328217`, resource
  `alphaos-staging-2026-09-23` in the alphaos Vercel team's Neon
  installation (Free plan, region iad1, same as production)
- Logins: `staging-admin@alphaos.test`, `staging-va@alphaos.test`,
  `staging-designer@alphaos.test`. Passwords and the staging database URLs
  live ONLY in `~/Documents/ai-employee-agent/.local/alphaos-staging.env`
  (mode 600). Never paste them into chat, docs or code.

## Why a copied project and not a Neon branch

Production's database (Neon project `raspy-surf-15386736`) sits in a
Vercel-managed Neon organization. Our `NEON_API_KEY` belongs to another Neon
organization and gets `project not found`, and a key for the Vercel-managed
org can only be minted in the Neon console through Vercel SSO (a browser
login to the Vercel account). So staging is a separate free Neon database
filled by a logical copy:

1. `scripts/staging/clone-prod.ts` READS production over the owner
   connection, WIPES the staging database, applies the same drizzle
   migrations, checks every column matches production, copies all 35 tables
   in foreign-key order and verifies row counts per table.
2. `scripts/staging/prepare.ts` gives `app_user` a login (so the app runs
   under RLS), creates the three test users, attaches the designer to PixArt
   with two `ready_to_assign` orders assigned, disarms (below) and prints a
   verification row.

The resource is connected to the `alphaos` project for the PREVIEW
environment only, with the prefix `STAGING_` (`STAGING_DATABASE_URL`, ...),
so it never replaces a production variable.

## Roles

`DATABASE_URL` = `app_user` (no BYPASSRLS, RLS enforced), `DIRECT_URL` =
`neondb_owner` (migrations, scripts). Note: production's own
`DATABASE_URL` currently connects as `neondb_owner`, which has BYPASSRLS,
so RLS is defined but not enforced in production. Staging enforces it.

## What is disarmed

In the staging database: every business has `email_sending_enabled`,
`stage_email_auto_send` and `daily_health_email_enabled` false,
`gmail_credentials` and `print_credentials` null; both shops have
`credentials = {}` (no Etsy or Shopify API call can authenticate).
On the deployment: `ALPHA_HOOK_URL` and `ALPHA_HOOK_SECRET` empty (no Alpha
relay, so no WhatsApp and no AI calls), `ALPHA_ACTIONS_ENABLED=false`,
`NOTIFICATIONS_ENABLED=false`. Vercel crons never run on previews.
Not disarmed: R2. The preview uses production's bucket keys, so photos that
exist in production show in staging and an upload from staging lands in the
same bucket (under new keys; it cannot overwrite production objects).

## Redeploy a preview against staging

```
export VERCEL_TOKEN=<VERCEL_TOKEN_VISION>
export STAGING_ENV_FILE=~/Documents/ai-employee-agent/.local/alphaos-staging.env
scripts/staging/deploy-preview.sh
```

It deploys the current checkout as a preview with `DATABASE_URL`,
`DIRECT_URL` (build and runtime), `AUTH_URL`, `NEXT_PUBLIC_APP_URL` and the
relay variables overridden, then moves the `alphaos-staging.vercel.app`
alias to it. The preview environment's own variables point at PRODUCTION,
so never deploy a plain preview and use it for testing. Previews have no
deployment protection on this project; no bypass header is needed.

## Reset staging to a fresh copy of production

```
set -a; . ~/Documents/ai-employee-agent/.local/alphaos-staging.env; set +a
SOURCE_URL=<production DIRECT_URL, from vercel env pull --environment production> \
TARGET_URL="$STAGING_DIRECT_URL" npx tsx scripts/staging/clone-prod.ts --yes
TARGET_URL="$STAGING_DIRECT_URL" APP_USER_PASSWORD="$STAGING_APP_USER_PASSWORD" \
  npx tsx scripts/staging/prepare.ts
```

`prepare.ts` must run after every clone: the clone brings production's
credentials and email switches with it. Both scripts refuse to write to the
production endpoint.

## Remove staging

`vercel integration resource remove alphaos-staging-2026-09-23` (deletes the
Neon database and the `STAGING_*` preview variables), then
`vercel alias rm alphaos-staging.vercel.app`.
