#!/usr/bin/env bash
# Stand up (or re-stand-up) the fictional AlphaOS DEMO database (docs/DEMO.md).
#
# Idempotent and safe to re-run: migrations only apply what's missing, the
# app_user ALTER just resets the password, and every seed script below
# truncates-then-reinserts or upserts by deterministic id.
#
# Never touches production or staging: refuses unless DEMO_DIRECT_URL's host
# contains DEMO_NEON_PROJECT_ID (a brand-new, demo-only Neon project).
#
#   DEMO_ENV_FILE=~/Documents/ai-employee-agent/.local/alphaos-demo.env \
#     scripts/demo/seed-demo.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE="${DEMO_ENV_FILE:-$HOME/Documents/ai-employee-agent/.local/alphaos-demo.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "demo env file not found: $ENV_FILE" >&2
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

: "${DEMO_NEON_PROJECT_ID:?DEMO_NEON_PROJECT_ID not set in $ENV_FILE}"
: "${DEMO_DIRECT_URL:?DEMO_DIRECT_URL not set in $ENV_FILE}"
: "${DEMO_DATABASE_URL:?DEMO_DATABASE_URL not set in $ENV_FILE}"
: "${DEMO_APP_USER_PASSWORD:?DEMO_APP_USER_PASSWORD not set in $ENV_FILE}"
: "${DEMO_ENCRYPTION_KEY:?DEMO_ENCRYPTION_KEY not set in $ENV_FILE}"
: "${DEMO_ALIAS:?DEMO_ALIAS not set in $ENV_FILE}"
: "${DEMO_PASSWORD:?DEMO_PASSWORD not set in $ENV_FILE}"
: "${DEMO_ADMIN_EMAIL:?DEMO_ADMIN_EMAIL not set in $ENV_FILE}"
: "${DEMO_VA_EMAIL:?DEMO_VA_EMAIL not set in $ENV_FILE}"
: "${DEMO_DESIGNER_EMAIL:?DEMO_DESIGNER_EMAIL not set in $ENV_FILE}"

# ---- safety rail: this must be the demo project, never prod or staging -----
# Neon endpoint hostnames (ep-<random>-<id>...) do not literally contain the
# project id (a separate "adjective-noun-digits" id, e.g. falling-snow-...),
# so a plain substring check on the host can never pass and would make this
# script refuse to run every time. Instead ask the Neon API which project
# actually owns this endpoint host and compare that to DEMO_NEON_PROJECT_ID.
export DEMO_HOST=$(node -e 'console.log(new URL(process.env.DEMO_DIRECT_URL).hostname)')
: "${NEON_API_KEY:?set NEON_API_KEY (used only to verify DEMO_DIRECT_URL belongs to DEMO_NEON_PROJECT_ID)}"
OWNER_PROJECT=$(curl -sf -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/$DEMO_NEON_PROJECT_ID/endpoints" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const host=process.env.DEMO_HOST;const e=(j.endpoints||[]).find(e=>e.host===host);console.log(e?e.project_id:"")})')
if [ "$OWNER_PROJECT" != "$DEMO_NEON_PROJECT_ID" ]; then
  echo "refusing: DEMO_DIRECT_URL host ($DEMO_HOST) is not an endpoint of DEMO_NEON_PROJECT_ID ($DEMO_NEON_PROJECT_ID) per the Neon API" >&2
  exit 1
fi
DEMO_USER=$(node -e 'console.log(new URL(process.env.DEMO_DIRECT_URL).username)')
if [ "$DEMO_USER" != "neondb_owner" ]; then
  echo "refusing: DEMO_DIRECT_URL must connect as neondb_owner (got \"$DEMO_USER\")" >&2
  exit 1
fi
echo "demo host confirmed: $DEMO_HOST"

# ---- migrations (owner connection; creates/updates app_user's grants via
#      lib/db/migrations, e.g. 0001_rls_policies.sql's CREATE ROLE + GRANTs) --
echo "== running migrations against the demo database =="
DIRECT_URL="$DEMO_DIRECT_URL" npx drizzle-kit migrate

# ---- app_user login (same action scripts/staging/prepare.ts takes; the
#      GRANTs themselves live in the migrations just applied, not here) ------
echo "== setting app_user password =="
node scripts/demo/set-app-user-password.cjs

# ---- fictional identity for this demo run ----------------------------------
export SUPPORT_EMAIL="${SUPPORT_EMAIL:-support@alphaos-demo.test}"
export SEED_BUSINESS_A_NAME="${SEED_BUSINESS_A_NAME:-Northlight Portraits}"
export SEED_BUSINESS_A_SLUG="${SEED_BUSINESS_A_SLUG:-northlight}"
export SEED_BUSINESS_B_NAME="${SEED_BUSINESS_B_NAME:-Paws and Pencils}"
export SEED_BUSINESS_B_SLUG="${SEED_BUSINESS_B_SLUG:-paws-pencils}"
export SEED_PASSWORD="$DEMO_PASSWORD"
export SEED_USERS_JSON=$(node -e '
console.log(JSON.stringify([
  { email: process.env.DEMO_ADMIN_EMAIL, name: "Demo Owner", role: "admin" },
  { email: process.env.DEMO_VA_EMAIL, name: "Tessa VA", role: "va" },
  { email: "omar@alphaos-demo.test", name: "Omar VA", role: "va" },
  { email: process.env.DEMO_DESIGNER_EMAIL, name: "Dana Designer", role: "designer" },
  { email: "leo@alphaos-demo.test", name: "Leo Designer", role: "designer" },
  { email: "mia@alphaos-demo.test", name: "Mia Designer", role: "designer" },
]))
')

# ---- run the seed pipeline as the owner (DIRECT_URL), demo image manifest --
export DIRECT_URL="$DEMO_DIRECT_URL"
export ENCRYPTION_KEY="$DEMO_ENCRYPTION_KEY"
export SEED_IMAGE_MANIFEST=1
export PRINT_PROVIDER_MOCK=1

echo "== seed.ts =="
npx tsx scripts/seed.ts
echo "== seed-history.ts =="
npx tsx scripts/seed-history.ts
echo "== seed-qc.ts =="
npx tsx scripts/seed-qc.ts
echo "== seed-demo-assets.ts =="
npx tsx scripts/seed-demo-assets.ts

# ---- verification -----------------------------------------------------------
echo "== verification =="
node scripts/demo/verify-demo.cjs
