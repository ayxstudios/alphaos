import type { NextConfig } from "next";

// One id per build: versions the service worker so a deploy retires the old
// static cache (components/shell/sw-register.tsx, public/sw.js).
const BUILD_ID =
  process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || `local-${Date.now().toString(36)}`;

// Security headers on every response (customer + security QA 2026-09-25).
// Before this the app sent none of them, so the public proof page (an Approve
// button behind a token) could be framed by another site, a browser could
// sniff a served file into a different type, and a proof or upload URL (the
// token IS the credential) leaked in the Referer of any outbound link.
//  - frame-ancestors 'none' + X-Frame-Options DENY: nothing embeds the app.
//    Vercel's preview toolbar runs in the page itself, not in a frame.
//  - nosniff: a response is only ever what its Content-Type says.
//  - strict-origin-when-cross-origin: no path (no token) leaves the origin.
//  - Permissions-Policy: the app uses none of these device features. The
//    upload page's file picker and phone camera capture work without them.
//  - HSTS: Vercel already sends it on *.vercel.app; set here too so a custom
//    domain gets it as well.
// A full script-src CSP is deliberately not set: Next.js inline runtime
// scripts need a per-request nonce, which is a larger change than this pass.
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Several dev servers can run from one checkout (parallel QA lanes); each
  // needs its own build folder or they corrupt each other's output.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // No "X-Powered-By: Next.js" on responses (nothing needs to know the stack).
  poweredByHeader: false,
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
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
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
