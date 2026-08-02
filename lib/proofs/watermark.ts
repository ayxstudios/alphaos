import sharp from "sharp";

const MAX_WIDTH = 1400; // plenty for on-screen review; keeps payloads small

/** XML-escape untrusted text before embedding it in the watermark SVG. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A tiled, diagonal watermark sized to the image. Text is drawn with a light
 * fill and a faint dark outline so it stays legible over both light and dark
 * artwork. Repeated across the whole surface so no crop escapes it.
 */
function watermarkSvg(width: number, height: number, label: string): string {
  const text = escapeXml(label.slice(0, 40).toUpperCase());
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="wm" width="420" height="240" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      <text x="10" y="120" font-family="Arial, sans-serif" font-size="30" font-weight="700"
            fill="rgba(255,255,255,0.55)" stroke="rgba(22,34,46,0.22)" stroke-width="0.8"
            letter-spacing="4">${text}</text>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#wm)"/>
</svg>`;
}

/**
 * Produce a watermarked JPEG from the original image bytes. The unwatermarked
 * input never leaves this function — callers stream only the returned buffer, so
 * the clean file is never reachable from the proof page.
 */
export async function watermarkImage(
  input: Buffer,
  label: string,
): Promise<Buffer> {
  // rotate() first so EXIF orientation is baked in before we measure.
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  const svg = watermarkSvg(info.width, info.height, label);

  return sharp(data)
    .composite([{ input: Buffer.from(svg), gravity: "center" }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}
