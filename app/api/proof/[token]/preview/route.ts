import { getProofImageSource, type ProofImageSource } from "@/lib/proofs/data";
import { headStored, isDevStoreKey, readStoredObject } from "@/lib/uploads/store";
import { presignGet } from "@/lib/storage/r2";
import { checkRateLimit, clientIp } from "@/lib/proofs/rate-limit";

// Node runtime (R2 signing, dev-store reads); never cached at the edge (each
// response points at customer artwork behind a token).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed link only has to outlive the page load or the Download tap. */
const SIGNED_URL_TTL_SECONDS = 15 * 60;
/** Vercel caps a function response at 4.5 MB; anything bigger is redirected, never proxied. */
const MAX_PROXY_BYTES = 4 * 1024 * 1024;

const NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  "X-Robots-Tag": "noindex, nofollow",
};

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** "PixArt-Creatives-4181492177-2.png": business, order, portrait number. */
function downloadName(source: ProofImageSource, p: number | undefined, contentType: string): string {
  const slug = source.businessName.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "Portrait";
  const order = source.orderNumber.replace(/[^A-Za-z0-9-]/g, "");
  const ext = EXT[contentType.toLowerCase()] ?? "jpg";
  return `${slug}${order ? `-${order}` : ""}${p ? `-${p}` : ""}.${ext}`;
}

function disposition(download: boolean, filename: string): string {
  return `${download ? "attachment" : "inline"}; filename="${filename}"`;
}

function isImage(contentType: string | null | undefined): contentType is string {
  return !!contentType && /^image\//i.test(contentType);
}

/**
 * The FULL portrait for a proof token: the designer's original file, no
 * watermark, no mockup (Yousif 2026-10-14). ?download=1 makes the browser save
 * it, so the customer can download it straight from the proof page.
 *
 * R2 files (every designer submission) are answered with a short-lived signed
 * link to the original object, so a portrait of any size loads at full
 * quality and nothing passes through the 4.5 MB function limit.
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
  const url = new URL(req.url);
  const pRaw = url.searchParams.get("p");
  const p = pRaw && /^\d{1,2}$/.test(pRaw) && Number(pRaw) >= 1 ? Number(pRaw) : undefined;
  const download = url.searchParams.get("download") === "1";
  const source = await getProofImageSource(token, p);
  if (!source) return new Response("Not found", { status: 404 });

  try {
    if (source.r2Key && !isDevStoreKey(source.r2Key)) {
      const head = await headStored(source.r2Key);
      // Not an image: fail closed rather than hand out arbitrary bytes.
      if (!isImage(head.contentType)) return new Response("Not found", { status: 404 });
      const signed = await presignGet(source.r2Key, SIGNED_URL_TTL_SECONDS, {
        contentType: head.contentType,
        contentDisposition: disposition(download, downloadName(source, p, head.contentType)),
        cacheControl: "private, no-store",
      });
      return new Response(null, { status: 302, headers: { Location: signed, ...NO_STORE } });
    }

    if (source.r2Key) {
      // Local dev store: no signing, serve the bytes.
      const [head, bytes] = await Promise.all([headStored(source.r2Key), readStoredObject(source.r2Key)]);
      if (!isImage(head.contentType)) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": head.contentType,
          "Content-Disposition": disposition(download, downloadName(source, p, head.contentType)),
          ...NO_STORE,
        },
      });
    }

    // CDN asset: view straight from its URL. A download is proxied so it
    // arrives as a named file, unless it is too big for a function response.
    const upstream = await fetch(source.url!);
    const contentType = upstream.headers.get("content-type")?.split(";")[0].trim() ?? null;
    if (!upstream.ok || !isImage(contentType)) return new Response("Not found", { status: 404 });
    const length = Number(upstream.headers.get("content-length") ?? NaN);
    if (!download || !(length <= MAX_PROXY_BYTES)) {
      void upstream.body?.cancel();
      return new Response(null, { status: 302, headers: { Location: source.url!, ...NO_STORE } });
    }
    return new Response(new Uint8Array(await upstream.arrayBuffer()), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": disposition(true, downloadName(source, p, contentType)),
        ...NO_STORE,
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
