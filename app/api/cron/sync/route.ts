import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { syncAllShops } from "@/lib/integrations/scheduler";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron: incrementally sync every onboarded shop (batch-and-resume, budget
 * bounded). See lib/integrations/scheduler.ts.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await syncAllShops();
  return NextResponse.json(result);
}
