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
DEMO_HOST=$(node -e 'console.log(new URL(process.env.DEMO_DIRECT_URL).hostname)')
if [[ "$DEMO_HOST" != *"$DEMO_NEON_PROJECT_ID"* ]]; then
  echo "refusing: DEMO_DIRECT_URL host ($DEMO_HOST) does not contain DEMO_NEON_PROJECT_ID ($DEMO_NEON_PROJECT_ID)" >&2
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
node -e '
const { Pool } = require("@neondatabase/serverless");
const ws = require("ws");
const { neonConfig } = require("@neondatabase/serverless");
neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DEMO_DIRECT_URL, max: 1 });
const pw = process.env.DEMO_APP_USER_PASSWORD.replace(/'"'"'/g, "'"'"''"'"'"'"'"'");
pool.query(`do $$ begin execute format('"'"'alter role app_user with login password %L'"'"', '"'"'${pw}'"'"'); end $$`)
  .then(() => pool.end())
  .then(() => console.log("app_user password set"))
  .catch((err) => { console.error(err); process.exit(1); });
'

# ---- fictional identity for this demo run ----------------------------------
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

# ---- verification -----------------------------------------------------------
echo "== verification =="
node -e '
const { Pool } = require("@neondatabase/serverless");
const ws = require("ws");
const { neonConfig } = require("@neondatabase/serverless");
neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: process.env.DIRECT_URL, max: 1 });

async function main() {
  const businesses = await pool.query("select name, slug from businesses order by name");
  const users = await pool.query("select role, count(*)::int n from \"user\" group by role order by role");
  const orders = await pool.query("select status, count(*)::int n from orders group by status order by status");
  const qc = await pool.query(`
    select count(*)::int n from orders o
    where o.status = '"'"'awaiting_qc'"'"' and o.archived_at is null
      and exists (select 1 from assets a where a.order_id = o.id and a.type in ('"'"'submission'"'"','"'"'final'"'"') and a.deleted_at is null)
  `);
  const qcTotal = await pool.query("select count(*)::int n from orders where status = '"'"'awaiting_qc'"'"' and archived_at is null");
  const assetSplit = await pool.query(`
    select
      count(*)::int total,
      count(*) filter (where url like '"'"'/demo/%'"'"' or url like '"'"'%/demo/%'"'"')::int demo_urls,
      count(*) filter (where url like '"'"'%picsum.photos%'"'"')::int picsum_urls
    from assets where url is not null
  `);
  const pixart = await pool.query("select count(*)::int n from businesses where name ilike '"'"'%pixart%'"'"'");

  console.log("\nbusinesses:");
  for (const r of businesses.rows) console.log(`  ${r.name} (${r.slug})`);
  console.log("\nusers by role:");
  for (const r of users.rows) console.log(`  ${r.role}: ${r.n}`);
  console.log("\norders per status:");
  for (const r of orders.rows) console.log(`  ${r.status}: ${r.n}`);
  console.log(`\nawaiting_qc orders: ${qcTotal.rows[0].n} total, ${qc.rows[0].n} with a submission asset`);
  console.log(`assets: ${assetSplit.rows[0].total} total, ${assetSplit.rows[0].demo_urls} /demo/ url(s), ${assetSplit.rows[0].picsum_urls} picsum url(s)`);

  await pool.end();

  if (qc.rows[0].n < 1) {
    console.error("\nFAIL: no awaiting_qc order has a submission asset");
    process.exit(1);
  }
  if (pixart.rows[0].n > 0) {
    console.error("\nFAIL: a business name contains \"PixArt\"");
    process.exit(1);
  }
  console.log("\nOK: demo database verified");
}
main().catch((err) => { console.error(err); process.exit(1); });
'
