import assert from "node:assert/strict";
import sharp from "sharp";

import {
  SAME_PICTURE_DISTANCE,
  SAME_PICTURE_INK_DIFF,
  aspectOf,
  dhashFromGray,
  hamming,
  imageHashOf,
  inkDifference,
  samePicture,
} from "../lib/qc/image-hash";

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

/** A watercolour-ish page: cream paper with grain and a soft vignette, and a brown figure placed by `seed`. */
async function onPaper(seed: number, w = 400, h = 500): Promise<Buffer> {
  const px = Buffer.alloc(w * h * 3);
  const cx = w * (0.3 + (0.4 * ((seed * 37) % 10)) / 10);
  const cy = h * (0.3 + (0.4 * ((seed * 53) % 10)) / 10);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const grain = (((x * 7919 + y * 104729) ^ (x * y)) % 13) - 6;
      let v = 238 - Math.hypot((x - w / 2) / w, (y - h / 2) / h) * 30 + grain;
      if (((x - cx) / 60) ** 2 + ((y - cy) / 90) ** 2 <= 1) v = 70;
      px[(y * w + x) * 3] = v;
      px[(y * w + x) * 3 + 1] = v * 0.93;
      px[(y * w + x) * 3 + 2] = v * 0.82;
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
  assert.ok(ha.fineSig && hr.fineSig && ho.fineSig);
  assert.ok(samePicture(ha, hr), "a resized copy is the same picture on both looks");
  assert.equal(samePicture(ha, ho), null);

  // Second look (16 Oct, designer Jerome's CPS watercolours): the same paper with a
  // different figure is a different picture even when the dHash calls it close.
  const pa = await imageHashOf(await onPaper(1));
  const pb = await imageHashOf(await onPaper(2));
  const pCopy = await imageHashOf(await sharp(await onPaper(1)).resize(200).jpeg({ quality: 70 }).toBuffer());
  assert.ok(pa && pb && pCopy);
  const inkOther = inkDifference(pa.fineSig, pb.fineSig);
  const inkCopy = inkDifference(pa.fineSig, pCopy.fineSig);
  assert.ok(inkOther !== null && inkOther > SAME_PICTURE_INK_DIFF, `same paper, other figure: ink ${inkOther}`);
  assert.ok(inkCopy !== null && inkCopy < 0.05, `copy: ink ${inkCopy}`);
  assert.equal(samePicture({ dhash: pa.dhash, fineSig: pa.fineSig }, { dhash: pa.dhash, fineSig: pb.fineSig }), null);
  assert.ok(samePicture(pa, pCopy));

  // Not an image: no hash, no throw.
  assert.equal(await imageHashOf(Buffer.from("%PDF-1.4 not an image")), null);

  assert.equal(aspectOf(1000, 1500), "portrait");
  assert.equal(aspectOf(1500, 1000), "landscape");
  assert.equal(aspectOf(1000, 1040), "square");
  assert.equal(aspectOf(null, 5), null);
  console.log(
    `test-image-hash ok (resized distance ${same}, different distance ${diff}; same paper: dHash ${hamming(pa.dhash, pb.dhash)} ink ${inkOther?.toFixed(3)}, copy ink ${inkCopy?.toFixed(3)})`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
