import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import { authConfig } from "@/lib/auth/config";

const { auth } = NextAuth(authConfig);

// Routes inside the app shell that require a session. Every page under
// app/(app) is listed, so role denials happen here as a clean 307 before any
// page renders (the pages keep their own checks as the second line).
const PROTECTED = [
  /^\/dashboard(\/|$)/,
  /^\/today(\/|$)/,
  /^\/orders(\/|$)/,
  /^\/board(\/|$)/,
  /^\/queue(\/|$)/,
  /^\/qc(\/|$)/,
  /^\/customers(\/|$)/,
  /^\/settings(\/|$)/,
  /^\/emails(\/|$)/,
  /^\/designers(\/|$)/,
  /^\/styles(\/|$)/,
  /^\/payouts(\/|$)/,
  /^\/health(\/|$)/,
  /^\/help(\/|$)/,
  /^\/me(\/|$)/,
  // The component styleguide is a staff design reference, not a public page.
  /^\/styleguide(\/|$)/,
];

// The only areas a designer may reach. Per-order ownership on /orders/[id] is
// enforced by RLS in the page (a designer only sees their assigned orders).
// Only the order page itself: not /orders/new, not /orders/[id]/complete.
const DESIGNER_ALLOWED = [
  /^\/dashboard(\/|$)/,
  /^\/board(\/|$)/,
  /^\/me(\/|$)/,
  /^\/help(\/|$)/,
  /^\/orders\/(?!new\/?$)[^/]+\/?$/,
];

// Admin-only areas (VAs are sent home, matching the pages' own redirects).
const ADMIN_ONLY = [/^\/payouts(\/|$)/, /^\/health(\/|$)/];

// Designer-only pages: staff who type one get the Designers page here, in
// the middleware, instead of a second full document after the page's own
// redirect (a typed /me on a phone on Slow 3G used to take 5.6 s: skeleton
// document, then the redirect, then /designers). Staff navigation never
// links /me; the page's own check stays as the second line.
const STAFF_TO_DESIGNERS = [/^\/me(\/|$)/];

// Public on purpose: a person's private sign-in link (lib/auth/login-link.ts)
// must open with no session. Listed so a later catch-all protection rule
// cannot swallow it by accident.
const PUBLIC = [/^\/auth\/link\/[^/]+\/?$/];

export default auth((req) => {
  // Vercel's preview toolbar (vercel.live feedback.js, injected on preview
  // deployments such as staging) probes `OPTIONS /` from phone browsers; a
  // page route answers that with 400, a console error on every page load.
  // Answer it plainly. No CORS headers: this widens nothing cross-origin.
  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: { Allow: "GET, HEAD, POST, OPTIONS" } });
  }
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((r) => r.test(pathname))) return NextResponse.next();
  const isProtected = PROTECTED.some((r) => r.test(pathname));
  if (!isProtected) return NextResponse.next();

  const session = req.auth;
  if (!session?.user) {
    const url = new URL("/login", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  if (session.user.role === "designer") {
    // A designer's view of an order is its card on My Board: one clean 307
    // for a typed or notification link, instead of the order page's loading
    // skeleton and then its own redirect (the page keeps that as the second line).
    const order = pathname.match(/^\/orders\/(?!new\/?$)([^/]+)\/?$/);
    if (order) {
      return NextResponse.redirect(new URL(`/board?open=${encodeURIComponent(order[1])}`, req.nextUrl.origin));
    }
    const allowed = DESIGNER_ALLOWED.some((r) => r.test(pathname));
    if (!allowed) {
      return NextResponse.redirect(new URL("/board", req.nextUrl.origin));
    }
  } else if (session.user.role !== "admin" && ADMIN_ONLY.some((r) => r.test(pathname))) {
    return NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin));
  } else if (STAFF_TO_DESIGNERS.some((r) => r.test(pathname))) {
    return NextResponse.redirect(new URL("/designers", req.nextUrl.origin));
  }

  return NextResponse.next();
});

export const config = {
  // Run on everything except API routes, Next internals, and static files.
  //
  // Speed (docs/PERF.md): on Vercel this middleware executes in the function
  // region (iad1), not at the edge next to the user, so every request it
  // matches pays one extra round trip to Virginia and back (~250 ms from
  // Australia) before the page function even starts. Client navigations and
  // prefetches carry the `RSC` header; they skip the middleware and rely on
  // each page's own session and role checks (every page under app/(app) runs
  // auth() and redirects by role before it reads any data). Full document
  // loads, where a clean 307 matters, still pass through here unchanged.
  //
  // The buyer pages (/proof/<token>, /upload/<token>) are public and never
  // read a session, so they skip it too: a buyer's page loads without that
  // extra round trip, and a buyer's browser is never handed the staff
  // sign-in cookies (csrf-token, callback-url) the auth wrapper sets
  // (customer + security QA 2026-09-25).
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|proof/|upload/|.*\\.).*)",
      missing: [{ type: "header", key: "rsc" }],
    },
  ],
};
