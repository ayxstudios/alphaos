import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { pollAllMailboxes, pollMailbox } from "@/lib/integrations/gmail";

export const runtime = "nodejs";

/**
 * Manual trigger for the inbound reply poller (admin only). The same
 * `pollMailbox` / `pollAllMailboxes` functions are meant to run on a Trigger.dev
 * schedule later; this route lets an admin exercise them now. Pass ?businessId=
 * to poll a single mailbox.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const businessId = req.nextUrl.searchParams.get("businessId");
  const result = businessId ? [await pollMailbox(businessId)] : await pollAllMailboxes();
  return NextResponse.json({ result });
}
