# Region move to Singapore (2026-09-24)

Production's database and functions moved from the US east coast to
Singapore, next to the users (owners in Melbourne, VAs in South East Asia).
docs/PERF.md found that ~280 ms of every request was the Australia to Virginia
round trip.

**Rule from now on: the Singapore Neon project `floral-truth-37733980` is THE
production database.** The us-east-1 project is a frozen rollback copy. Never
write to it or point anything at it except during a rollback.

## Authorisation

The owner's words, relayed by the lead session on 2026-09-24 ~06:15 AEST:
"yes do free neon in singapore sure." The lead session made the one free Neon
resource with the Vercel spend guard's escape hatch:
`VERCEL_SPEND_OK=1 vercel integration add neon --name alphaos-prod-sin --plan free_v3 -m region=sin1 -m auth=false -e development --prefix SIN_ --no-env-pull`.
Free plan, no paid plan, no plan change.

## What moved

| | Before | After |
|---|---|---|
| Neon project | `raspy-surf-15386736`, aws-us-east-1, Postgres 17.11 | `floral-truth-37733980` (Vercel resource `alphaos-prod-sin`), aws-ap-southeast-1, Postgres 18.6 |
| Endpoint | `ep-spring-dawn-audsesft` | `ep-sweet-king-azfnjij5` |
| Vercel functions | `iad1` | `sin1` (`vercel.json` `regions`) |
| Production deployment | `dpl_2oSyrmjpaY3q5RbMRzozgsdJfVjN` (alphaos-qpr9e90c9) | `dpl_3qvKZsNpWBdrgvTmqSfi9AFgu7x9` (alphaos-amlsdvopl), branch commit 5960e29 |

The integration gave Postgres 18 (its default); production was 17. A dump from
17 restored into 18 is the normal upgrade direction. The rehearsal checked
restore, migrations, grants, policies and RLS on 18 before the cutover.

Vercel production variables: `DATABASE_URL` = `app_user` on the Singapore
POOLED host (type sensitive, as before), `DIRECT_URL` = `neondb_owner` on the
Singapore DIRECT host. The `SIN_*` variables the integration created live in
the DEVELOPMENT environment only. The `POSTGRES_*`/`PG*` production variables
still describe the old project; the app never reads them (grep: only
`DATABASE_URL` and `DIRECT_URL`). The PREVIEW environment's `DATABASE_URL`/
`DIRECT_URL` still point at the OLD database (the rollback copy);
`scripts/staging/deploy-preview.sh` overrides them for staging.

## Roles and grants (reproduced exactly)

Read from the old database, applied to the new one:

- `app_user`: LOGIN, NOBYPASSRLS, INHERIT, no CREATEDB/CREATEROLE, no role
  settings, new password (the old one was not reused).
- `neondb_owner` is the new project's owner role (same name as before; the
  integration made it).
- `USAGE` on schema `public`. SELECT, INSERT, UPDATE, DELETE on every table and
  view in `public`, except `activity_log` (SELECT, INSERT only) and `account`,
  `session`, `verification_token` (no grant, as on the old database).
- Default privileges: `neondb_owner` in `public` grants SELECT, INSERT, UPDATE,
  DELETE on new tables to `app_user`.
- No rights on schema `drizzle` (owner only). No sequences in `public`.

The dump was `pg_dump -Fc --no-owner --no-privileges -N neon_auth` (client
17.11) of the whole `neondb` database: schema, data and
`drizzle.__drizzle_migrations`. The unused Neon Auth schema was left out.
Grants were applied after the restore. The old project also holds a
`nuke_dev` database and a `nuke_app` role, which belong to another app and
were not moved. An old-vs-new comparison of every `app_user` table grant,
RLS enabled/forced flag, policy (76), policy helper function, view, index,
default ACL and role attribute matched line for line (255 lines).

`npm run db:migrate` (drizzle-kit migrate) against the new DIRECT_URL was a
no-op: 41 migrations before and after.

RLS as `app_user` on the new pooled host: `app.role=designer` with an
unattached user sees 0 customers and 0 orders. `app.role=admin` sees 21
customers and 123 orders. No context set sees 0.

## Cutover timeline (UTC, 2026-09-23 = AEST 2026-09-24 +10 h)

1. Rehearsal 20:39-20:43: full dump and restore, migrate no-op, counts and
   structure matched, RLS checks passed.
2. 20:47: Vercel production `DATABASE_URL`/`DIRECT_URL` switched (`vercel env
   rm` + `vercel env add`). `vercel.json` changed to `sin1` and committed.
   `vercel deploy --prod --skip-domain` built the production deployment
   without moving the domain, so the old deployment kept serving until
   promotion. The build's `drizzle-kit migrate` ran on the Singapore database
   (no-op).
3. 20:49:30: `launchctl unload` of `com.almacorp.alphaos-shopify-sync`.
4. 20:49:31-20:52:44: final dump, wipe of the new `public` and `drizzle`
   schemas, restore, grants, counts, structure and RLS checks.
5. 20:52:48: `vercel promote` to the Singapore deployment.
6. Afterwards, the old database's row counts matched the final dump exactly,
   so no writes landed on the old database in the window.
7. 20:54: both `.env.local` files and the secrets file updated, sync plist
   loaded.

## Row counts (37 tables), final dump: old = new

