import { getProofImageSource } from "@/lib/proofs/data";
import { checkRateLimit, clientIp } from "@/lib/proofs/rate-limit";
import { watermarkImage } from "@/lib/proofs/watermark";

// sharp needs the Node runtime; the watermark is per-request and must never be
// cached at the edge (each response contains customer artwork behind a token).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves the WATERMARKED portrait for a proof token. The original file is
 * fetched server-side and never sent to the client — the only bytes that leave
 * this handler are the watermarked JPEG, so the clean image is unreachable from
 * the proof page.
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

  const source = await getProofImageSource(token);
  if (!source) return new Response("Not found", { status: 404 });

  const upstream = await fetch(source.url);
  if (!upstream.ok) return new Response("Not found", { status: 404 });
  const original = Buffer.from(await upstream.arrayBuffer());

  let watermarked: Buffer;
  try {
    watermarked = await watermarkImage(original, `Proof · ${source.businessName}`);
  } catch {
    // If the source isn't a decodable image, fail closed rather than leak it.
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(watermarked), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      // Private and uncacheable: no CDN/proxy should retain the proof image.
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Disposition": "inline",
    },
  });
}
