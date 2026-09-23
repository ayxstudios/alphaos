#!/usr/bin/env bash
# One command, whole local test bench:
#   1. drop + recreate the alphaos_ci database on a local Postgres 16
#   2. roles that mirror Neon: neondb_owner (owns the tables, runs migrations)
#      and app_user (the app login, RLS enforced because it owns nothing)
#   3. start scripts/ci/neon-local-proxy.mjs so the Neon driver reaches it
#   4. drizzle migrate, seed, then npm run test:all
#
# Usage: scripts/ci-local.sh            (PGHOST/PGPORT/PGUSER override the admin login)
# Needs: psql + a superuser on localhost (Homebrew default: your macOS user, trust auth).
# Never touches Neon: every URL below points at localhost.
set -euo pipefail
cd "$(dirname "$0")/.."

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-$(whoami)}"
DB="${CI_DB:-alphaos_ci}"
PROXY_PORT="${NEON_LOCAL_PROXY_PORT:-4444}"
OWNER_PW="ci_owner_pw"
APP_PW="ci_app_pw"

psql_admin() { psql -v ON_ERROR_STOP=1 -qtA -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$@"; }

echo "== reset database $DB"
psql_admin -d postgres <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS $DB;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'neondb_owner') THEN
    CREATE ROLE neondb_owner LOGIN CREATEROLE PASSWORD '$OWNER_PW';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD '$APP_PW';
  END IF;
END \$\$;
ALTER ROLE neondb_owner LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '$OWNER_PW';
ALTER ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '$APP_PW';
GRANT app_user TO neondb_owner WITH ADMIN OPTION;
CREATE DATABASE $DB OWNER neondb_owner;
SQL
psql_admin -d "$DB" -c "ALTER SCHEMA public OWNER TO neondb_owner;"

export NEON_LOCAL_PROXY="127.0.0.1:$PROXY_PORT"
export NEON_LOCAL_PROXY_PORT="$PROXY_PORT"
export DIRECT_URL="postgresql://neondb_owner:$OWNER_PW@localhost:$PGPORT/$DB"
export DATABASE_URL="postgresql://app_user:$APP_PW@localhost:$PGPORT/$DB"
# Test-only secrets, fixed so runs are repeatable. Nothing here is real.
export ENCRYPTION_KEY="${CI_ENCRYPTION_KEY:-0000000000000000000000000000000000000000000000000000000000000001}"
export AUTH_SECRET="ci-local-auth-secret-not-real"
export MOCK_INTEGRATIONS=1
export PRINT_PROVIDER_MOCK=1
export ANTHROPIC_API_KEY="mock_sk-ant-ci"
export NOTIFICATIONS_ENABLED=false
export CRON_SECRET="ci-cron-secret"
export NEXT_PUBLIC_APP_URL="http://localhost:3000"

echo "== neon local proxy on $NEON_LOCAL_PROXY"
node scripts/ci/neon-local-proxy.mjs > "${TMPDIR:-/tmp}/alphaos-neon-proxy.log" 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  (echo > "/dev/tcp/127.0.0.1/$PROXY_PORT") 2>/dev/null && break
  sleep 0.2
done

echo "== migrate"
npx tsx scripts/ci/migrate-local.ts

echo "== seed"
npm run -s db:seed > /dev/null

echo "== tests"
npm run -s test:all
