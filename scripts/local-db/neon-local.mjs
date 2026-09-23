// ESM twin of neon-local.cjs, for code that loads the driver's ESM build
// (drizzle-kit does). NODE_OPTIONS="--import ./scripts/local-db/neon-local.mjs".
const proxy = process.env.NEON_LOCAL_PROXY;
if (proxy) {
  const { neonConfig } = await import("@neondatabase/serverless");
  const { default: ws } = await import("ws");
  if (!neonConfig.__alphaosLocal) {
    neonConfig.webSocketConstructor = ws;
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
