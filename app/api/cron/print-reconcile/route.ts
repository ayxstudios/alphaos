import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";
import { reconcileAllBusinesses } from "@/lib/print/reconcile";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Print reconciliation sweep. NOT wired into vercel.json - the daemon calls
 * this on its own schedule (Authorization: Bearer $CRON_SECRET), same
 * contract as every other cron route here (lib/cron/auth.ts).
 *
 * For every business: orders in `printing`, and `approved` physical orders
 * over 24h old with no print job at all, get checked against their print
 * provider(s). See lib/print/reconcile.ts for the full state machine.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const runId = await startJobRun({ jobName: JOB_NAMES.cronPrintReconcile });
  try {
    const summaries = await reconcileAllBusinesses("cron");
    const checked = summaries.reduce((n, s) => n + s.checked, 0);
    const errors = summaries.reduce((n, s) => n + s.errors.length, 0);
    await finishJobRun(runId, {
      status: errors > 0 ? "partial" : "ok",
      itemsProcessed: checked,
      itemsFailed: errors,
      metadata: { summaries },
    });
    return NextResponse.json({ checked, errors, summaries });
  } catch (error) {
    await failJobRun(runId, error);
    throw error;
  }
}
