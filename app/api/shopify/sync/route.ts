import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
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
  const summary = await syncShopOrders(shopId, { trigger: "manual" });
  return NextResponse.json(summary);
}
