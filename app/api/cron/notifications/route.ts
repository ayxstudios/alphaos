import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { runNotificationSweep } from "@/lib/notifications/sla-sweep";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Vercel Cron: fire SLA and pipeline-health notifications. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runNotificationSweep();
  return NextResponse.json(result);
}
