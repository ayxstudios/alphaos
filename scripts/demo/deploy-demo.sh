#!/usr/bin/env bash
# Deploy the current checkout as a Vercel PREVIEW wired to the DEMO database
# (docs/DEMO.md), adapted from scripts/staging/deploy-preview.sh. Never
# touches production or staging.
#
#   DEMO_ENV_FILE=~/Documents/ai-employee-agent/.local/alphaos-demo.env \
#   VERCEL_TOKEN=<vercel token> scripts/demo/deploy-demo.sh
#
# NOT run as part of this task: this script is written and reviewed, not
# executed (the brief that produced it says not to deploy).
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${DEMO_ENV_FILE:?set DEMO_ENV_FILE}"
: "${VERCEL_TOKEN:?set VERCEL_TOKEN}"
SCOPE="${VERCEL_SCOPE:-team_hdxl43AlgWsesgr06UyM3Lnk}"
ALIAS="${DEMO_ALIAS:-alphaos-demo.vercel.app}"
set -a; . "$DEMO_ENV_FILE"; set +a

# The preview environment of this project points at PRODUCTION (DATABASE_URL,
# AUTH_URL, the Alpha relay). Every one of those is overridden here, plus
# ENCRYPTION_KEY (the demo's own key, both at build time -- some server
# actions run at build -- and at runtime) and DEMO=1 so the UI can tell a
# demo deployment from a staging one (see the "Staging"/"Demo" label note in
# docs/DEMO.md).
#
# NOTE on -e / -b precedence (checked via `vercel deploy --help` and
# https://vercel.com/docs/environment-variables during this task): the CLI
# docs don't spell out -e-vs-dashboard precedence explicitly, but Vercel's own
# docs confirm the same mechanism (a more specific variable set at deploy/
# branch scope overrides a less specific project-level one) for branch-scoped
# `vercel env` vars, and scripts/staging/deploy-preview.sh already relies on
# -e overriding this project's dashboard-configured Preview DATABASE_URL
# (which points at production) in every staging deploy. Treat that as the
# proven behavior: -e/-b override existing Preview env vars FOR THIS
# DEPLOYMENT ONLY; they do not change the project's stored Preview variables,
# so the next deploy without these flags reverts to whatever the dashboard
# has. If a future Vercel CLI version changes this, the safer fallback is
# per-branch `vercel env add <KEY> preview <branch>` for
# task/alphaos-reqc8bcc, which is documented to override generic Preview vars
# unconditionally and persists across deploys of that branch.
OUT=$(vercel deploy --yes --token "$VERCEL_TOKEN" --scope "$SCOPE" \
  -b DATABASE_URL="$DEMO_DATABASE_URL" \
  -b DIRECT_URL="$DEMO_DIRECT_URL" \
  -b ENCRYPTION_KEY="$DEMO_ENCRYPTION_KEY" \
  -e DATABASE_URL="$DEMO_DATABASE_URL" \
  -e DIRECT_URL="$DEMO_DIRECT_URL" \
  -e ENCRYPTION_KEY="$DEMO_ENCRYPTION_KEY" \
  -e AUTH_URL="https://$ALIAS" \
  -e NEXT_PUBLIC_APP_URL="https://$ALIAS" \
  -b NEXT_PUBLIC_APP_URL="https://$ALIAS" \
  -e ALPHA_HOOK_URL="" \
  -e ALPHA_HOOK_SECRET="" \
  -e ALPHA_ACTIONS_ENABLED=false \
  -e NOTIFICATIONS_ENABLED=false \
  -e MOCK_INTEGRATIONS=1 \
  -e PRINT_PROVIDER_MOCK=1 \
  -e STAGING=1 \
  -e SUPPORT_EMAIL="${SUPPORT_EMAIL:-support@alphaos-demo.test}" \
  -e DEMO=1)
# MOCK_INTEGRATIONS=1: instrumentation.ts installs lib/mock/transport.ts at
# server start, so calls made with the mock credentials scripts/seed.ts
# writes (Gmail, Etsy, Shopify, Anthropic) are answered in-process; Gelato and
# Luma Prints check their own credential shape directly (PRINT_PROVIDER_MOCK=1
# is belt-and-suspenders, matching the mock_-prefixed apiKey/username the
# seed already writes). It mocks by CREDENTIAL, never globally.
# STAGING=1 is kept (some checks may key off it); DEMO=1 is the demo-specific
# flag (item 5 of docs/DEMO.md: only matters if/when a Staging banner exists).
# The CLI prints a bare URL for humans and a JSON object when it detects an agent.
URL=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{s=s.trim();try{const j=JSON.parse(s);console.log(j.deployment.url)}catch{console.log(s.split(/\s+/).pop())}})')
echo "deployment: $URL"
vercel alias set "$URL" "$ALIAS" --token "$VERCEL_TOKEN" --scope "$SCOPE" >/dev/null
echo "alias: https://$ALIAS"
