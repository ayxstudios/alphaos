"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PrefetchOptions } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Check } from "@/components/ui/icons";
import type { Role } from "@/lib/auth/config";
import { TOUR_STEPS } from "@/lib/tour/steps";
import type { TourEvent } from "@/lib/tour/state";
import type { TourMode, TourRequest } from "@/lib/tour/request";
import { TourAborted, find, firstLine, runStep, submitGet, waitFor, type Hooks, type Link as TourLink } from "@/lib/tour/player";
import { recordTourEvent } from "@/app/(app)/help/actions";

/**
 * The tour itself, loaded only when someone starts it (components/tour/tour.tsx).
 *
 * It points, the person clicks (owner, 2026-09-25). Each step: the page dims
 * softly, the real element is cut out of the dim with a pigment ring around
 * it (one gentle pulse on arrival, then still), a thin curved arrow runs from
 * the step card to it, and the card says what it is and what to press. The
 * step completes on the person's own click; nothing is ever pressed for them.
 * Motion is 220 to 400ms and nothing moves on its own once it has arrived.
 *
 * Phone: the card is a sheet above the bottom tabs (or at the top when the
 * target cannot be scrolled clear of it). Laptop: the card sits beside the
 * target, never on it.
 */

type Mode = "none" | "welcome" | "try" | "one" | "done";
type Phase = "wait" | "turn" | "ok";
type Box = { top: number; left: number; width: number; height: number };
type Pt = { x: number; y: number };

const PHONE = "(max-width: 1023px)";
/** Glide between targets, card moves, arrow draw: all inside 220 to 400ms. */
const GLIDE_MS = 320;
const PULSE_MS = 400;
const DRAW_MS = 360;
/** The pause on a finished step (the ring turns sage) before the next one. */
const OK_MS = 420;
/** Air between the element and the ring, and between the ring and the laptop card. */
const PAD = 6;
const GAP = 64;
/** The phone's top bar and bottom tabs. */
const TOP_BAR = 56;
const TAB_BAR = 64;
/** A full prefetch (data included), kept by the router for a few minutes. */
const FULL = { kind: "full" } as unknown as PrefetchOptions;

function save(event: TourEvent): Promise<unknown> {
  // Fire and forget: the tour never waits on (or breaks because of) a save.
  return recordTourEvent(event).catch(() => {});
}

// A Skip (or finish) is remembered in this tab as well as on the server, so a
// save lost on a slow phone connection can never bring the tour back over the
// next page; the dismiss is sent again instead. Starting from the ? menu clears it.
const ENDED_KEY = "alphaos:tour-ended";
function markEnded(event: "dismiss" | "complete") {
  try {
    sessionStorage.setItem(ENDED_KEY, event);
  } catch {
    /* private mode: the server save still counts */
  }
  const send = (tries: number): Promise<unknown> =>
    recordTourEvent({ type: event }).then(
      (res) => (res?.ok || tries <= 0 ? res : new Promise((r) => setTimeout(r, 1500)).then(() => send(tries - 1))),
      () => (tries > 0 ? new Promise((r) => setTimeout(r, 1500)).then(() => send(tries - 1)) : undefined),
    );
  return send(2);
}
function endedHere(): "dismiss" | "complete" | null {
  try {
    const v = sessionStorage.getItem(ENDED_KEY);
    return v === "dismiss" || v === "complete" ? v : null;
  } catch {
    return null;
  }
}
function clearEnded() {
  try {
    sessionStorage.removeItem(ENDED_KEY);
  } catch {
    /* nothing to clear */
  }
}

function focusable(el: HTMLElement) {
  return el.matches("a[href], button, input, select, textarea, summary, [tabindex]");
}

// How the person last moved: a keyboard user gets focus moved onto the ringed
// element; a mouse or touch user does not (a focus ring inside the pigment
// ring reads as two rings). A text box always takes focus, so typing just works.
let keyboardLast = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => (keyboardLast = e.key === "Tab" || e.key === "Enter" || e.key === " " || keyboardLast), true);
  window.addEventListener("pointerdown", () => (keyboardLast = false), true);
}
function shouldFocus(el: HTMLElement) {
  return el.matches("input, textarea, select") || (keyboardLast && focusable(el));
}

function overlap(a: Box, b: Box) {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, hi < lo ? lo : v));

