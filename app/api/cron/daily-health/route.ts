import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { deliverDailyHealthReports } from "@/lib/health/delivery";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron is UTC-only. vercel.json calls this at both UTC hours that can be
 * 7am in Melbourne; the route itself checks Australia/Melbourne local time so
 * daylight saving does not shift the briefing.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const force = req.nextUrl.searchParams.get("force") === "true";
  const result = await deliverDailyHealthReports({ force });
  return NextResponse.json(result);
}
