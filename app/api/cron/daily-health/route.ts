import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { deliverDailyHealthReports } from "@/lib/health/delivery";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron is UTC-only. vercel.json calls this at both UTC hours that can be
 * 7am in Melbourne; the route itself checks Australia/Melbourne local time so
 * daylight saving does not shift the briefing.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runId = await startJobRun({ jobName: JOB_NAMES.cronDailyHealth });
  const force = req.nextUrl.searchParams.get("force") === "true";
  try {
    const result = await deliverDailyHealthReports({ force });
    await finishJobRun(runId, {
      status: result.failed > 0 ? "partial" : "ok",
      itemsProcessed: result.processed,
      itemsFailed: result.failed,
      metadata: { ...result, force },
    });
    return NextResponse.json(result);
  } catch (error) {
    await failJobRun(runId, error, { force });
    throw error;
  }
}
