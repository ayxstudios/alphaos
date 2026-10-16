import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getEyeData } from "@/lib/eye/data";

export const dynamic = "force-dynamic";

/** The All Seeing Eye feed: owner only, read only, never cached. */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const data = await getEyeData({ id: session.user.id, role: session.user.role });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "db_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
