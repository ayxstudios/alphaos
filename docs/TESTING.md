# Testing

## One command

```
scripts/ci-local.sh        # or: npm run ci:local
```

Needs a local Postgres 16 with a superuser on `localhost:5432` (Homebrew
default: your macOS user, trust auth; override with `PGHOST`, `PGPORT`,
`PGUSER`). It never touches Neon. What it does, every run, from scratch:

1. drops and recreates the `alphaos_ci` database
2. creates two roles that mirror Neon: `neondb_owner` (owns the tables, runs
   migrations and seeds) and `app_user` (the app login; owns nothing, no
   BYPASSRLS, so row-level security is really enforced and `test:rls` means
   something)
3. starts `scripts/ci/neon-local-proxy.mjs` on `127.0.0.1:4444` and sets
   `NEON_LOCAL_PROXY`, so the app's own `@neondatabase/serverless` driver
   (WebSocket pool and HTTP `neon()`) talks to local Postgres unchanged
4. applies every migration (`scripts/ci/migrate-local.ts`, same files and
   journal as `npm run db:migrate`), runs `npm run db:seed`
5. runs `npm run test:all`

All secrets in the script are fixed test values. Mock integrations are on
(`MOCK_INTEGRATIONS=1`, `PRINT_PROVIDER_MOCK=1`, a `mock_` Anthropic key), so
nothing leaves the machine.

## test:all

`npm run test:all` runs every `test:*` script in `package.json` in sequence
(they share one database), prints a table and one summary line
(`test:all OK: 17/17 passed`), and exits non-zero if any suite fails.
`npm run test:all -- rls earnings` runs a subset. It expects the database
from step 4 (the RLS and transition suites use the seed users).

## Local proxy

`NEON_LOCAL_PROXY` is read by `lib/db/local-proxy.ts`, called from
`lib/db/index.ts`, `scripts/load-env.ts`, `scripts/seed.ts` and
`scripts/test-db.ts`. It is unset in every deployed environment, where it is
a no-op.

## Also green before a merge

```
npm run lint
npm run build
```