/** The ring around a target: a little air, never past the screen edge. */
function ringBox(r: DOMRect): Box {
  const top = Math.max(3, r.top - PAD);
  const left = Math.max(3, r.left - PAD);
  const bottom = Math.min(window.innerHeight - 3, r.bottom + PAD);
  const right = Math.min(window.innerWidth - 3, r.right + PAD);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Where the card goes: a sheet on a phone, beside the target on a laptop, never on it. */
function placeCard(phone: boolean, card: { w: number; h: number }, ring: Box | null): { x: number; y: number; place: string } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (phone) {
    const x = 8;
    const bottomY = (gap: number) => vh - TAB_BAR - gap - card.h;
    if (!ring) return { x, y: bottomY(12), place: "bottom" };
    // A tab in the bottom bar: lift the sheet so the arrow has room.
    const inTabs = ring.top + ring.height / 2 > vh - TAB_BAR;
    const y = bottomY(inTabs ? 56 : 12);
    const zone = { top: y - 24, left: 0, width: vw, height: card.h + 24 };
    if (!overlap(ring, zone)) return { x, y, place: "bottom" };
    const top = TOP_BAR + 8;
    if (!overlap(ring, { top, left: 0, width: vw, height: card.h + 24 })) return { x, y: top, place: "top" };
    return { x, y, place: "bottom" };
  }
  const m = 16;
  if (!ring) return { x: (vw - card.w) / 2, y: vh - 24 - card.h, place: "bottom" };
  const cx = ring.left + ring.width / 2;
  const cy = ring.top + ring.height / 2;
  const fits = (b: Box) => b.left >= m && b.top >= m && b.left + b.width <= vw - m && b.top + b.height <= vh - m;
  const air = { top: ring.top - 8, left: ring.left - 8, width: ring.width + 16, height: ring.height + 16 };
  const cands = (gap: number) => {
    const across = clamp(cx - card.w / 2, m, vw - card.w - m);
    const down = clamp(cy - card.h / 2, m, vh - card.h - m);
    const all: Record<string, Box> = {
      right: { left: ring.left + ring.width + gap, top: down, width: card.w, height: card.h },
      left: { left: ring.left - gap - card.w, top: down, width: card.w, height: card.h },
      below: { left: across, top: ring.top + ring.height + gap, width: card.w, height: card.h },
      above: { left: across, top: ring.top - gap - card.h, width: card.w, height: card.h },
    };
    const order = ring.left < 260 ? ["right", "below", "above", "left"] : cy > vh * 0.6 ? ["above", "below", "right", "left"] : ["below", "above", "right", "left"];
    return order.map((k) => [k, all[k]] as const);
  };
  for (const gap of [GAP, 32]) {
    for (const [k, b] of cands(gap)) if (fits(b) && !overlap(b, air)) return { x: b.left, y: b.top, place: k };
  }
  // Nowhere clear: the corner that covers it least.
  const corners: Box[] = [
    { left: vw - card.w - m, top: vh - card.h - m, width: card.w, height: card.h },
    { left: m, top: vh - card.h - m, width: card.w, height: card.h },
    { left: vw - card.w - m, top: m, width: card.w, height: card.h },
    { left: m, top: m, width: card.w, height: card.h },
  ];
  const best = corners.reduce((a, b) => (overlap(b, air) < overlap(a, air) ? b : a));
  return { x: best.left, y: best.top, place: "corner" };
}

/**
 * A gentle curve from the card's edge to the ring's edge, entering the
 * target straight on, with a small open arrowhead. Null when they touch.
 */
function arrowPath(c: DOMRect, t: DOMRect): { line: string; head: string } | null {
  const tc = { x: t.left + t.width / 2, y: t.top + t.height / 2 };
  const cc = { x: c.left + c.width / 2, y: c.top + c.height / 2 };
  const off = 8;
  let s: Pt;
  let e: Pt;
  let vertical: boolean;
  if (t.bottom <= c.top - 24 || t.top >= c.bottom + 24) {
    vertical = true;
    const up = t.bottom <= c.top;
    e = { x: clamp(tc.x, t.left + 14, t.right - 14), y: up ? t.bottom + off : t.top - off };
    // Leave the card a little to the side of the target, so the line curves.
    const side = cc.x >= e.x ? 1 : -1;
    const lean = Math.min(56, c.width / 4);
    s = { x: clamp(e.x + side * lean, c.left + 28, c.right - 28), y: up ? c.top - off : c.bottom + off };
    if (Math.abs(s.x - e.x) < 16) s.x = clamp(e.x - side * lean, c.left + 28, c.right - 28);
  } else if (t.right <= c.left - 24 || t.left >= c.right + 24) {
    vertical = false;
    const leftOf = t.right <= c.left;
    e = { x: leftOf ? t.right + off : t.left - off, y: clamp(tc.y, t.top + 12, t.bottom - 12) };
    const side = cc.y >= e.y ? 1 : -1;
    // A short hop (a sidebar item beside its card) reads best as a straight arrow.
    const lean = Math.abs(e.x - (leftOf ? c.left : c.right)) < 120 ? 0 : Math.min(28, c.height / 4);
    s = { x: leftOf ? c.left - off : c.right + off, y: clamp(e.y + side * lean, c.top + 20, c.bottom - 20) };
    if (lean && Math.abs(s.y - e.y) < 12) s.y = clamp(e.y - side * lean, c.top + 20, c.bottom - 20);
  } else return null;
  const dist = Math.hypot(e.x - s.x, e.y - s.y);
  if (dist < 24) return null;
  const k = (vertical ? Math.abs(e.y - s.y) : Math.abs(e.x - s.x)) * 0.5;
  const c1 = vertical ? { x: s.x, y: s.y + Math.sign(e.y - s.y) * k } : { x: s.x + Math.sign(e.x - s.x) * k, y: s.y };
  const c2 = vertical ? { x: e.x, y: e.y - Math.sign(e.y - s.y) * k } : { x: e.x - Math.sign(e.x - s.x) * k, y: e.y };
  // The arrowhead follows the curve's direction at its end.
  const dx = e.x - c2.x;
  const dy = e.y - c2.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const size = 10;
  const spread = 0.5;
  const h1 = { x: e.x - size * (ux * Math.cos(spread) - uy * Math.sin(spread)), y: e.y - size * (uy * Math.cos(spread) + ux * Math.sin(spread)) };
  const h2 = { x: e.x - size * (ux * Math.cos(-spread) - uy * Math.sin(-spread)), y: e.y - size * (uy * Math.cos(-spread) + ux * Math.sin(-spread)) };
  const f = (p: Pt) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  return { line: `M ${f(s)} C ${f(c1)}, ${f(c2)}, ${f(e)}`, head: `M ${f(h1)} L ${f(e)} L ${f(h2)}` };
}

