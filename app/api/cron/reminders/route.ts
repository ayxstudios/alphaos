import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";
import { releaseDueDeliveryHolds } from "@/lib/orders/deliver-together-db";
import { runRemindersSweep } from "@/lib/reminders/sweep";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * NOT in vercel.json crons — the daemon calls this directly (CRON_SECRET,
 * same bearer-auth contract as every other cron route). 48h photo reminder,
 * 3-day proof reminder, day-5 customer.silent Alpha event, day-7 silence
 * auto-approve on physical orders. See lib/reminders/sweep.ts. First, proofs
 * held to go with the buyer's other order go out once their time is up or
 * nothing they wait on still counts (lib/orders/deliver-together-db.ts).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runId = await startJobRun({ jobName: JOB_NAMES.cronReminders });
  try {
    // Never late: held proofs first, on a budget, and a failure here never stops the reminders.
    const started = Date.now();
    const deliveryHolds = await releaseDueDeliveryHolds({ outOfTime: () => Date.now() - started > 20_000 }).catch(
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
    const result = await runRemindersSweep();
    const itemsProcessed =
      result.photoReminders.candidates +
      result.proofReminders.candidates +
      result.customerSilentAlerts.candidates +
      result.autoApprovals.candidates;
    await finishJobRun(runId, {
      status: result.autoApprovals.failed > 0 ? "partial" : "ok",
      itemsProcessed,
      itemsFailed: result.autoApprovals.failed,
      metadata: { ...result, deliveryHolds },
    });
    return NextResponse.json({ ...result, deliveryHolds });
  } catch (error) {
    await failJobRun(runId, error);
    throw error;
  }
}
