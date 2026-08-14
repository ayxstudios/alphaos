import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { flushQueued } from "@/lib/email/dispatch";
import { pollMailboxesScheduled } from "@/lib/integrations/gmail";
import { failJobRun, finishJobRun, JOB_NAMES, startJobRun } from "@/lib/jobs/ledger";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron: poll every connected Gmail mailbox for new replies, least-recently
 * polled first, budget-bounded (batch-and-resume). Same 15-minute cadence and
 * CRON_SECRET auth as the shop sync.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runId = await startJobRun({ jobName: JOB_NAMES.cronGmailPoll });
  try {
    const [poll, queuedFlush] = await Promise.all([pollMailboxesScheduled(), flushQueued()]);
    const pollFailures = poll.mailboxes.filter((mailbox) => mailbox.skippedRun === "error").length;
    const itemsFailed = pollFailures + queuedFlush.failed;
    await finishJobRun(runId, {
      status: itemsFailed > 0 ? "partial" : "ok",
      itemsProcessed: poll.processed,
      itemsFailed,
      metadata: { poll, queuedFlush },
    });
    return NextResponse.json({ poll, queuedFlush });
  } catch (error) {
    await failJobRun(runId, error);
    throw error;
  }
}