/** Something the person opened (a dialog, a drawer) now sits on top of the element. */
function covered(el: HTMLElement, r: DOMRect) {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
  const top = document.elementsFromPoint(x, y).find((e) => !e.closest("[data-tour-root]"));
  return !!top && !el.contains(top) && !top.contains(el);
}

/** The nearest scrolling box around an element. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return document.scrollingElement as HTMLElement | null;
}

/** A step's two sentences: what it is (the title), then what to press. */
function splitLine(line: string) {
  const cut = line.indexOf(". ");
  return cut > 0 ? { what: line.slice(0, cut + 1), todo: line.slice(cut + 2) } : { what: line, todo: "" };
}

/** A small framed portrait, drawn in the palette: the sample that lands on the drop zone. */
function SamplePortrait({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 50" className={className} aria-hidden="true">
      <rect x="0.5" y="0.5" width="39" height="49" rx="4" fill="var(--color-surface)" stroke="var(--color-line)" />
      <rect x="4" y="4" width="32" height="42" rx="2" fill="var(--color-pigment-soft)" />
      <circle cx="20" cy="20" r="7" fill="var(--color-pigment)" />
      <path d="M8 46c1.5-8 6.5-12 12-12s10.5 4 12 12z" fill="var(--color-pigment)" opacity="0.55" />
    </svg>
  );
}