| table | rows | table | rows |
|---|---|---|---|
| drizzle.__drizzle_migrations | 41 | notification_fires | 161 |
| account | 0 | notifications | 225 |
| activity_log | 206 | order_items | 24 |
| alpha_events | 0 | order_shipping_addresses | 123 |
| assets | 39 | orders | 123 |
| assignments | 0 | print_jobs | 0 |
| businesses | 1 | print_product_mappings | 1 |
| customers | 21 | print_reconcile_ledger | 9 |
| daily_health_reports | 3 | proofs | 0 |
| designer_businesses | 0 | qc_checks | 0 |
| designer_profiles | 0 | rate_limits | 8 |
| earnings | 0 | reminder_fires | 0 |
| email_sender_ignores | 0 | session | 0 |
| email_templates | 12 | shops | 2 |
| ignored_products | 0 | styles | 4 |
| job_runs | 8184 | user | 3 |
| login_attempts | 0 | verification_token | 0 |
| login_links | 2 | messages | 42 |
| notification_channels | 0 | | |

## Verification after promotion

- `/api/health` 200 `{"status":"ok"}`, `x-vercel-id: syd1::sin1::...`.
- Admin sign-in through the NextAuth credentials flow (csrf, then POST
  `/api/auth/callback/credentials`): 302 to `/dashboard` with a session
  cookie. `/dashboard` 200. `/orders` 200 and lists the open orders.
- `pg_stat_activity` on the new database shows the app connected as
  `app_user` (4 connections) and not as the owner.
- The daemon's cron calls through the app ran on the new database at 20:59
  (`cron.sync`, `shop.sync`, `cron.gmail_poll`, `cron.notifications`,
  `cron.reminders`, `cron.print_reconcile`, all `ok`). The Etsy shop's
  `lastSyncAt` moved to 20:59:07 on the new database.

## TTFB from this Mac (Melbourne), ms, median of 6 warm requests

Measured with Node fetch on one connection, signed in as admin.

| path | before (iad1) | after (sin1) |
|---|---|---|
| `/api/health` (no DB) | 332 | 235 / 286 (two runs) |
| `/login` (static shell) | 55 to 302 (two runs, noisy) | 59 / 64 |
| `/dashboard` (signed in) | 376 | 339 / 314 |
| `/orders` (signed in) | 387 | 299 / 356 |

## Rollback (the old project is intact)

The old Neon project `raspy-surf-15386736` (`ep-spring-dawn-audsesft`) was
only read, so its data is frozen at 20:49:31 UTC. The old connection strings
are in `~/Documents/ai-employee-agent/.local/prod-secrets.env` as
`ALPHAOS_APP_USER_DATABASE_URL_OLD_USEAST` (app_user, pooled) and
`ALPHAOS_OWNER_DATABASE_URL_OLD_USEAST` (owner, direct).

1. `launchctl unload ~/Library/LaunchAgents/com.almacorp.alphaos-shopify-sync.plist`
2. If the app wrote anything to Singapore that must be kept, copy it back
   first. Row by row: `SOURCE_URL=<Singapore owner> TARGET_URL=<old owner>`
   would be refused by `clone-prod.ts` (both are production hosts), so do
   targeted inserts, or use a Postgres 18 `pg_dump --data-only`.
3. Vercel production env: `vercel env rm DATABASE_URL production --yes`, then
   `vercel env add DATABASE_URL production --sensitive` with
   `ALPHAOS_APP_USER_DATABASE_URL_OLD_USEAST`. Same for `DIRECT_URL` with
   `ALPHAOS_OWNER_DATABASE_URL_OLD_USEAST` (`--no-sensitive`).
4. `vercel.json` `regions` back to `["iad1"]`, commit, `vercel deploy --prod`.
   Or, for an instant rollback of the running code (it has the old env baked
   in): `vercel promote alphaos-qpr9e90c9-almacorpvision.vercel.app`, then fix
   the env before the next deploy.
5. Put the old URLs back in `~/Documents/projects/alphaos-wt-alpha/.env.local`
   and `~/Documents/projects/alphaos/.env.local` (DATABASE_URL + DIRECT_URL
   together, or the local sync fails with "Failed query: begin"), and
   `ALPHAOS_APP_USER_DATABASE_URL` in the secrets file (the old app_user
   password is inside the `_OLD_USEAST` URL).
6. `launchctl load` the plist and check
   `~/Library/Logs/ai-employee-agent/alphaos-shopify-sync.log`.

## Where the connection strings live now

- Vercel production `DATABASE_URL` (app_user, pooled) and `DIRECT_URL`
  (owner, direct).
- `~/Documents/projects/alphaos-wt-alpha/.env.local` and
  `~/Documents/projects/alphaos/.env.local`: `DATABASE_URL` + `DIRECT_URL`.
- `~/Documents/ai-employee-agent/.local/prod-secrets.env`:
  `ALPHAOS_APP_USER_PASSWORD`, `ALPHAOS_APP_USER_DATABASE_URL`,
  `ALPHAOS_OWNER_DATABASE_URL_SIN` (Singapore), plus the two `_OLD_USEAST`
  rollback URLs.
- Vercel development `SIN_*` (the integration's own owner URLs).

Staging: `scripts/staging/prod-endpoints.ts` lists both production hosts, and
`clone-prod.ts`, `prepare.ts` and `arm-mocks.ts` refuse to write to either.
The clone's `SOURCE_URL` is production's `DIRECT_URL` from `vercel env pull
--environment production`, which is now the Singapore host (docs/STAGING.md).
