import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Several dev servers can run from one checkout (parallel QA lanes); each
  // needs its own build folder or they corrupt each other's output.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Keep the Neon WebSocket driver and `ws` out of the webpack server bundle.
  // Bundling `ws` mangles its frame-masking fallback ("b.mask is not a
  // function"), which breaks every server-side DB query at runtime even though
  // the build succeeds. Externalizing lets them load from node_modules as-is.
  serverExternalPackages: ["ws", "@neondatabase/serverless"],
};

export default nextConfig;
