import { getProofImageSource } from "@/lib/proofs/data";
import { readStoredObject } from "@/lib/uploads/store";
import { checkRateLimit, clientIp } from "@/lib/proofs/rate-limit";
import sharp from "sharp";

// sharp needs the Node runtime (format sniffing); never cached at the edge
// (each response contains customer artwork behind a token).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves the FULL portrait for a proof token: no watermark, original bytes
 * (Yousif 2026-10-14). ?download=1 sends it as an attachment so the customer
 * can save it straight from the proof page.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;

  // Rate-limit by IP and by token to blunt brute-forcing / hotlink abuse.
  const ip = clientIp(req.headers);
  const [byIp, byToken] = await Promise.all([
    checkRateLimit(`proof-img:ip:${ip}`, 120, 60),
    checkRateLimit(`proof-img:tok:${token}`, 120, 60),
  ]);
  if (!byIp.ok || !byToken.ok) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(Math.max(byIp.retryAfter, byToken.retryAfter)) },
    });
  }

  // ?p=N picks one portrait of a 2+ portrait order (1-based, by item order);
  // anything that is not a small positive integer is ignored, never trusted.
  const pRaw = new URL(req.url).searchParams.get("p");
  const p = pRaw && /^\d{1,2}$/.test(pRaw) && Number(pRaw) >= 1 ? Number(pRaw) : undefined;
  const source = await getProofImageSource(token, p);
  if (!source) return new Response("Not found", { status: 404 });

  let original: Buffer;
  try {
    if (source.r2Key) {
      original = await readStoredObject(source.r2Key);
    } else {
      const upstream = await fetch(source.url!);
      if (!upstream.ok) return new Response("Not found", { status: 404 });
      original = Buffer.from(await upstream.arrayBuffer());
    }
  } catch {
    return new Response("Not found", { status: 404 });
  }

  let format = "jpeg";
  try {
    format = (await sharp(original).metadata()).format ?? "jpeg";
  } catch {
    // Not a decodable image: fail closed rather than serve arbitrary bytes.
    return new Response("Not found", { status: 404 });
  }
  const ext = format === "jpeg" ? "jpg" : format;
  const download = new URL(req.url).searchParams.get("download") === "1";
  const slug = source.businessName.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "Portrait";
  const suffix = p ? `-${p}` : "";
  const filename = `${slug}-${source.orderNumber.replace(/[^A-Za-z0-9-]/g, "")}${suffix}.${ext}`;

  return new Response(new Uint8Array(original), {
    status: 200,
    headers: {
      "Content-Type": `image/${format}`,
      // Private and uncacheable: no CDN/proxy should retain the image.
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
    },
  });
}
