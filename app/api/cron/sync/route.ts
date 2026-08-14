import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { syncAllShops } from "@/lib/integrations/scheduler";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron: incrementally sync every onboarded shop (batch-and-resume, budget
 * bounded). See lib/integrations/scheduler.ts.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runId = await startJobRun({ jobName: JOB_NAMES.cronSync });
  try {
    const result = await syncAllShops({ trigger: "cron" });
    const failed = result.shops.filter((shop) => shop.outcome.startsWith("error:")).length;
    await finishJobRun(runId, {
      status: failed > 0 ? "partial" : "ok",
      itemsProcessed: result.processed,
      itemsFailed: failed,
      metadata: { ...result },
    });
    return NextResponse.json(result);
  } catch (error) {
    await failJobRun(runId, error);
    throw error;
  }
}
