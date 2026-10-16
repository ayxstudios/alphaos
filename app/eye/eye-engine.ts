import type { EyeData, EyeOrder } from "@/lib/eye/data";

import {
  STAGE_NAMES,
  HEALTH_COLOR,
  computeSectors,
  easeInOut,
  hash01,
  healthOf,
  matchesFilter,
  radialStagger,
  radiusAt,
  ringRadii,
  slotFor,
  densityScale,
  truncate,
  type EyeFilter,
  type Health,
} from "./eye-math";

/**
 * Canvas 2D renderer for the All Seeing Eye. One rAF loop, static layers cached
 * offscreen, per-frame work is plain loops over preallocated node records.
 */

const TAU = Math.PI * 2;
const BG = "#05070f";
const GLIDE_MS = 1200;
const FADE_MS = 700;
const MAX_RIPPLES = 24;
const HEALTHS: Health[] = ["unhappy", "amber", "violet", "ok", "done"];

type Node = {
  id: string;
  o: EyeOrder;
  bi: number;
  u: number;
  uT: number;
  jr: number;
  jrT: number;
  gc: number;
  ph: number;
  ri: number;
  riFrom: number;
  riTo: number;
  t0: number;
  dur: number;
  born: number;
  dying: number;
  h: number;
  hPrev: number;
  hT: number;
  fm: number;
  match: boolean;
  x: number;
  y: number;
  a: number;
  dens: number;
};

export type LayoutInfo = { cx: number; cy: number; R: number; coreR: number; compact: boolean };
export type ResizeOpts = { top: number; bottom: number; reserveRight: number; compact: boolean };

export type EngineOpts = {
  canvas: HTMLCanvasElement;
  onHover: (o: EyeOrder | null, x: number, y: number) => void;
  onSelect: (id: string | null) => void;
  onLayout: (l: LayoutInfo) => void;
};

