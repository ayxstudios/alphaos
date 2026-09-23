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
    const allowed = DESIGNER_ALLOWED.some((r) => r.test(pathname));
    if (!allowed) {
      return NextResponse.redirect(new URL("/board", req.nextUrl.origin));
    }
  } else if (session.user.role !== "admin" && ADMIN_ONLY.some((r) => r.test(pathname))) {
    return NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin));
  }

  return NextResponse.next();
});

export const config = {
  // Run on everything except API routes, Next internals, and static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
