/**
 * Display-size variants of customer and product photos (docs/PERF.md).
 *
 * Shopify's CDN resizes on request: `?width=480` turns a 2.2 MB phone photo
 * into ~70 KB. Thumbnails ask for about twice their CSS width (sharp on a
 * 2x screen); full-size views keep the original URL. Anything else (R2
 * presigned URLs, which must not be altered, or other hosts) is returned
 * unchanged. Pure, safe on server and client.
 */
export function sizedImageUrl(url: string, width: number): string {
  if (url.includes("picsum.photos")) {
    // Mock seed images: /900/900 is the original; keep a real picsum size.
    return width <= 400 ? url.replace(/\/900\/900$/, "/400/400") : url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname !== "cdn.shopify.com") return url;
  parsed.searchParams.set("width", String(Math.round(width)));
  return parsed.toString();
}
