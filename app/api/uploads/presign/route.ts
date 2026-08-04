import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { shops } from "@/lib/db/schema";
import { assetKey, presignUpload, publicUrl, isR2Configured } from "@/lib/storage/r2";

export const runtime = "nodejs";

const MAX_FILES = 20;
const ALLOWED = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;

/**
 * Presign direct-to-R2 uploads for reference photos on the manual-order form.
 * VA/admin only. The client mints the orderId; the server derives businessId
 * from the shop (RLS-scoped) so keys are namespaced by a business the caller can
 * actually see. Returns one { key, uploadUrl, publicUrl } per requested file.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "admin" && role !== "va")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ error: "R2 storage is not configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as {
    shopId?: string;
    orderId?: string;
    files?: { filename?: string; contentType?: string }[];
  } | null;
  if (!body?.shopId || !body.orderId || !Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (body.files.length > MAX_FILES) {
    return NextResponse.json({ error: `max ${MAX_FILES} files` }, { status: 400 });
  }

  const user = { id: session.user.id, role };
  // Derive businessId from the shop (RLS scopes visibility to the caller).
  const [shop] = await withUserContext(user, (tx) =>
    tx.select({ businessId: shops.businessId }).from(shops).where(eq(shops.id, body.shopId!)),
  );
  if (!shop) return NextResponse.json({ error: "shop not found" }, { status: 404 });

  try {
    const uploads = await Promise.all(
      body.files.map(async (f) => {
        const contentType = String(f.contentType ?? "");
        if (!ALLOWED.test(contentType)) throw new Error(`unsupported type: ${contentType}`);
        const key = assetKey(shop.businessId, body.orderId!, String(f.filename ?? "photo"));
        return { key, uploadUrl: await presignUpload({ key, contentType }), publicUrl: publicUrl(key) };
      }),
    );
    return NextResponse.json({ uploads });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "presign failed" }, { status: 400 });
  }
}
