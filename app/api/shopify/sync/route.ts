import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { isUuid } from "@/lib/utils";
import { syncShopOrders } from "@/lib/integrations/shopify";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Manual/programmatic Shopify sync trigger (admin). */
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
    summary = await syncShopOrders(shopId, { trigger: "manual" });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Shop not found")) {
      return NextResponse.json({ error: "shop not found" }, { status: 404 });
    }
    throw error;
  }
  return NextResponse.json(summary);
}
