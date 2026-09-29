import { NextResponse, type NextRequest } from "next/server";

import { runAgentTick } from "@/lib/agent/autopilot";
import { isAuthorizedCron } from "@/lib/cron/auth";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Agent autopilot tick (docs/AGENT_FIRST.md): intake, photo completeness and
 * designer assignment for every business with an agent switch on. `?dryRun=1`
 * computes and reports without writing anything.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const runId = await startJobRun({ jobName: JOB_NAMES.cronAgent, metadata: { dryRun } });
  try {
    const report = await runAgentTick({ dryRun });
    const failed = report.businesses.reduce((n, b) => n + b.errors.length, 0);
    const processed = report.businesses.reduce((n, b) => n + b.intakeChecked + b.completenessChecked + b.assignChecked, 0);
    await finishJobRun(runId, {
      status: failed > 0 ? "partial" : "ok",
      itemsProcessed: processed,
      itemsFailed: failed,
      metadata: { ...report },
    });
    return NextResponse.json(report);
  } catch (error) {
    await failJobRun(runId, error);
    throw error;
  }
}
