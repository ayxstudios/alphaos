import { NextResponse, type NextRequest } from "next/server";

import { rejectUnlessAgent } from "@/lib/agent/ai-jobs-http";
import { withSystemContext } from "@/lib/db";
import { loadSameBuyerContext } from "@/lib/orders/same-buyer";
import { loadAssets } from "@/lib/qc/wrong-file";
import { presignGet } from "@/lib/storage/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SIGNED_URL_SECONDS = 600;

/**
 * The buyer's other orders and the newest artwork on each, so the Auto QC
 * judge can see whether the file under review is really another order's. Each
 * sibling: { orderNumber, productLine, stage, newestArtwork: { assetId, url
 * (signed, ten minutes), dhash, width, height } | null }. No buyer email,
 * surname or address. See docs/AUTO_QC.md, Wrong-file stop.
 */
export async function GET(req: NextRequest) {
  const denied = rejectUnlessAgent(req);
  if (denied) return denied;
  const orderId = req.nextUrl.searchParams.get("orderId") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return NextResponse.json({ error: "orderId must be an order uuid" }, { status: 400 });

  const found = await withSystemContext(async (tx) => {
    const ctx = await loadSameBuyerContext(tx, orderId, { artwork: true, staff: false });
    if (!ctx) return null;
    const siblings = ctx.others.filter((o) => o.id);
    const files = await loadAssets(tx, siblings.map((o) => o.artworkAssetId).filter((v): v is string => !!v));
    return { siblings, files: new Map(files.map((f) => [f.id, f])) };
  });
  if (!found) return NextResponse.json({ error: "order not found" }, { status: 404 });

  const items = await Promise.all(
    found.siblings.map(async (o) => {
      const f = o.artworkAssetId ? found.files.get(o.artworkAssetId) : undefined;
      let url: string | null = null;
      if (f) {
        try {
          url = f.storage === "r2" && f.r2Key ? await presignGet(f.r2Key, SIGNED_URL_SECONDS) : f.url;
        } catch {
          url = null;
        }
      }
      return {
        orderNumber: o.number,
        productLine: o.productLine,
        stage: o.stage,
        newestArtwork: f ? { assetId: f.id, url, dhash: f.dhash, width: f.width, height: f.height } : null,
      };
    }),
  );
  return NextResponse.json({ orderId, siblings: items });
}
