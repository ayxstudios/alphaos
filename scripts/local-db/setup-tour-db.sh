#!/usr/bin/env bash
# Builds the LOCAL test database the tour check (and test:rls / test:transitions)
# run against. Never touches production: it refuses unless both URLs in
# .env.local point at localhost.
#
#   scripts/local-db/setup-tour-db.sh            # db alphaos_tour_test, proxy 127.0.0.1:5497
#
# Needs: local Postgres 16 on localhost:5432 with trust auth for this user, and
# a .env.local like:
#   DATABASE_URL="postgresql://app_user@localhost:5432/alphaos_tour_test"
#   DIRECT_URL="postgresql://neondb_owner@localhost:5432/alphaos_tour_test"
#   NEON_LOCAL_PROXY="127.0.0.1:5497"
#   AUTH_SECRET=... ENCRYPTION_KEY=... AUTH_URL="http://localhost:3461"
set -euo pipefail
cd "$(dirname "$0")/../.."

env_get() { grep -E "^$1=" .env.local | head -1 | sed -E "s/^$1=\"?([^\"]*)\"?$/\1/"; }
DATABASE_URL=$(env_get DATABASE_URL)
DIRECT_URL=$(env_get DIRECT_URL)
PROXY=$(env_get NEON_LOCAL_PROXY)
PROXY=${PROXY:-127.0.0.1:5497}
for url in "$DATABASE_URL" "$DIRECT_URL"; do
  case "$url" in
    *@localhost:*|*@127.0.0.1:*) ;;
    *) echo "refusing: .env.local database URLs must point at localhost" >&2; exit 1 ;;
  esac
done
DB=$(basename "${DIRECT_URL%%\?*}")
PSQL=(psql -h localhost -d postgres -v ON_ERROR_STOP=1 -q)

# Roles: the owner name the repo scripts insist on, and the app role with a login.
"${PSQL[@]}" -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='neondb_owner') THEN CREATE ROLE neondb_owner LOGIN CREATEDB; END IF; END \$\$;"
"${PSQL[@]}" -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);"
"${PSQL[@]}" -c "CREATE DATABASE $DB OWNER neondb_owner;"

# The Neon driver needs the local WebSocket bridge.
if ! nc -z "${PROXY%:*}" "${PROXY##*:}" 2>/dev/null; then
  node scripts/local-db/ws-proxy.mjs --port "${PROXY##*:}" > /dev/null 2>&1 &
  PROXY_PID=$!
  trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
  sleep 1
fi
export NEON_LOCAL_PROXY="$PROXY"
export NODE_OPTIONS="--require ./scripts/local-db/neon-local.cjs --import ./scripts/local-db/neon-local.mjs"

npx drizzle-kit migrate
# 0001_rls_policies creates app_user NOLOGIN; the app connects as it (RLS in force).
"${PSQL[@]}" -c "ALTER ROLE app_user WITH LOGIN;"

npm run -s db:seed > /dev/null
PASSWORD="tourpass123"
npm run -s create-user -- tour-admin@alphaos.test "Amira Hassan" admin "$PASSWORD"
npm run -s create-user -- tour-va@alphaos.test "Vera Lopez" va "$PASSWORD"
npm run -s create-user -- tour-designer@alphaos.test "Dina Park" designer "$PASSWORD"

# A new designer needs a business and some work on the board: attach Dina to
# Lumina with a profile, and hand her d3's active orders (d3 is not used by the
# RLS or transition tests).
psql -h localhost -d "$DB" -U neondb_owner -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO designer_businesses (user_id, business_id)
SELECT u.id, b.id FROM "user" u, businesses b
WHERE u.email = 'tour-designer@alphaos.test' AND b.name = 'Lumina'
ON CONFLICT DO NOTHING;
INSERT INTO designer_profiles (user_id, daily_capacity, per_figure_rate, styles)
SELECT id, 5, 4.00, ARRAY['cartoon','watercolour'] FROM "user" WHERE email = 'tour-designer@alphaos.test'
ON CONFLICT (user_id) DO NOTHING;
UPDATE assignments SET designer_id = (SELECT id FROM "user" WHERE email = 'tour-designer@alphaos.test')
WHERE active AND designer_id = (SELECT id FROM "user" WHERE email = 'd3@aystudios.io');
SQL

echo "local db $DB ready: tour-admin / tour-va / tour-designer @alphaos.test, password $PASSWORD"
