import type { EyeOrder } from "@/lib/eye/data";

/** Pure helpers for the All Seeing Eye: hashing, sectors, rings, health, wording. No DOM. */

export const STAGE_NAMES = ["INTAKE", "DRAWING", "QC", "WITH BUYER", "PRINTING", "DONE"] as const;

export type Health = "unhappy" | "amber" | "violet" | "ok" | "done";
export type EyeFilter = "delayed" | "unhappy" | "waiting" | "printing" | "done";

export const HEALTH_COLOR: Record<Health, string> = {
  unhappy: "#ff4d6d",
  amber: "#ffb347",
  violet: "#8b7cf6",
  ok: "#9fd8ff",
  done: "#7dc9a6",
};

const TAU = Math.PI * 2;

/** FNV-1a, folded to [0, 1). Same id + salt always gives the same number. */
export function hash01(s: string, salt = 0): number {
  let h = (0x811c9dc5 ^ (salt * 0x9e3779b1)) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** Colour priority: unhappy, done, delayed/urgent, waiting on buyer, on track. */
export function healthOf(o: EyeOrder): Health {
  if (o.sentiment === "unhappy") return "unhappy";
  if (o.stage.n >= 5) return "done";
  if (o.delayed || o.urgent) return "amber";
  if (o.waitingOnBuyer) return "violet";
  return "ok";
}

export function matchesFilter(o: EyeOrder, f: EyeFilter | null, startOfDayMs: number): boolean {
  switch (f) {
    case null:
      return true;
    case "delayed":
      return o.delayed && o.stage.n < 5;
    case "unhappy":
      return o.sentiment === "unhappy";
    case "waiting":
      return o.waitingOnBuyer && o.stage.n < 5;
    case "printing":
      return o.stage.n === 4;
    case "done":
      return o.stage.n === 5 && new Date(o.stageSince).getTime() >= startOfDayMs;
  }
}

export function sentimentWords(s: EyeOrder["sentiment"]): string {
  if (s === "happy") return "buyer sounds happy";
  if (s === "attention") return "buyer needs attention";
  if (s === "unhappy") return "buyer is unhappy";
  return "buyer is quiet";
}

export type Sectors = { s0: number[]; s1: number[] };

/**
 * Split the circle into one sector per business. Width follows the count with a
 * floor so a quiet shop is still visible. Starts just after 12 o'clock, leaving
 * a clear wedge there for the ring labels.
 */
export function computeSectors(counts: number[], gap = 0.035, minFrac = 0.06, topGap = 0.2): Sectors {
  const n = counts.length;
  const s0: number[] = [];
  const s1: number[] = [];
  if (n === 0) return { s0, s1 };
  const g = n > 1 ? gap : 0;
  const total = counts.reduce((a, c) => a + Math.max(c, 0), 0);
  const floor = Math.min(minFrac, 0.9 / n);
  const raw = counts.map((c) => Math.max(floor, total > 0 ? Math.max(c, 0) / total : 1 / n));
  const sum = raw.reduce((a, b) => a + b, 0);
  // A wider wedge is left clear at 12 o'clock for the ring labels.
  const tg = n > 0 ? topGap : 0;
  const avail = TAU - n * g - tg;
  let a = -Math.PI / 2 + g / 2 + tg / 2;
  for (let i = 0; i < n; i++) {
    const w = (raw[i] / sum) * avail;
    s0.push(a);
    s1.push(a + w);
    a += w + g;
  }
  return { s0, s1 };
}

/** Radii of the six stage rings, inner to outer. */
export function ringRadii(R: number, compact: boolean, out: Float64Array | number[] = new Float64Array(6)) {
  const inner = R * (compact ? 0.32 : 0.28);
  const outer = R * 0.97;
  for (let i = 0; i < 6; i++) out[i] = inner + ((outer - inner) * i) / 5;
  return out;
}

/** Radius for a fractional ring index (so a glide between rings is smooth). */
export function radiusAt(rr: ArrayLike<number>, ri: number): number {
  if (ri <= 0) return rr[0];
  if (ri >= 5) return rr[5];
  const i = Math.floor(ri);
  return rr[i] + (rr[i + 1] - rr[i]) * (ri - i);
}

export function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

/** Index of the nearest point within maxDist, or -1. */
export function nearestIndex(pts: { x: number; y: number }[], px: number, py: number, maxDist: number): number {
  let best = -1;
  let bd = maxDist * maxDist;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - px;
    const dy = pts[i].y - py;
    const d = dx * dx + dy * dy;
    if (d <= bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export function ageText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(1, max - 1)).trimEnd() + "…" : s;
}

/**
 * Golden-angle slot in [0.06, 0.94] for the rank-th of count nodes sharing a
 * ring arc: even coverage with no stacking, stable as count grows.
 */
export function slotFor(rank: number, count: number): number {
  if (count <= 1) return 0.5;
  return 0.06 + 0.88 * ((rank + 0.5) / count);
}

/** Radial stagger in [-1, 1] so neighbours on one ring alternate in depth. */
export function radialStagger(rank: number): number {
  return ((rank * 0.7548776662) % 1) * 2 - 1;
}

/** Glow scale for a ring arc: shrinks as spacing between neighbours tightens. */
export function densityScale(arcPx: number, count: number, nominalPx: number): number {
  if (count <= 1) return 1;
  const spacing = arcPx / count;
  return Math.max(0.5, Math.min(1, spacing / nominalPx));
}
