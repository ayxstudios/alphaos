import { neonConfig } from "@neondatabase/serverless";

/**
 * Local/CI only. When NEON_LOCAL_PROXY is set (e.g. "127.0.0.1:4444"), route
 * the Neon serverless driver through scripts/ci/neon-local-proxy.mjs to a
 * plain local Postgres: WebSocket for Pool/transactions, HTTP /sql for neon()
 * and poolQueryViaFetch. Unset in every deployed environment, so this is a
 * no-op there. Idempotent; call before creating any Pool.
 */
export function applyLocalNeonProxy(): void {
  const proxy = process.env.NEON_LOCAL_PROXY;
  if (!proxy) return;
  neonConfig.wsProxy = (host, port) => `${proxy}/v2?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  neonConfig.fetchEndpoint = () => `http://${proxy}/sql`;
}
