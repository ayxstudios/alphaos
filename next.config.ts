import type { NextConfig } from "next";

// One id per build: versions the service worker so a deploy retires the old
// static cache (components/shell/sw-register.tsx, public/sw.js).
const BUILD_ID =
  process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || `local-${Date.now().toString(36)}`;

const nextConfig: NextConfig = {
  // Several dev servers can run from one checkout (parallel QA lanes); each
  // needs its own build folder or they corrupt each other's output.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Keep the Neon WebSocket driver and `ws` out of the webpack server bundle.
  // Bundling `ws` mangles its frame-masking fallback ("b.mask is not a
  // function"), which breaks every server-side DB query at runtime even though
  // the build succeeds. Externalizing lets them load from node_modules as-is.
  serverExternalPackages: ["ws", "@neondatabase/serverless"],
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },
  experimental: {
    // Client router cache (docs/PERF.md). A page visited in the last 30 s
    // (back, forward, or a second click) shows at once from memory instead of
    // a new server round trip; a page prefetched on hover stays usable for 30 s
    // (Next's floor, down from 5 min so hover data is never old). Any server
    // action that changes data still refreshes what it touched.
    staleTimes: {
      dynamic: 30,
      static: 30,
    },
  },
  async headers() {
    return [
      {
        // The service worker must always be re-checked so a deploy takes over.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
