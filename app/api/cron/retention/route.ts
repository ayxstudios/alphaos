import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { sweepExpiredAssets } from "@/lib/storage/retention";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron: 180-day asset retention sweep (batch-and-resume). See
 * lib/storage/retention.ts. A backlog drains over successive nightly runs.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const summary = await sweepExpiredAssets();
  return NextResponse.json(summary);
}