function makeSprite(color: string, px: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d")!;
  const m = px / 2;
  const grad = g.createRadialGradient(m, m, 0, m, m, m);
  const r = parseInt(color.slice(1, 3), 16);
  const gr = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  grad.addColorStop(0, `rgba(${(r + 255) >> 1},${(gr + 255) >> 1},${(b + 255) >> 1},1)`);
  grad.addColorStop(0.14, `rgba(${r},${gr},${b},0.95)`);
  grad.addColorStop(0.38, `rgba(${r},${gr},${b},0.28)`);
  grad.addColorStop(1, `rgba(${r},${gr},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  return c;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createEngine(opts: EngineOpts) {
  const { canvas } = opts;
  const ctx = canvas.getContext("2d")!;
  const mkLayer = () => {
    const c = document.createElement("canvas");
    c.setAttribute("aria-hidden", "true");
    c.style.cssText = "position:absolute;left:0;top:0;pointer-events:none";
    canvas.parentElement?.insertBefore(c, canvas);
    return c;
  };
  const starEl = mkLayer();
  const staticEl = mkLayer();
  const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sprites = HEALTHS.map((h) => makeSprite(HEALTH_COLOR[h], 64));
  const coreSprite = makeSprite("#9fd8ff", 128);

  let dpr = 1;
  let W = 0;
  let H = 0;
  let compact = false;
  let cx = 0;
  let cy = 0;
  let R = 0;
  let coreR = 0;
  const rr = new Float64Array(6);
  let fontFamily = "Inter, system-ui, sans-serif";


  let nodes: Node[] = [];
  const byId = new Map<string, Node>();
  let bizIds: string[] = [];
  let bizName: string[] = [];
  let bizOpen: number[] = [];
  const lblHalf = [0, 0, 0, 0, 0, 0];
  let bizLabel: string[][] = [];
  let bizLabelW: number[] = [];
  const bizIndex = new Map<string, number>();
  let tgt0 = new Float64Array(0);
  let tgt1 = new Float64Array(0);
  let cur0 = new Float64Array(0);
  let cur1 = new Float64Array(0);
  let hubX = new Float64Array(0);
  let hubY = new Float64Array(0);

  let filter: EyeFilter | null = null;
  let selectedId: string | null = null;
  let hover: Node | null = null;
  let startOfDay = 0;
  let layoutOpts: ResizeOpts = { top: 64, bottom: 36, reserveRight: 0, compact: false };

  const ripNode: (Node | null)[] = new Array(MAX_RIPPLES).fill(null);
  const ripT = new Float64Array(MAX_RIPPLES);
  let ripNext = 0;

  let raf = 0;
  let running = false;
  let lastT = 0;
  let destroyed = false;

  /* ---------- layout ---------- */

  function layout(opt: ResizeOpts) {
    layoutOpts = opt;
    compact = opt.compact;
    const margin = compact ? 34 : 70;
    const availW = W - opt.reserveRight;
    const availH = H - opt.top - opt.bottom;
    // Centred in the viewport with a slight left lean on wide screens (the detail panel overlays on the right).
    cx = availW / 2 - (compact ? 0 : availW * 0.03);
    R = Math.max(60, Math.min(Math.min(cx, availW - cx) - margin, availH / 2 - margin));
    cy = compact ? Math.max(opt.top + margin + R - 6, opt.top + availH * 0.4) : opt.top + availH / 2;
    ringRadii(R, compact, rr);
    coreR = rr[0] * 0.8;
    buildStars();
    buildStatic();
    measureLabels();
    opts.onLayout({ cx, cy, R, coreR, compact });
  }

  /** Two copies side by side; CSS slides it one width left forever (no JS per frame). */
  function buildStars() {
    const c = starEl;
    c.width = Math.max(1, W * 2);
    c.height = Math.max(1, H);
    c.style.width = `${W * 2}px`;
    c.style.height = `${H}px`;
    c.style.animation = calm ? "none" : `eyedrift 420s linear infinite`;
    c.style.setProperty("--eye-w", `${-W}px`);
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    const rnd = mulberry(7);
    const n = Math.round((W * H) / 5200);
    for (let i = 0; i < n; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const s = rnd() < 0.1 ? 1.3 : 0.8;
      g.globalAlpha = 0.05 + rnd() * 0.22;
      g.fillStyle = rnd() < 0.2 ? "#b9c8ff" : "#e8efff";
      g.fillRect(x, y, s, s);
      g.fillRect(x + W, y, s, s);
    }
  }

  function ringLabel(g: CanvasRenderingContext2D, text: string, radius: number, centre: number, size: number) {
    g.font = `500 ${size}px ${fontFamily}`;
    const gapPx = size * 0.28;
    const widths: number[] = [];
    let total = 0;
    for (let i = 0; i < text.length; i++) {
      const w = g.measureText(text[i]).width + gapPx;
      widths.push(w);
      total += w;
    }
    let a = centre - total / radius / 2;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    for (let i = 0; i < text.length; i++) {
      const step = widths[i] / radius;
      const ang = a + step / 2;
      g.save();
      g.translate(cx + Math.cos(ang) * radius, cy + Math.sin(ang) * radius);
      g.rotate(ang + Math.PI / 2);
      g.lineWidth = 3;
      g.strokeStyle = BG;
      g.strokeText(text[i], 0, 0);
      g.fillStyle = "rgba(170,195,240,0.55)";
      g.fillText(text[i], 0, 0);
      g.restore();
      a += step;
    }
  }

  function buildStatic() {
    const c = staticEl;
    c.width = Math.max(1, Math.round(W * dpr));
    c.height = Math.max(1, Math.round(H * dpr));
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const v = g.createRadialGradient(cx, cy, coreR * 0.5, cx, cy, R * 1.35);
    v.addColorStop(0, "rgba(44,80,160,0.16)");
    v.addColorStop(0.55, "rgba(30,50,110,0.07)");
    v.addColorStop(1, "rgba(5,7,15,0)");
    g.fillStyle = v;
    g.fillRect(0, 0, W, H);
    // outer tick ring
    g.strokeStyle = "rgba(140,175,255,0.10)";
    g.lineWidth = 1;
    const tr = rr[5] + (compact ? 6 : 9);
    const ticks = compact ? 90 : 144;
    g.beginPath();
    for (let i = 0; i < ticks; i++) {
      const a = (i / ticks) * TAU;
      const l = i % 6 === 0 ? 5 : 2.5;
      g.moveTo(cx + Math.cos(a) * tr, cy + Math.sin(a) * tr);
      g.lineTo(cx + Math.cos(a) * (tr + l), cy + Math.sin(a) * (tr + l));
    }
    g.stroke();
    // stage rings
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.arc(cx, cy, rr[i], 0, TAU);
      g.strokeStyle = i === 5 ? "rgba(125,201,166,0.16)" : "rgba(130,170,255,0.15)";
      g.lineWidth = 1;
      g.stroke();
    }
    const size = compact ? 7.5 : 9.5;
    g.font = `500 ${size}px ${fontFamily}`;
    for (let i = 0; i < 6; i++) {
      const tw = g.measureText(STAGE_NAMES[i]).width + STAGE_NAMES[i].length * size * 0.28;
      lblHalf[i] = tw / 2 + 7;
      ringLabel(g, STAGE_NAMES[i], rr[i] + 2.5, -Math.PI / 2, size);
    }
  }

  /** Half-width in px of the label wedge at a (fractional) ring index. */
  function labelHalf(ri: number): number {
    const i = Math.max(0, Math.min(5, Math.round(ri)));
    return Math.abs(ri - i) < 0.6 ? lblHalf[i] : 0;
  }

  function measureLabels() {
    ctx.font = `600 ${compact ? 9 : 11}px ${fontFamily}`;
    const track = compact ? 1.2 : 1.8;
    bizLabelW = bizLabel.map((lines) => Math.max(...lines.map((s) => ctx.measureText(s).width + s.length * track)));
  }

  /* ---------- data ---------- */

  function setBusinessLabels() {
    // Phone: split a long shop name over two lines instead of clipping it.
    const max = compact ? 12 : 24;
    bizLabel = bizName.map((n) => {
      const up = n.toUpperCase().trim();
      const words = up.split(/\s+/);
      if (!compact || up.length <= max || words.length < 2) return [truncate(up, compact ? 14 : max)];
      let best = 1;
      let gap = Infinity;
      for (let k = 1; k < words.length; k++) {
        const d = Math.abs(words.slice(0, k).join(" ").length - words.slice(k).join(" ").length);
        if (d < gap) {
          gap = d;
          best = k;
        }
      }
      return [truncate(words.slice(0, best).join(" "), 14), truncate(words.slice(best).join(" "), 14)];
    });
  }

  function recomputeMatch() {
    for (let i = 0; i < nodes.length; i++) nodes[i].match = matchesFilter(nodes[i].o, filter, startOfDay);
  }

  function spawnRipple(n: Node, now: number) {
    ripNode[ripNext] = n;
    ripT[ripNext] = now;
    ripNext = (ripNext + 1) % MAX_RIPPLES;
  }

  function setData(d: EyeData, initial: boolean) {
    const now = performance.now();
    const sod = new Date();
    sod.setHours(0, 0, 0, 0);
    startOfDay = sod.getTime();

    const prevSig = bizIds.join("|");
    bizIds = d.businesses.map((b) => b.id);
    bizName = d.businesses.map((b) => b.name);
    bizOpen = d.businesses.map((b) => b.openCount);
    bizIndex.clear();
    bizIds.forEach((id, i) => bizIndex.set(id, i));
    setBusinessLabels();

    const counts = bizIds.map(() => 0);
    for (const o of d.orders) {
      const i = bizIndex.get(o.businessId);
      if (i !== undefined) counts[i]++;
    }
    const sec = computeSectors(counts);
    tgt0 = Float64Array.from(sec.s0);
    tgt1 = Float64Array.from(sec.s1);
    if (cur0.length !== tgt0.length || prevSig !== bizIds.join("|")) {
      cur0 = Float64Array.from(tgt0);
      cur1 = Float64Array.from(tgt1);
      hubX = new Float64Array(tgt0.length);
      hubY = new Float64Array(tgt0.length);
    }
    measureLabels();

    const seen = new Set<string>();
    const added: Node[] = [];
    for (const o of d.orders) {
      seen.add(o.id);
      const bi = bizIndex.get(o.businessId) ?? 0;
      const stage = o.stage.n;
      const h = HEALTHS.indexOf(healthOf(o));
      let n = byId.get(o.id);
      if (!n) {
        n = {
          id: o.id,
          o,
          bi,
          u: 0.1 + 0.8 * hash01(o.id, 1),
          uT: 0.5,
          jr: hash01(o.id, 2) * 2 - 1,
          jrT: 0,
          gc: 1,
          ph: hash01(o.id, 3) * TAU,
          ri: stage,
          riFrom: stage,
          riTo: stage,
          t0: 0,
          dur: 0,
          born: now,
          dying: 0,
          h,
          hPrev: h,
          hT: 0,
          fm: 1,
          match: true,
          x: cx,
          y: cy,
          a: 0,
          dens: 1,
        };
        if (initial) {
          n.born = now + hash01(o.id, 4) * 1300;
        } else {
          n.ri = 0;
          n.riFrom = 0;
          if (stage > 0) {
            n.t0 = now + 900;
            n.dur = GLIDE_MS;
          }
          spawnRipple(n, now);
        }
        byId.set(o.id, n);
        added.push(n);
      } else {
        n.o = o;
        n.bi = bi;
        n.dying = 0;
        if (n.riTo !== stage) {
          n.riFrom = n.ri;
          n.riTo = stage;
          n.t0 = now;
          n.dur = calm ? 1 : GLIDE_MS;
        }
        if (n.h !== h) {
          n.hPrev = n.h;
          n.h = h;
          n.hT = now;
        }
      }
    }
    for (const n of nodes) {
      if (!seen.has(n.id) && !n.dying) n.dying = now;
    }
    const kept: Node[] = [];
    for (const n of nodes) {
      if (n.dying && now - n.dying > 900) byId.delete(n.id);
      else kept.push(n);
    }
    nodes = kept.concat(added);
    spreadNodes(added);
    if (hover && !byId.has(hover.id)) hover = null;
    recomputeMatch();
  }

  /**
   * Spread the nodes sharing one ring arc evenly (a stable order by id, so a node
   * keeps its place as others come and go) and stagger them in depth.
   */
  function spreadNodes(fresh: Node[]) {
    const groups = new Map<string, Node[]>();
    for (const n of nodes) {
      if (n.dying) continue;
      const k = `${n.bi}:${n.riTo}`;
      const l = groups.get(k);
      if (l) l.push(n);
      else groups.set(k, [n]);
    }
    const isFresh = new Set(fresh);
    groups.forEach((list) => {
      list.sort((a, b) => hash01(a.id, 9) - hash01(b.id, 9));
      list.forEach((n, rank) => {
        n.uT = slotFor(rank, list.length);
        n.jrT = radialStagger(rank);
        n.gc = list.length;
        if (isFresh.has(n)) {
          n.u = n.uT;
          n.jr = n.jrT;
        }
      });
    });
  }

  /* ---------- frame ---------- */

  function frame(t: number) {
    raf = 0;
    if (!running || destroyed) return;
    const dt = Math.min(0.1, (t - lastT) / 1000 || 0.016);
    lastT = t;
    draw(t, dt);
    raf = requestAnimationFrame(frame);
  }

  function draw(now: number, dt: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);

    // ease sectors toward their targets
    const k = 1 - Math.exp(-dt * 4);
    const nb = cur0.length;
    for (let i = 0; i < nb; i++) {
      cur0[i] += (tgt0[i] - cur0[i]) * k;
      cur1[i] += (tgt1[i] - cur1[i]) * k;
      const mid = (cur0[i] + cur1[i]) / 2;
      hubX[i] = cx + Math.cos(mid) * coreR;
      hubY[i] = cy + Math.sin(mid) * coreR;
    }

    const focus = hover ?? (selectedId ? byId.get(selectedId) ?? null : null);

    // active ring segment
    if (focus && focus.bi < nb) {
      ctx.beginPath();
      ctx.arc(cx, cy, rr[focus.o.stage.n], cur0[focus.bi], cur1[focus.bi]);
      ctx.strokeStyle = "rgba(159,216,255,0.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // spokes
    if (nb > 1) {
      ctx.strokeStyle = "rgba(140,175,255,0.13)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < nb; i++) {
        const prev = i === 0 ? cur1[nb - 1] - TAU : cur1[i - 1];
        const a = (prev + cur0[i]) / 2;
        ctx.moveTo(cx + Math.cos(a) * coreR, cy + Math.sin(a) * coreR);
        ctx.lineTo(cx + Math.cos(a) * (rr[5] + 12), cy + Math.sin(a) * (rr[5] + 12));
      }
      ctx.stroke();
    }

    // shop names
    ctx.font = `600 ${compact ? 9 : 11}px ${fontFamily}`;
    ctx.textBaseline = "middle";
    const lr = rr[5] + (compact ? 16 : 26);
    const sub = compact ? 9 : 11;
    for (let i = 0; i < nb; i++) {
      const a = (cur0[i] + cur1[i]) / 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let x = cx + ca * lr;
      const y = cy + sa * lr;
      const w = bizLabelW[i] ?? 60;
      let al: CanvasTextAlign = "center";
      if (ca > 0.35) al = "left";
      else if (ca < -0.35) al = "right";
      let left = al === "left" ? x : al === "right" ? x - w : x - w / 2;
      if (left < 6) left = 6;
      if (left + w > W - 6) left = W - 6 - w;
      x = left;
      ctx.textAlign = "left";
      ctx.lineWidth = 3;
      ctx.strokeStyle = BG;
      ctx.lineJoin = "round";
      const lines = bizLabel[i];
      for (let k = 0; k < lines.length; k++) {
        const ly = y + k * (sub + 1) - ((lines.length - 1) * (sub + 1)) / 2;
        ctx.strokeText(lines[k], x, ly);
        ctx.fillStyle = "rgba(205,225,255,0.82)";
        ctx.fillText(lines[k], x, ly);
      }
      const oy = y + ((lines.length - 1) * (sub + 1)) / 2 + sub + 1;
      ctx.font = `500 ${sub - 1}px ${fontFamily}`;
      ctx.strokeText(`${bizOpen[i]} open`, x, oy);
      ctx.fillStyle = "rgba(150,175,220,0.55)";
      ctx.fillText(`${bizOpen[i]} open`, x, oy);
      ctx.font = `600 ${compact ? 9 : 11}px ${fontFamily}`;
    }

    // core
    ctx.globalCompositeOperation = "lighter";
    const breathe = calm ? 1 : 1 + 0.06 * Math.sin(now * 0.0016);
    const cs = coreR * 3.6 * breathe;
    ctx.globalAlpha = 0.55;
    ctx.drawImage(coreSprite, cx - cs / 2, cy - cs / 2, cs, cs);
    // sweep
    if (!calm) {
      const sw = (now * 0.00018) % TAU;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, rr[5] + 1, sw, sw + 0.7);
      ctx.strokeStyle = "rgba(159,216,255,0.28)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, rr[2], sw * -1.4, sw * -1.4 + 0.45);
      ctx.strokeStyle = "rgba(139,124,246,0.16)";
      ctx.stroke();
    }

    // hubs
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < nb; i++) {
      ctx.drawImage(sprites[3], hubX[i] - 7, hubY[i] - 7, 14, 14);
    }

    // positions
    const nodeR = compact ? 2.4 : 3.2;
    const jit = (rr[1] - rr[0]) * 0.3;
    const len = nodes.length;
    for (let i = 0; i < len; i++) {
      const n = nodes[i];
      if (n.dur > 0) {
        const p = (now - n.t0) / n.dur;
        if (p >= 1) {
          n.ri = n.riTo;
          n.dur = 0;
        } else if (p > 0) n.ri = n.riFrom + (n.riTo - n.riFrom) * easeInOut(p);
        else n.ri = n.riFrom;
      }
      const bi = n.bi < nb ? n.bi : 0;
      const ease = Math.min(1, dt * 3);
      n.u += (n.uT - n.u) * ease;
      n.jr += (n.jrT - n.jr) * ease;
      const wide = n.gc > 14 ? 1.25 : 1;
      const r = radiusAt(rr, n.ri) + n.jr * jit * wide;
      const s0 = cur0[bi];
      const sw = cur1[bi] - s0;
      const drift = calm ? 0 : Math.sin(now * 0.0001 + n.ph) * Math.min(6 / r, sw * 0.04);
      let a = s0 + sw * n.u + drift;
      // keep clear of the ring labels at 12 o'clock
      const hw = labelHalf(n.ri) / r;
      if (hw > 0) {
        const dd = ((((a + Math.PI / 2 + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
        if (Math.abs(dd) < hw) a += (dd >= 0 ? hw : -hw) - dd;
      }
      n.a = a;
      n.x = cx + Math.cos(a) * r;
      n.y = cy + Math.sin(a) * r;
      n.dens = densityScale(sw * r, n.gc, nodeR * 7 * 0.62);
      const target = n.match ? 1 : 0.1;
      n.fm += (target - n.fm) * Math.min(1, dt * 7);
    }

    // filaments
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(159,216,255,0.075)";
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const n = nodes[i];
      if (n === focus || n.fm < 0.5 || n.dying || now < n.born || n.bi >= nb) continue;
      if (n.h === 4) continue;
      const hx = hubX[n.bi];
      const hy = hubY[n.bi];
      const dx = n.x - hx;
      const dy = n.y - hy;
      ctx.moveTo(hx, hy);
      ctx.quadraticCurveTo(hx + dx / 2 - dy * 0.12, hy + dy / 2 + dx * 0.12, n.x, n.y);
    }
    ctx.stroke();
    if (focus && focus.bi < nb) {
      const hx = hubX[focus.bi];
      const hy = hubY[focus.bi];
      const dx = focus.x - hx;
      const dy = focus.y - hy;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.quadraticCurveTo(hx + dx / 2 - dy * 0.12, hy + dy / 2 + dx * 0.12, focus.x, focus.y);
      ctx.strokeStyle = "rgba(190,230,255,0.75)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // trails for gliding nodes
    ctx.lineWidth = 2;
    for (let i = 0; i < len; i++) {
      const n = nodes[i];
      if (n.dur <= 1 || now < n.t0) continue;
      const p = (now - n.t0) / n.dur;
      if (p >= 1) continue;
      const rb = radiusAt(rr, n.riFrom + (n.riTo - n.riFrom) * easeInOut(Math.max(0, p - 0.22))) + n.jr * jit;
      const x2 = cx + Math.cos(n.a) * rb;
      const y2 = cy + Math.sin(n.a) * rb;
      ctx.strokeStyle = "rgba(210,238,255,0.55)";
      ctx.globalAlpha = 1 - p * 0.6;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
    }

    // ripples
    for (let k2 = 0; k2 < MAX_RIPPLES; k2++) {
      const rn = ripNode[k2];
      if (!rn) continue;
      const p = (now - ripT[k2]) / 1600;
      if (p < 0) continue;
      if (p > 1) {
        ripNode[k2] = null;
        continue;
      }
      ctx.globalAlpha = (1 - p) * 0.7;
      ctx.strokeStyle = "#9fd8ff";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(rn.x, rn.y, 4 + p * 26, 0, TAU);
      ctx.stroke();
    }

    // nodes
    for (let i = 0; i < len; i++) {
      const n = nodes[i];
      let life = (now - n.born) / FADE_MS;
      if (life <= 0) continue;
      if (life > 1) life = 1;
      if (n.dying) life *= Math.max(0, 1 - (now - n.dying) / 800);
      const tw = calm ? 1 : 0.86 + 0.14 * Math.sin(now * 0.0017 + n.ph * 3);
      const base = life * n.fm * tw;
      if (base < 0.01) continue;
      const urgent = n.o.urgent;
      // Crowded rings get a smaller glow so colours stay readable; the unhappy red keeps most of its size.
      let d = nodeR * 7 * (urgent ? 1.3 : 1) * (n.h === 0 ? Math.max(0.88, n.dens) : n.dens);
      const f = n.hT ? Math.min(1, (now - n.hT) / 1200) : 1;
      if (n.h === 1 && !calm) d *= 1 + 0.1 * Math.sin(now * 0.0035 + n.ph);
      if (n.h === 0) {
        d *= 1.15;
        if (!calm) {
          const pulse = 0.5 + 0.5 * Math.sin(now * 0.0021 + n.ph);
          ctx.globalAlpha = base * (0.28 + 0.4 * pulse);
          const hd = d * (2.2 + 0.9 * pulse);
          ctx.drawImage(sprites[0], n.x - hd / 2, n.y - hd / 2, hd, hd);
        }
      }
      if (f < 1) {
        ctx.globalAlpha = base * (1 - f) * (n.hPrev === 4 ? 0.4 : 1);
        ctx.drawImage(sprites[n.hPrev], n.x - d / 2, n.y - d / 2, d, d);
      }
      ctx.globalAlpha = base * f * (n.h === 4 ? 0.4 : 1);
      ctx.drawImage(sprites[n.h], n.x - d / 2, n.y - d / 2, d, d);
    }

    // held rings and selection marker (source-over so grey stays grey)
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(160,168,184,0.75)";
    for (let i = 0; i < len; i++) {
      const n = nodes[i];
      if (!n.o.held || now < n.born || n.dying) continue;
      ctx.globalAlpha = Math.min(1, n.fm) * 0.9;
      ctx.beginPath();
      ctx.arc(n.x, n.y, nodeR + 3.5, 0, TAU);
      ctx.stroke();
    }
    if (focus && now >= focus.born) {
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "#e8f6ff";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(focus.x, focus.y, nodeR + 6 + (calm ? 0 : Math.sin(now * 0.005)), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- interaction ---------- */

  function nearest(px: number, py: number, maxD: number): Node | null {
    let best: Node | null = null;
    let bd = maxD * maxD;
    const now = performance.now();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.dying || !n.match || now < n.born) continue;
      const dx = n.x - px;
      const dy = n.y - py;
      const d = dx * dx + dy * dy;
      if (d <= bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  function onMove(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const n = nearest(px, py, 16);
    if (n !== hover) hover = n;
    canvas.style.cursor = n ? "pointer" : "default";
    opts.onHover(n ? n.o : null, n ? n.x : 0, n ? n.y : 0);
  }
  function onLeave() {
    hover = null;
    opts.onHover(null, 0, 0);
  }
  function onClick(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const touch = (e as PointerEvent).pointerType === "touch";
    const n = nearest(e.clientX - rect.left, e.clientY - rect.top, touch ? 24 : 18);
    hover = null;
    opts.onHover(null, 0, 0);
    opts.onSelect(n ? n.id : null);
  }
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("click", onClick);

  /* ---------- public ---------- */

  function resize(w: number, h: number, opt: ResizeOpts) {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = w;
    H = h;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    fontFamily = getComputedStyle(canvas).fontFamily || fontFamily;
    layout(opt);
    // keep nodes from jumping: snap the sector easing to the target after a resize
    cur0 = Float64Array.from(tgt0);
    cur1 = Float64Array.from(tgt1);
    if (!running) draw(performance.now(), 0.016);
  }

  function setActive(on: boolean) {
    if (destroyed) return;
    if (on && !running) {
      running = true;
      lastT = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!on && running) {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  if (typeof document !== "undefined" && document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (destroyed || !W) return;
      fontFamily = getComputedStyle(canvas).fontFamily || fontFamily;
      layout(layoutOpts);
    });
  }

  return {
    resize,
    setData,
    setActive,
    setFilter(f: EyeFilter | null) {
      filter = f;
      recomputeMatch();
    },
    setSelected(id: string | null) {
      selectedId = id;
    },
    /** Test hook: how many nodes the engine holds. */
    nodeCount: () => nodes.length,
    destroy() {
      destroyed = true;
      setActive(false);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
      starEl.remove();
      staticEl.remove();
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
