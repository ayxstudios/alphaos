/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload; require is the point. */
// Preload that points the Neon serverless driver at scripts/local-db/ws-proxy.mjs,
// so the app, drizzle-kit and the repo scripts run unchanged against a LOCAL
// Postgres. Loaded with NODE_OPTIONS="--require ./scripts/local-db/neon-local.cjs".
// Does nothing unless NEON_LOCAL_PROXY is set (e.g. "127.0.0.1:5491").
//
// Local Postgres speaks plain TCP, so: no TLS inside the socket, no pipelined
// startup, and pool queries over the WebSocket instead of Neon's HTTP endpoint
// (which the proxy does not serve). lib/db sets poolQueryViaFetch = true at
// import time, so that one is pinned off rather than just set.
const proxy = process.env.NEON_LOCAL_PROXY;
if (proxy) {
  const { neonConfig } = require("@neondatabase/serverless");
  if (!neonConfig.__alphaosLocal) {
    neonConfig.webSocketConstructor = require("ws");
    neonConfig.wsProxy = (host, port) => `${proxy}/v1?address=${host}:${port}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineTLS = false;
    neonConfig.pipelineConnect = false;
    neonConfig.forceDisablePgSSL = true;
    Object.defineProperty(neonConfig, "poolQueryViaFetch", {
      configurable: true,
      get: () => false,
      set: () => {},
    });
    Object.defineProperty(neonConfig, "__alphaosLocal", { value: true });
  }
}
