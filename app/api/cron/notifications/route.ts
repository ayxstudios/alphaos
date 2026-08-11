import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { runNotificationSweep } from "@/lib/notifications/sla-sweep";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Vercel Cron: fire SLA and pipeline-health notifications. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const enabled = process.env.NOTIFICATIONS_ENABLED === "true";
  const result = await runNotificationSweep(new Date(), { dryRun: !enabled, enabled });
  if (!enabled) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        component: "notifications",
        event: "notifications_disabled",
        message: "NOTIFICATIONS_ENABLED is not true; sweep computed in dry-run mode only.",
        wouldFire: result.wouldFire,
        wouldCreateNotifications: result.wouldCreateNotifications,
      }),
    );
  }
  return NextResponse.json(result);
}
