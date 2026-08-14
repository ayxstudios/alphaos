import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { sweepExpiredAssets } from "@/lib/storage/retention";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron: 180-day asset retention sweep (batch-and-resume). See
 * lib/storage/retention.ts. A backlog drains over successive nightly runs.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runId = await startJobRun({ jobName: JOB_NAMES.cronRetention });
  try {
    const summary = await sweepExpiredAssets();
    await finishJobRun(runId, {
      status: summary.errors > 0 ? "partial" : "ok",
      itemsProcessed: summary.scanned,
      itemsFailed: summary.errors,
      metadata: { ...summary },
    });
    return NextResponse.json(summary);
  } catch (error) {
    await failJobRun(runId, error);
    throw error;
  }
}
