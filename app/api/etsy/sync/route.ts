import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { isUuid } from "@/lib/utils";
import { syncShopReceipts } from "@/lib/integrations/etsy";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Manual/programmatic sync trigger (admin). syncShopReceipts runs as a system
 * job (withSystemContext, actor null); this handler only gates access.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const shopId = body?.shopId;
  if (!shopId || typeof shopId !== "string") {
    return NextResponse.json({ error: "missing shopId" }, { status: 400 });
  }
  // A malformed or unknown id is a calm 404, never a database error as a 500.
  if (!isUuid(shopId)) return NextResponse.json({ error: "shop not found" }, { status: 404 });

  let summary;
  try {
    summary = await syncShopReceipts(shopId, { trigger: "manual" });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Shop not found")) {
      return NextResponse.json({ error: "shop not found" }, { status: 404 });
    }
    throw error;
  }
  return NextResponse.json(summary);
}
