import NextAuth from "next-auth";
import { NextResponse } from "next/server";

import { authConfig } from "@/lib/auth/config";

const { auth } = NextAuth(authConfig);

// Routes inside the app shell that require a session.
const PROTECTED = [
  /^\/dashboard(\/|$)/,
  /^\/orders(\/|$)/,
  /^\/board(\/|$)/,
  /^\/queue(\/|$)/,
  /^\/qc(\/|$)/,
  /^\/customers(\/|$)/,
  /^\/settings(\/|$)/,
];

// The only areas a designer may reach. Per-order ownership on /orders/[id] is
// enforced by RLS in the page (a designer only sees their assigned orders).
const DESIGNER_ALLOWED = [/^\/board(\/|$)/, /^\/orders\/[^/]+/];

export default auth((req) => {
  const { pathname } = req.nextUrl;
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
  }

  return NextResponse.next();
});

export const config = {
  // Run on everything except API routes, Next internals, and static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
