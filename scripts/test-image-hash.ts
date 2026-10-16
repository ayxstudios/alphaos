import assert from "node:assert/strict";
import sharp from "sharp";

import { SAME_PICTURE_DISTANCE, aspectOf, dhashFromGray, hamming, imageHashOf } from "../lib/qc/image-hash";

/** A 400x300 picture of horizontal bars so every row has structure; `seed` changes the bars. */
async function picture(seed: number, w = 400, h = 300): Promise<Buffer> {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.floor((Math.sin((x * (seed + 2)) / 37) + Math.cos((y * (seed * 3 + 1)) / 23) + 2) * 63) & 255;
      px[(y * w + x) * 3] = v;
      px[(y * w + x) * 3 + 1] = (v * 7 + seed * 40) & 255;
      px[(y * w + x) * 3 + 2] = 255 - v;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function main() {
  assert.equal(dhashFromGray(new Array(72).fill(5)), "0000000000000000");
  assert.equal(hamming("0000000000000000", "ffffffffffffffff"), 64);
  assert.equal(hamming("0000000000000000", "0000000000000001"), 1);
  assert.equal(hamming(null, "0000000000000000"), Infinity);
  assert.equal(hamming("zz", "0000000000000000"), Infinity);

  const a = await picture(1);
  const resized = await sharp(a).resize(160, 120).jpeg({ quality: 70 }).toBuffer();
  const other = await picture(5);
  const ha = await imageHashOf(a);
  const hr = await imageHashOf(resized);
  const ho = await imageHashOf(other);
  assert.ok(ha && hr && ho);
  assert.deepEqual([ha.width, ha.height], [400, 300]);
  assert.deepEqual([hr.width, hr.height], [160, 120]);
  const same = hamming(ha.dhash, hr.dhash);
  const diff = hamming(ha.dhash, ho.dhash);
  assert.ok(same <= SAME_PICTURE_DISTANCE, `resized copy distance ${same}`);
  assert.ok(diff > SAME_PICTURE_DISTANCE, `different picture distance ${diff}`);

  // Not an image: no hash, no throw.
  assert.equal(await imageHashOf(Buffer.from("%PDF-1.4 not an image")), null);

  assert.equal(aspectOf(1000, 1500), "portrait");
  assert.equal(aspectOf(1500, 1000), "landscape");
  assert.equal(aspectOf(1000, 1040), "square");
  assert.equal(aspectOf(null, 5), null);
  console.log(`test-image-hash ok (resized distance ${same}, different distance ${diff})`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
