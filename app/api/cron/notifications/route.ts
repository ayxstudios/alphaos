import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { runNotificationSweep } from "@/lib/notifications/sla-sweep";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Vercel Cron: fire SLA and pipeline-health notifications. */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runId = await startJobRun({ jobName: JOB_NAMES.cronNotifications });
  const enabled = process.env.NOTIFICATIONS_ENABLED === "true";
  try {
    const result = await runNotificationSweep(new Date(), { dryRun: !enabled, enabled });
    await finishJobRun(runId, {
      status: "ok",
      itemsProcessed: result.candidates,
      itemsFailed: 0,
      metadata: { ...result, notificationsEnabled: enabled },
    });
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
  } catch (error) {
    await failJobRun(runId, error, { notificationsEnabled: enabled });
    throw error;
  }
}
