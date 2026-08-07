import type { NextRequest } from "next/server";

/**
 * Authorize a Vercel Cron request. Vercel automatically sends
 * `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set in the project.
 * We require it, so the endpoints can't be triggered by the public.
 */
export function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        component: "cron",
        event: "cron_secret_unset",
        path: req.nextUrl.pathname,
      }),
    );
    return false; // fail closed if unconfigured
  }

  const authorized = req.headers.get("authorization") === `Bearer ${secret}`;
  if (!authorized) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        component: "cron",
        event: "cron_unauthorized",
        path: req.nextUrl.pathname,
        hasAuthorization: !!req.headers.get("authorization"),
      }),
    );
  }
  return authorized;
}
