import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { sweepExpiredAssets } from "@/lib/storage/retention";

export const runtime = "nodejs";

/**
 * Manual trigger for the 180-day asset retention sweep (admin only). The same
 * sweepExpiredAssets() is meant to run on a nightly schedule later.
 */
export async function POST() {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const summary = await sweepExpiredAssets();
  return NextResponse.json({ summary });
}
