import { NextResponse, type NextRequest } from "next/server";

import { isAuthorizedCron } from "@/lib/cron/auth";
import { pollMailboxesScheduled } from "@/lib/integrations/gmail";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron: poll every connected Gmail mailbox for new replies, least-recently
 * polled first, budget-bounded (batch-and-resume). Same 15-minute cadence and
 * CRON_SECRET auth as the shop sync.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await pollMailboxesScheduled();
  return NextResponse.json(result);
}
