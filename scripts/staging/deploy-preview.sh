#!/usr/bin/env bash
# Deploy the current checkout as a Vercel PREVIEW wired to the staging database,
# then point the stable alias at it (docs/STAGING.md). Never touches production.
#
#   STAGING_ENV_FILE=~/Documents/ai-employee-agent/.local/alphaos-staging.env \
#   VERCEL_TOKEN=<vision token> scripts/staging/deploy-preview.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${STAGING_ENV_FILE:?set STAGING_ENV_FILE}"
: "${VERCEL_TOKEN:?set VERCEL_TOKEN}"
SCOPE="${VERCEL_SCOPE:-team_hdxl43AlgWsesgr06UyM3Lnk}"
ALIAS="${STAGING_ALIAS:-alphaos-staging.vercel.app}"
set -a; . "$STAGING_ENV_FILE"; set +a

# The preview environment of this project points at PRODUCTION (DATABASE_URL,
# AUTH_URL, the Alpha relay). Every one of those is overridden here.
OUT=$(vercel deploy --yes --token "$VERCEL_TOKEN" --scope "$SCOPE" \
  -b DIRECT_URL="$STAGING_DIRECT_URL" \
  -e DATABASE_URL="$STAGING_DATABASE_URL" \
  -e DIRECT_URL="$STAGING_DIRECT_URL" \
  -e AUTH_URL="https://$ALIAS" \
  -e NEXT_PUBLIC_APP_URL="https://$ALIAS" \
  -b NEXT_PUBLIC_APP_URL="https://$ALIAS" \
  -e ALPHA_HOOK_URL="" \
  -e ALPHA_HOOK_SECRET="" \
  -e ALPHA_ACTIONS_ENABLED=false \
  -e NOTIFICATIONS_ENABLED=false \
  -e MOCK_INTEGRATIONS=1 \
  -e STAGING=1)
# MOCK_INTEGRATIONS=1: instrumentation.ts installs lib/mock/transport.ts at
# server start, so calls made with the mock credentials that
# scripts/staging/arm-mocks.ts writes are answered in-process. It mocks by
# CREDENTIAL, never globally: with the database disarmed (prepare.ts) there is
# simply nothing for it to answer.
# The CLI prints a bare URL for humans and a JSON object when it detects an agent.
URL=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{s=s.trim();try{const j=JSON.parse(s);console.log(j.deployment.url)}catch{console.log(s.split(/\s+/).pop())}})')
echo "deployment: $URL"
vercel alias set "$URL" "$ALIAS" --token "$VERCEL_TOKEN" --scope "$SCOPE" >/dev/null
echo "alias: https://$ALIAS"
