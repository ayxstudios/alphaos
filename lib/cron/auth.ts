import type { NextRequest } from "next/server";

/**
 * Authorize a Vercel Cron request. Vercel automatically sends
 * `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set in the project.
 * We require it, so the endpoints can't be triggered by the public.
 */
export function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if unconfigured
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
