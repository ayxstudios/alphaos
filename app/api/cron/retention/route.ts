import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { closeApprovedDigital, retryBlockedFigureEarnings } from "@/lib/orders/auto-complete";
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
    // Approved all-digital orders the inline hook held (figure count unresolved at the
    // time) close here once the count can be inferred; a bounded batch keeps the run short.
    const digital = await closeApprovedDigital({ limit: 100 }).catch((e: unknown) => ({ error: String(e) }));
    // Complete orders whose earning waits on "Missing figure count.": retry the count, then resolve the earning.
    const blockedRetry = await retryBlockedFigureEarnings({ limit: 50 }).catch((e: unknown) => ({ error: String(e) }));
    await finishJobRun(runId, {
      status: summary.errors > 0 ? "partial" : "ok",
      itemsProcessed: summary.scanned,
      itemsFailed: summary.errors,
      metadata: { ...summary, digital, blockedRetry },
    });
    return NextResponse.json({ ...summary, digital, blockedRetry });
  } catch (error) {
    await failJobRun(runId, error);
    throw error;
  }
}