export default function TourRuntime({ role, firstName, request }: { role: Role; firstName: string; request: TourRequest | null }) {
  const steps = TOUR_STEPS[role];
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<Mode>("none");
  const [index, setIndex] = useState(0);
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState<Phase>("wait");
  const [line, setLine] = useState("");
  const [linkKind, setLinkKind] = useState("");
  const [place, setPlace] = useState("bottom");
  /** The running card stays invisible until its first placement (no flash in a corner). */
  const [placed, setPlaced] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [sampleBox, setSampleBox] = useState<(Box & { key: number }) | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<SVGPathElement>(null);
  const headRef = useRef<SVGPathElement>(null);
  const underRef = useRef<SVGPathElement>(null);
  const underHeadRef = useRef<SVGPathElement>(null);
  const shieldRefs = useRef<(HTMLDivElement | null)[]>([]);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const litRef = useRef<HTMLElement | null>(null);
  /** The link the person is being asked to do, and how to finish it. */
  const waiterRef = useRef<{ link: TourLink; done: () => void } | null>(null);
  /** Where the person's last press is taking them (an in-app link), until it arrives. */
  const pendingNavRef = useRef<string | null>(null);
  const phaseRef = useRef<Phase>("wait");
  const reducedRef = useRef(false);
  const startAtRef = useRef(0);
  const firstRingRef = useRef<number | null>(null);
  /** Bumped when the lit element changes: the ring glides there, pulses once, the arrow draws in. */
  const arrivalRef = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sampleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();

  const running = mode === "try" || mode === "one";

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const mqReduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reducedRef.current = mqReduced.matches;
    };
    sync();
    mqReduced.addEventListener("change", sync);
    return () => mqReduced.removeEventListener("change", sync);
  }, []);

  // ---- lighting ------------------------------------------------------------
  const light = useCallback((el: HTMLElement | null) => {
    if (litRef.current && litRef.current !== el) litRef.current.removeAttribute("data-tour-lit");
    if (litRef.current !== el) arrivalRef.current += 1;
    litRef.current = el;
    el?.setAttribute("data-tour-lit", "");
  }, []);

  const showSample = useCallback((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setSampleBox({ top: r.top, left: r.left, width: r.width, height: r.height, key: performance.now() });
    if (sampleTimer.current) clearTimeout(sampleTimer.current);
    sampleTimer.current = setTimeout(() => setSampleBox(null), 1400);
  }, []);

  /** The calm part of the screen for a target: clear of the top bar and of the phone sheet (plus arrow room). */
  const clearArea = useCallback(() => {
    const vh = window.innerHeight;
    if (!window.matchMedia(PHONE).matches) return { top: 72, bottom: vh - 24 };
    const h = sheetRef.current?.offsetHeight ?? 120;
    return { top: TOP_BAR + 12, bottom: vh - TAB_BAR - 12 - h - 64 };
  }, []);

  /** Scrolls a target into the calm part of the screen, if it is not already there. */
  const bringIntoView = useCallback(
    async (h: Pick<Hooks, "signal">, el: HTMLElement) => {
      const behavior: ScrollBehavior = reducedRef.current ? "auto" : "smooth";
      const settle = async () => {
        let last = "";
        let same = 0;
        await waitFor(
          h,
          () => {
            const r = el.getBoundingClientRect();
            const key = `${Math.round(r.top)},${Math.round(r.left)}`;
            same = key === last ? same + 1 : 0;
            last = key;
            return same >= 3;
          },
          900,
        );
      };
      let r = el.getBoundingClientRect();
      // A row that scrolls sideways (the Orders tabs on a phone): centre it across.
      if (r.left < 0 || r.right > window.innerWidth) {
        el.scrollIntoView({ block: "nearest", inline: "center", behavior });
        await settle();
        r = el.getBoundingClientRect();
      }
      // Fixed things (the bottom tabs, the sidebar) never need scrolling.
      if (el.closest('nav[aria-label="Primary"], aside')) return;
      const area = clearArea();
      if (r.top >= area.top && r.bottom <= area.bottom) return;
      const box = scrollParent(el);
      if (!box) return;
      const phoneNow = window.matchMedia(PHONE).matches;
      // Phone: just above the sheet, so the arrow is short. Laptop: the middle.
      const want = phoneNow ? Math.max(area.top, area.bottom - r.height) : area.top + Math.max(0, (area.bottom - area.top - r.height) / 2);
      box.scrollBy({ top: r.top - want, behavior });
      await settle();
    },
    [clearArea],
  );

  const hooks = useCallback(
    (signal: AbortSignal): Hooks => ({
      signal,
      router: {
        push: (href) => router.push(href),
        prefetch: (href) => router.prefetch(href, FULL),
      },
      rest: (next) => {
        setLine(next);
        setPhase("wait");
      },
      point: async (link) => {
        setLine(link.line);
        setLinkKind(link.kind);
        setPhase("wait");
        const found = await waitFor({ signal }, () => find(link.sel), 8000);
        if (!found) return; // Not on this page after all: never strand the person.
        // Let the part it sits in finish loading (an order card's details), so
        // the ring lands once and the element is not swapped under it.
        const scope = found.closest('[role="dialog"]') ?? found.closest("main");
        if (scope) await waitFor({ signal }, () => !scope.querySelector(".animate-pulse"), 5000);
        const el = find(link.sel) ?? found;
        await bringIntoView({ signal }, el);
        light(el);
        if (firstRingRef.current === null) {
          firstRingRef.current = performance.now() - startAtRef.current;
          sheetRef.current?.setAttribute("data-first-ring-ms", String(Math.round(firstRingRef.current)));
        }
        if (shouldFocus(el)) el.focus({ preventScroll: true });
        setPhase("turn");
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            waiterRef.current = null;
            reject(new TourAborted());
          };
          if (signal.aborted) return abort();
          signal.addEventListener("abort", abort, { once: true });
          waiterRef.current = {
            link,
            done: () => {
              signal.removeEventListener("abort", abort);
              waiterRef.current = null;
              setPhase("wait");
              resolve();
            },
          };
        });
      },
    }),
    [router, light, bringIntoView],
  );

  // ---- starting and stopping ----------------------------------------------------
  const begin = useCallback(
    (next: TourMode, at: number, first = 0, persist = true) => {
      if (!returnFocus.current && document.activeElement instanceof HTMLElement && !document.activeElement.closest("[data-tour-root]")) {
        returnFocus.current = document.activeElement;
      }
      startAtRef.current = at || performance.now();
      firstRingRef.current = null;
      if (persist && next !== "one") {
        clearEnded();
        save({ type: "start" });
      }
      const from = Math.max(0, Math.min(steps.length - 1, first));
      // The first pages the tour visits, with their data, so each step lands at once.
      for (const s of steps.slice(from, from + 2)) router.prefetch(s.path, FULL);
      setPhase("wait");
      setLine(firstLine(steps[from]));
      setLinkKind("");
      setAnnounce("");
      setIndex(from);
      setMode(next === "one" ? "one" : "try");
      setRun((r) => r + 1);
    },
    [router, steps],
  );

  const stop = useCallback(
    (next: Mode) => {
      light(null);
      waiterRef.current = null;
      setMode(next);
      if (next === "none") {
        const back = returnFocus.current;
        returnFocus.current = null;
        if (back && document.contains(back)) back.focus({ preventScroll: true });
      }
    },
    [light],
  );

  useEffect(() => {
    if (!request) return;
    // Skipped or finished in this tab already: the server has not caught up, so
    // a welcome or resume is not shown again; the end is sent once more instead.
    const ended = request.kind === "welcome" || request.kind === "resume" ? endedHere() : null;
    if (ended) void markEnded(ended);
    else if (request.kind === "welcome") setMode("welcome");
    else if (request.kind === "resume") begin("try", performance.now(), request.step, false);
    else begin(request.mode, request.at, request.step);
    // Each request is handled once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id, request?.kind]);

  const skip = useCallback(() => {
    if (mode !== "one") void markEnded("dismiss");
    stop("none");
  }, [mode, stop]);

  const later = useCallback(() => {
    save({ type: "later" });
    stop("none");
  }, [stop]);

  const back = useCallback(() => {
    if (index === 0) return;
    setPhase("wait");
    setLine(firstLine(steps[index - 1]));
    setIndex(index - 1);
    setRun((r) => r + 1);
  }, [index, steps]);

  // ---- one step: point at each link, wait for the person, then move on ----------
  useEffect(() => {
    if (!running) return;
    const ac = new AbortController();
    const h = hooks(ac.signal);
    const current = steps[index];
    (async () => {
      setPhase("wait");
      setLine(firstLine(current));
      const ahead = () => {
        for (const s of steps.slice(index, index + 2)) router.prefetch(s.path, FULL);
      };
      // A save clears the router cache, so the next page is fetched after it.
      if (mode === "try") void save({ type: "step", step: index }).then(ahead);
      else ahead();
      pendingNavRef.current = null;
      await runStep(h, current, mode === "one");
      setPhase("ok");
      setAnnounce("Done.");
      // The person's press opens a page: let it arrive before the next ring, so
      // nothing changes under the next step (a busy server can take a while).
      const pending = pendingNavRef.current;
      if (pending) await waitFor(h, () => location.pathname + location.search === pending, 15000);
      await new Promise((r) => setTimeout(r, OK_MS));
      if (ac.signal.aborted) return;
      if (mode === "one") stop("none");
      else if (index + 1 < steps.length) setIndex(index + 1);
      else {
        void markEnded("complete");
        stop("done");
      }
    })().catch((error) => {
      if (!(error instanceof TourAborted)) console.error("tour step failed", error);
    });
    return () => ac.abort();
    // `run` replays the same step (Back, restart).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, index, run]);

  // Announce each thing to press (screen readers hear the card's words).
  useEffect(() => {
    if (!running || phase !== "turn") return;
    setAnnounce(`${mode === "try" ? `Step ${index + 1} of ${steps.length}. ` : ""}${line}`);
  }, [running, phase, mode, index, steps.length, line]);

  // ---- the person's own action finishes the ringed link ------------------------------
  useEffect(() => {
    if (!running) return;
    const inLit = (e: Event) => {
      if (!(e.target instanceof Node)) return false;
      const el = litRef.current;
      if (el && el.contains(e.target)) return true;
      // The page re-rendered the ringed thing: its new copy counts too.
      const again = waiterRef.current ? find(waiterRef.current.link.sel) : null;
      return !!again && again.contains(e.target);
    };
    const onClick = (e: MouseEvent) => {
      const w = waiterRef.current;
      if (!w || !inLit(e)) return;
      if (w.link.kind === "drop") {
        // Never a real upload during the tour: the press is caught and a sample lands.
        e.preventDefault();
        e.stopPropagation();
        showSample(litRef.current!);
        w.done();
        return;
      }
      if (w.link.kind === "search") return; // done when they press Enter
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (a && !e.defaultPrevented) {
        const to = new URL(a.href, location.href);
        if (to.origin === location.origin && to.pathname + to.search !== location.pathname + location.search) pendingNavRef.current = to.pathname + to.search;
      }
      w.done();
    };
    const onSubmit = (e: SubmitEvent) => {
      const w = waiterRef.current;
      if (!w || w.link.kind !== "search") return;
      const form = e.target as HTMLFormElement;
      const el = litRef.current;
      if (!el || !form.contains(el)) return;
      // Same results, without reloading the page under the tour.
      e.preventDefault();
      e.stopPropagation();
      submitGet({ router: { push: (href) => router.push(href) } }, form);
      w.done();
    };
    const onDragOver = (e: DragEvent) => {
      if (waiterRef.current?.link.kind === "drop" && inLit(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const w = waiterRef.current;
      if (!w || w.link.kind !== "drop" || !inLit(e)) return;
      e.preventDefault();
      e.stopPropagation();
      showSample(litRef.current!);
      w.done();
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("submit", onSubmit, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [running, router, showSample]);

  // ---- follow the lit element (transforms only; still once it has arrived) ------
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let lastRing = "";
    let lastCard = "";
    let lastArrow = "";
    let seenArrival = -1;
    let shown = false;
    let cardPlaced = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const tick = () => {
      const spot = spotRef.current;
      const card = cardRef.current;
      const sheet = sheetRef.current;
      let lit = litRef.current;
      // The page re-rendered the ringed element (fresh data): follow its new copy quietly.
      if (lit && !lit.isConnected && waiterRef.current) {
        const again = find(waiterRef.current.link.sel);
        if (again) {
          again.setAttribute("data-tour-lit", "");
          litRef.current = again;
          lit = again;
        }
      }
      const reduced = reducedRef.current;
      const phoneNow = window.matchMedia(PHONE).matches;
      let r = lit && lit.isConnected ? lit.getBoundingClientRect() : null;
      // Once done, a dialog the person opened over it takes the stage: the ring lets go.
      if (r && lit && phaseRef.current !== "turn" && covered(lit, r)) r = null;
      const box = r && r.width > 0 && r.height > 0 ? ringBox(r) : null;
      const arrived = arrivalRef.current !== seenArrival;
      if (spot) {
        const key = box ? `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}` : "none";
        if (key !== lastRing || arrived) {
          if (box) {
            // A new target glides in; the same one moving (a scroll) is followed exactly.
            const glide = arrived && shown && !reduced;
            spot.style.transition = glide
              ? `transform ${GLIDE_MS}ms var(--ease-standard), width ${GLIDE_MS}ms var(--ease-standard), height ${GLIDE_MS}ms var(--ease-standard), opacity 220ms var(--ease-standard)`
              : "opacity 220ms var(--ease-standard)";
            spot.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`;
            spot.style.width = `${box.width}px`;
            spot.style.height = `${box.height}px`;
            spot.style.opacity = "1";
            if (arrived) {
              // One gentle pulse once it lands, then still.
              const pulse = pulseRef.current;
              if (pulse && !reduced) {
                timers.push(
                  setTimeout(
                    () =>
                      pulse.animate(
                        [
                          { boxShadow: "0 0 0 0 color-mix(in srgb, var(--color-pigment) 40%, transparent)" },
                          { boxShadow: "0 0 0 12px color-mix(in srgb, var(--color-pigment) 0%, transparent)" },
                        ],
                        { duration: PULSE_MS, easing: "cubic-bezier(0, 0, 0.2, 1)" },
                      ),
                    glide ? GLIDE_MS : 60,
                  ),
                );
              }
              spot.dataset.arrival = String(arrivalRef.current);
            }
            shown = true;
          } else {
            spot.style.opacity = "0";
            shown = false;
          }
          lastRing = key;
        }
        spot.dataset.phase = phaseRef.current;
        // Shield: while a page opens nothing can be pressed; on the person's turn only the ringed element can.
        const [t, b, lft, rgt] = shieldRefs.current;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const hole = phaseRef.current === "turn" && box ? box : null;
        const set = (el: HTMLDivElement | null | undefined, x: number, y: number, w: number, hgt: number) => {
          if (!el) return;
          el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          el.style.width = `${Math.max(0, w)}px`;
          el.style.height = `${Math.max(0, hgt)}px`;
        };
        if (hole) {
          set(t, 0, 0, vw, hole.top);
          set(b, 0, hole.top + hole.height, vw, vh - hole.top - hole.height);
          set(lft, 0, hole.top, hole.left, hole.height);
          set(rgt, hole.left + hole.width, hole.top, vw - hole.left - hole.width, hole.height);
        } else {
          set(t, 0, 0, vw, vh);
          set(b, 0, 0, 0, 0);
          set(lft, 0, 0, 0, 0);
          set(rgt, 0, 0, 0, 0);
        }
      }
      // The card: beside the target, never on it.
      if (card && sheet) {
        const w = phoneNow ? window.innerWidth - 16 : 360;
        const size = { w, h: sheet.offsetHeight };
        const at = placeCard(phoneNow, size, box);
        const key = `${Math.round(at.x)},${Math.round(at.y)},${w}`;
        if (key !== lastCard) {
          card.style.transition = cardPlaced && !reduced ? `transform ${GLIDE_MS}ms var(--ease-standard)` : "none";
          card.style.width = `${w}px`;
          card.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
          if (!cardPlaced) setPlaced(true);
          cardPlaced = true;
          lastCard = key;
          setPlace((p) => (p === at.place ? p : at.place));
        }
      }
      // The arrow, from where the card and the ring really are (both may be gliding).
      const line = arrowRef.current;
      const head = headRef.current;
      if (line && head && spot && sheet) {
        const path = box && shown ? arrowPath(sheet.getBoundingClientRect(), spot.getBoundingClientRect()) : null;
        const key = path ? path.line : "none";
        if (key !== lastArrow) {
          line.setAttribute("d", path?.line ?? "");
          head.setAttribute("d", path?.head ?? "");
          underRef.current?.setAttribute("d", path?.line ?? "");
          underHeadRef.current?.setAttribute("d", path?.head ?? "");
          lastArrow = key;
        }
        if (arrived && path && !reduced) {
          // Drawn in once, from the card toward the target.
          for (const l of [line, underRef.current]) l?.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: DRAW_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" });
          for (const hd of [head, underHeadRef.current]) hd?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: DRAW_MS - 120, easing: "linear", fill: "backwards" });
        }
      }
      if (arrived) seenArrival = arrivalRef.current;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      setPlaced(false);
    };
  }, [running]);

  // Welcome and Done cards (not running): a calm card at the bottom.
  useEffect(() => {
    if (running || !cardRef.current) return;
    cardRef.current.style.transition = "none";
    cardRef.current.style.transform = "";
    cardRef.current.style.width = "";
  }, [running, mode]);

  useEffect(() => {
    if (mode === "none") light(null);
  }, [mode, light]);
  useEffect(() => () => light(null), [light]);

  // ---- keyboard: Esc skips; focus lands where it helps -------------------------
  useEffect(() => {
    if (mode === "none") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === "welcome") later();
      else if (mode === "done") stop("none");
      else skip();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, later, skip, stop]);

  useEffect(() => {
    if (!mounted || (mode !== "welcome" && mode !== "done")) return;
    const id = requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [mounted, mode]);

  if (!mounted || mode === "none") return null;

  const btn = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-input px-4 text-sm font-medium transition-colors motion-hover lg:min-h-10";
  const primaryBtn = cn(btn, "bg-pigment text-surface hover:opacity-90", focusRing);
  const secondaryBtn = cn(btn, "border border-line bg-surface text-ink hover:bg-canvas", focusRing);
  const quiet = cn("inline-flex min-h-11 items-center rounded-input px-2.5 text-sm text-slate transition-colors motion-hover hover:text-ink lg:min-h-8", focusRing);
  const { what, todo } = splitLine(line);

  return createPortal(
    <div data-tour-root="" data-tour-mode={mode}>
      {running && (
        <>
          {/* Blocks stray presses: everything while a page opens, all but the ringed element on the person's turn. */}
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              ref={(el) => {
                shieldRefs.current[i] = el;
              }}
              aria-hidden="true"
              data-tour-shield=""
              onClick={() => {
                // A press outside: one soft pulse toward the ring, nothing else.
                const pulse = pulseRef.current;
                if (phaseRef.current === "turn" && pulse && !reducedRef.current) {
                  pulse.animate(
                    [
                      { boxShadow: "0 0 0 0 color-mix(in srgb, var(--color-pigment) 40%, transparent)" },
                      { boxShadow: "0 0 0 12px color-mix(in srgb, var(--color-pigment) 0%, transparent)" },
                    ],
                    { duration: PULSE_MS, easing: "cubic-bezier(0, 0, 0.2, 1)" },
                  );
                }
              }}
              className="fixed left-0 top-0 z-[70] h-0 w-0"
            />
          ))}
          {/* The spotlight: the page dims softly around a rounded cut-out, ringed in pigment. */}
          <div
            ref={spotRef}
            aria-hidden="true"
            data-tour-ring=""
            data-phase={phase}
            className={cn(
              "pointer-events-none fixed left-0 top-0 z-[71] rounded-card opacity-0",
              phase === "ok"
                ? "shadow-[0_0_0_2px_var(--color-sage),0_0_0_200vmax_color-mix(in_srgb,var(--color-ink)_34%,transparent)]"
                : "shadow-[0_0_0_2px_var(--color-pigment),0_0_0_200vmax_color-mix(in_srgb,var(--color-ink)_34%,transparent)]",
            )}
          >
            <div ref={pulseRef} className="absolute inset-0 rounded-[inherit]" />
          </div>
          {/* The arrow: a thin curve from the card to the ring, with a small open head. */}
          <svg aria-hidden="true" data-tour-arrow="" className="pointer-events-none fixed inset-0 z-[72] h-full w-full overflow-visible">
            {/* A thin surface-coloured underlay, so the line stays crisp where it crosses text. */}
            <path ref={underRef} pathLength={1} strokeDasharray="1 1" fill="none" stroke="var(--color-surface)" strokeOpacity={0.85} strokeWidth={5} strokeLinecap="round" />
            <path ref={underHeadRef} fill="none" stroke="var(--color-surface)" strokeOpacity={0.85} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
            <path
              ref={arrowRef}
              data-tour-arrow-line=""
              pathLength={1}
              strokeDasharray="1 1"
              fill="none"
              stroke={phase === "ok" ? "var(--color-sage)" : "var(--color-pigment)"}
              strokeWidth={2}
              strokeLinecap="round"
            />
            <path
              ref={headRef}
              data-tour-arrow-head=""
              fill="none"
              stroke={phase === "ok" ? "var(--color-sage)" : "var(--color-pigment)"}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {sampleBox && (
            <div
              key={sampleBox.key}
              aria-hidden="true"
              data-tour-sample=""
              className="pointer-events-none fixed z-[73] flex items-center justify-center gap-2 rounded-input border border-dashed border-pigment bg-pigment-soft text-sm font-medium text-ink [animation:alpha-toast-in_220ms_var(--ease-standard)]"
              style={{ top: sampleBox.top, left: sampleBox.left, width: sampleBox.width, height: sampleBox.height }}
            >
              <SamplePortrait className="h-10 w-8 shrink-0" />
              <span className="truncate">sample-portrait.jpg</span>
              <Check size={16} className="shrink-0 text-sage" />
            </div>
          )}
        </>
      )}

      {/* The card: what it is, what to press, and the quiet way out. */}
      <div
        ref={cardRef}
        className={cn(
          "pointer-events-none fixed z-[75]",
          running ? cn("left-0 top-0", !placed && "opacity-0") : "inset-x-0 bottom-[calc(4rem+8px)] flex justify-center px-2 lg:bottom-6 lg:px-4",
        )}
      >
        <div
          ref={sheetRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          data-tour-sheet=""
          data-mode={mode}
          data-phase={running ? phase : ""}
          data-step={running ? index : -1}
          data-steps={steps.length}
          data-act={linkKind}
          data-place={place}
          data-line={running ? line : ""}
          className={cn(
            "pointer-events-auto w-full rounded-card bg-surface shadow-lg outline-none [animation:alpha-toast-in_220ms_var(--ease-standard)]",
            running ? "px-4 pb-3 pt-2 lg:px-5 lg:pb-4 lg:pt-3" : "max-w-md p-4 lg:p-5",
          )}
        >
          {mode === "welcome" && (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
                  Welcome, {firstName}.
                </h2>
                <button type="button" onClick={later} className={cn(quiet, "-mr-2 -mt-2")}>
                  Later
                </button>
              </div>
              <p className="text-sm text-slate">A few steps point to what you use every day. You do each one yourself, at your own pace.</p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="button" onClick={skip} className={secondaryBtn}>
                  Skip
                </button>
                <button ref={primaryRef} type="button" onClick={() => begin("try", performance.now())} className={primaryBtn}>
                  Show me around
                </button>
              </div>
            </div>
          )}

          {mode === "done" && (
            <div className="flex flex-col gap-3">
              <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
                You are ready.
              </h2>
              <p className="text-sm text-slate">Everything you tried works the same way every day. The&nbsp;? at the top brings this back any time.</p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Link href="/help" onClick={() => stop("none")} className={secondaryBtn}>
                  Quick guide
                </Link>
                <button ref={primaryRef} type="button" onClick={() => stop("none")} className={primaryBtn}>
                  Done
                </button>
              </div>
            </div>
          )}

          {running && (
            <div className="flex flex-col">
              <div className="flex min-h-11 items-center gap-2 lg:min-h-9">
                {phase === "ok" ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-sage" data-tour-done="">
                    <Check size={14} /> Done
                  </span>
                ) : (
                  mode === "try" && (
                    <span className="text-xs font-medium tabular-nums text-slate" data-tour-count="">
                      {index + 1} of {steps.length}
                    </span>
                  )
                )}
                <span className="-mr-2.5 ml-auto flex items-center">
                  {mode === "try" && index > 0 && (
                    <button type="button" onClick={back} className={quiet}>
                      Back
                    </button>
                  )}
                  <button type="button" onClick={skip} className={quiet}>
                    {mode === "one" ? "Close" : "Skip"}
                  </button>
                </span>
              </div>
              <p id={titleId} className="text-base font-semibold text-ink [text-wrap:balance]" data-tour-what="">
                {what}
              </p>
              {todo && (
                <p className="mt-0.5 text-sm text-slate [text-wrap:pretty]" data-tour-todo="">
                  {todo}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>,
    document.body,
  );
}
