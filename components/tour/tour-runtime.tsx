"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PrefetchOptions } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Check, Pause } from "@/components/ui/icons";
import type { Role } from "@/lib/auth/config";
import { TOUR_STEPS, stepLine } from "@/lib/tour/steps";
import type { TourEvent } from "@/lib/tour/state";
import type { TourMode, TourRequest } from "@/lib/tour/request";
import {
  TourAborted,
  closeOverlays,
  demonstrate,
  find,
  sleep,
  submitGet,
  turnChain,
  undo,
  waitFor,
  type Demo,
  type Ghost,
  type Hooks,
} from "@/lib/tour/player";
import { recordTourEvent } from "@/app/(app)/help/actions";

/**
 * The tour itself, loaded only when someone starts it (components/tour/tour.tsx).
 *
 * Every step is a demonstration on the real screen: a ghost pointer (a tap
 * ring on a phone) goes to the real element and presses it, the real page
 * responds, then the page is put back and the same element is lit: "Your
 * turn". The step completes the moment the person does it themselves.
 * "Watch" plays every step on its own in about half a minute.
 */

type Mode = "none" | "welcome" | "watch" | "try" | "one" | "watch-end" | "done";
type Phase = "demo" | "turn" | "ok";
type Box = { top: number; left: number; width: number; height: number };

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const PHONE = "(max-width: 1023px)";
/** Target length of "Watch how it works". */
const WATCH_MS = 36_000;
const TYPICAL_DEMO_MS = 2_000;
/** A full prefetch (data included), kept by the router for a few minutes. */
const FULL = { kind: "full" } as unknown as PrefetchOptions;

function save(event: TourEvent): Promise<unknown> {
  // Fire and forget: the tour never waits on (or breaks because of) a save.
  return recordTourEvent(event).catch(() => {});
}

function focusable(el: HTMLElement) {
  return el.matches("a[href], button, input, select, textarea, summary, [tabindex]");
}

function overlap(a: Box, b: Box) {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The lit ring around a target: 4px of air, never past the screen edge (the 2px outline is outside). */
function ringBox(r: DOMRect): Box {
  const top = Math.max(2, r.top - 4);
  const left = Math.max(2, r.left - 4);
  const bottom = Math.min(window.innerHeight - 2, r.bottom + 4);
  const right = Math.min(window.innerWidth - 2, r.right + 4);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** A small framed portrait, drawn in the palette: the upload demo's sample file. */
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
  const [phase, setPhase] = useState<Phase>("demo");
  const [line, setLine] = useState("");
  const [paused, setPaused] = useState(false);
  const [place, setPlace] = useState<"bottom" | "top">("bottom");
  const [announce, setAnnounce] = useState("");
  const [phone, setPhone] = useState(false);
  const [finger, setFinger] = useState(false);
  const [actKind, setActKind] = useState("");
  const [sampleBox, setSampleBox] = useState<(Box & { key: number }) | null>(null);

  const sheetRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLDivElement>(null);
  const carryRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const shieldRefs = useRef<(HTMLDivElement | null)[]>([]);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const litRef = useRef<HTMLElement | null>(null);
  const posRef = useRef({ x: -100, y: -100 });
  const anims = useRef(new Set<Animation>());
  const pausedRef = useRef(false);
  const phaseRef = useRef<Phase>("demo");
  const reducedRef = useRef(false);
  const startAtRef = useRef(0);
  const firstMoveRef = useRef<number | null>(null);
  const watchStartRef = useRef(0);
  /** Server time during this watch: pacing counts only the tour's own time. */
  const watchNetRef = useRef(0);
  const modeRef = useRef<Mode>("none");
  const turnRef = useRef<{ demo: Demo; chain: string[][] } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const okTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sampleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();
  const statsRef = useRef({ netMs: 0 });

  const running = mode === "watch" || mode === "try" || mode === "one";

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    pausedRef.current = paused;
    for (const a of anims.current) {
      if (paused) a.pause();
      else a.play();
    }
  }, [paused]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const mqPhone = window.matchMedia(PHONE);
    const mqCoarse = window.matchMedia("(pointer: coarse)");
    const mqReduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setPhone(mqPhone.matches);
      setFinger(mqPhone.matches || mqCoarse.matches);
      reducedRef.current = mqReduced.matches;
    };
    sync();
    for (const mq of [mqPhone, mqCoarse, mqReduced]) mq.addEventListener("change", sync);
    return () => {
      for (const mq of [mqPhone, mqCoarse, mqReduced]) mq.removeEventListener("change", sync);
    };
  }, []);

  // ---- lighting ------------------------------------------------------------
  const light = useCallback((el: HTMLElement | null) => {
    if (litRef.current && litRef.current !== el) litRef.current.removeAttribute("data-tour-lit");
    litRef.current = el;
    el?.setAttribute("data-tour-lit", "");
  }, []);

  const showSample = useCallback((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setSampleBox({ top: r.top, left: r.left, width: r.width, height: r.height, key: performance.now() });
    if (sampleTimer.current) clearTimeout(sampleTimer.current);
    sampleTimer.current = setTimeout(() => setSampleBox(null), 1400);
  }, []);

  const reserveBottom = useCallback(() => {
    const h = sheetRef.current?.offsetHeight ?? 110;
    return window.matchMedia(PHONE).matches ? 64 + 8 + h + 8 : 24 + h + 8;
  }, []);

  // ---- the ghost pointer --------------------------------------------------------
  const ghost = useMemo<Ghost>(() => {
    const track = (a: Animation) => {
      anims.current.add(a);
      if (pausedRef.current) a.pause();
      const drop = () => anims.current.delete(a);
      a.finished.then(drop, drop);
      return a;
    };
    const tf = (p: { x: number; y: number }) => `translate3d(${p.x}px, ${p.y}px, 0)`;
    return {
      async moveTo(x, y) {
        const el = ghostRef.current;
        if (!el) return;
        if (firstMoveRef.current === null) {
          firstMoveRef.current = performance.now() - startAtRef.current;
          sheetRef.current?.setAttribute("data-first-move-ms", String(Math.round(firstMoveRef.current)));
        }
        const from = posRef.current;
        const to = { x, y };
        posRef.current = to;
        el.style.opacity = "1";
        el.style.transform = tf(to);
        if (reducedRef.current) return; // jump, no glide
        const a = track(el.animate([{ transform: tf(from) }, { transform: tf(to) }], { duration: 400, easing: EASE }));
        await a.finished.catch(() => {});
      },
      async press() {
        const ripple = rippleRef.current;
        const wave = ripple?.firstElementChild as HTMLElement | null;
        if (ripple && wave) {
          ripple.style.transform = tf(posRef.current);
          if (reducedRef.current) {
            // No growth with reduced motion: a still ring, briefly.
            wave.style.opacity = "0.5";
            setTimeout(() => (wave.style.opacity = "0"), 400);
          } else {
            track(
              wave.animate(
                [
                  { transform: "translate(-50%, -50%) scale(0.4)", opacity: 0.55 },
                  { transform: "translate(-50%, -50%) scale(2.2)", opacity: 0 },
                ],
                { duration: 400, easing: EASE },
              ),
            );
          }
        }
        const dot = pressRef.current;
        if (dot && !reducedRef.current) {
          const a = track(dot.animate([{ transform: "scale(1)" }, { transform: "scale(0.82)" }, { transform: "scale(1)" }], { duration: 220, easing: EASE }));
          await new Promise((r) => setTimeout(r, 120));
          void a;
        } else await new Promise((r) => setTimeout(r, 120));
      },
      lift() {
        if (ghostRef.current) ghostRef.current.style.opacity = "0";
      },
      carry(on) {
        if (carryRef.current) carryRef.current.style.opacity = on ? "1" : "0";
      },
    };
  }, []);

  const hooks = useCallback(
    (signal: AbortSignal): Hooks => ({
      signal,
      reduced: reducedRef.current,
      isPaused: () => pausedRef.current,
      ghost,
      router: {
        push: (href) => router.push(href),
        back: () => router.back(),
        prefetch: (href) => router.prefetch(href, FULL),
      },
      light,
      sample: showSample,
      reserveBottom,
      stats: statsRef.current,
      // Watching is unhurried; a demonstration before your turn is brisk.
      dwell: modeRef.current === "watch" ? 450 : 150,
    }),
    [ghost, router, light, showSample, reserveBottom],
  );

  // ---- starting and stopping ----------------------------------------------------
  const begin = useCallback(
    (next: TourMode, at: number, first = 0, persist = true) => {
      if (!returnFocus.current && document.activeElement instanceof HTMLElement && !document.activeElement.closest("[data-tour-root]")) {
        returnFocus.current = document.activeElement;
      }
      startAtRef.current = at || performance.now();
      firstMoveRef.current = null;
      watchStartRef.current = performance.now();
      watchNetRef.current = 0;
      if (persist && next !== "one") save({ type: "start" });
      // The first pages the tour visits, with their data, so each step lands at
      // once; each step then fetches the one after it (never all at once, so
      // the page being shown is never queued behind the others).
      const from = Math.max(0, Math.min(steps.length - 1, first));
      for (const s of steps.slice(from, from + 2)) router.prefetch(s.path, FULL);
      // The ghost starts where the eye already is: just above the sheet.
      posRef.current = { x: window.innerWidth / 2, y: window.innerHeight - reserveBottom() - 12 };
      if (ghostRef.current) ghostRef.current.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`;
      turnRef.current = null;
      setPaused(false);
      setPhase("demo");
      setLine(stepLine(steps[Math.max(0, Math.min(steps.length - 1, first))]));
      setIndex(Math.max(0, Math.min(steps.length - 1, first)));
      setMode(next);
      setRun((r) => r + 1);
    },
    [reserveBottom, router, steps],
  );

  const stop = useCallback(
    (next: Mode) => {
      if (okTimer.current) clearTimeout(okTimer.current);
      light(null);
      turnRef.current = null;
      if (ghostRef.current) ghostRef.current.style.opacity = "0";
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
    if (request.kind === "welcome") setMode("welcome");
    else if (request.kind === "resume") begin("try", performance.now(), request.step, false);
    else begin(request.mode, request.at, request.step);
    // Each request is handled once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id, request?.kind]);

  const skip = useCallback(() => {
    if (mode !== "one") save({ type: "dismiss" });
    // Put back anything the demonstration had open.
    if (phaseRef.current === "demo") void closeOverlays(hooks(new AbortController().signal)).catch(() => {});
    stop("none");
  }, [hooks, mode, stop]);

  const later = useCallback(() => {
    save({ type: "later" });
    stop("none");
  }, [stop]);

  const finishWatch = useCallback(() => {
    save({ type: "complete" });
    stop("none");
  }, [stop]);

  const back = useCallback(() => {
    if (index === 0) return;
    if (okTimer.current) clearTimeout(okTimer.current);
    setPhase("demo");
    setLine(stepLine(steps[index - 1]));
    setIndex(index - 1);
    setRun((r) => r + 1);
  }, [index, steps]);

  // ---- one step: demonstrate, then (try) hand it over ---------------------------
  useEffect(() => {
    if (!running) return;
    const ac = new AbortController();
    const h = hooks(ac.signal);
    const current = steps[index];
    (async () => {
      setPhase("demo");
      setLine(stepLine(current));
      setAnnounce(`${mode === "watch" ? "" : `Step ${index + 1} of ${steps.length}. `}${stepLine(current)}`);
      const ahead = () => {
        for (const s of steps.slice(index + 1, index + 2)) router.prefetch(s.path, FULL);
      };
      // A save clears the router cache, so the next page is fetched after it.
      if (mode === "try") void save({ type: "step", step: index }).then(ahead);
      else ahead();
      const t0 = performance.now();
      h.stats.netMs = 0;
      const demo = await demonstrate(h, current);
      const ms = Math.round(performance.now() - t0);
      // How long the demonstration took, and how much of that was the server.
      sheetRef.current?.setAttribute("data-net-ms", String(Math.round(h.stats.netMs)));
      sheetRef.current?.setAttribute("data-demo-ms", String(ms));
      sheetRef.current?.setAttribute("data-demo-step", String(index));
      setLine(demo.line);
      setActKind(demo.act.kind);
      if (mode === "watch") {
        watchNetRef.current += h.stats.netMs;
        const elapsed = performance.now() - watchStartRef.current - watchNetRef.current;
        const left = steps.length - index;
        const hold = (WATCH_MS - elapsed - (left - 1) * TYPICAL_DEMO_MS) / left;
        await sleep(h, Math.max(1800, Math.min(7000, hold)));
        if (index + 1 < steps.length) setIndex(index + 1);
        else {
          light(null);
          if (ghostRef.current) ghostRef.current.style.opacity = "0";
          sheetRef.current?.setAttribute("data-watch-ms", String(Math.round(performance.now() - watchStartRef.current)));
          setMode("watch-end");
        }
        return;
      }
      // The pointer steps aside while the page is put back: the rest is the person's.
      if (ghostRef.current) ghostRef.current.style.opacity = "0";
      await undo(h, demo);
      if (demo.act.kind === "drop") {
        // Let the sample be seen, then clear it: the drop zone is empty for the person.
        await sleep(h, 700);
        if (sampleTimer.current) clearTimeout(sampleTimer.current);
        setSampleBox(null);
      }
      turnRef.current = { demo, chain: turnChain(current, demo) };
      setAnnounce(`Your turn. ${demo.line}`);
      setPhase("turn");
    })().catch((error) => {
      if (!(error instanceof TourAborted)) console.error("tour step failed", error);
    });
    return () => ac.abort();
    // `run` replays the same step (Back, restart).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, index, run]);

  // ---- your turn: wait for the person to do it ----------------------------------------
  useEffect(() => {
    if (phase !== "turn" || !running) return;
    const turn = turnRef.current;
    if (!turn) return;
    const ac = new AbortController();
    const h = hooks(ac.signal);
    const act = turn.demo.act;
    let link = 0;
    let finished = false;

    const lightLink = async () => {
      const el = await waitFor(h, () => find(turn.chain[link]), 6000);
      light(el);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.top < 56 || r.bottom > window.innerHeight - reserveBottom() || r.left < 0 || r.right > window.innerWidth) {
          el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
        }
        // The pointer steps aside so the element is clearly the person's.
        if (ghostRef.current) ghostRef.current.style.opacity = "0";
        if (focusable(el)) el.focus({ preventScroll: true });
      }
    };
    void lightLink().catch(() => {});

    const complete = () => {
      if (finished) return;
      finished = true;
      setPhase("ok");
      setAnnounce("Done.");
      okTimer.current = setTimeout(() => {
        if (mode === "one") {
          stop("none");
          return;
        }
        if (index + 1 < steps.length) {
          setPhase("demo");
          setLine(stepLine(steps[index + 1]));
          setIndex(index + 1);
        } else {
          save({ type: "complete" });
          stop("done");
        }
      }, 520);
    };
    const inLit = (e: Event) => {
      const el = litRef.current;
      return !!el && e.target instanceof Node && el.contains(e.target);
    };
    const onClick = (e: MouseEvent) => {
      if (!inLit(e)) return;
      if (act.kind === "drop") {
        // Never a real upload during the tour: the sample lands instead.
        e.preventDefault();
        e.stopPropagation();
        showSample(litRef.current!);
        complete();
        return;
      }
      if (act.kind === "search") return; // done when they press Enter
      if (link < turn.chain.length - 1) {
        link += 1;
        void lightLink().catch(() => {});
        return;
      }
      complete();
    };
    const onSubmit = (e: SubmitEvent) => {
      if (act.kind !== "search") return;
      const form = e.target as HTMLFormElement;
      const el = litRef.current;
      if (!el || !form.contains(el)) return;
      // Same results, without reloading the page under the tour.
      e.preventDefault();
      e.stopPropagation();
      submitGet(h, form);
      complete();
    };
    const onDragOver = (e: DragEvent) => {
      if (act.kind === "drop" && inLit(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (act.kind !== "drop" || !inLit(e)) return;
      e.preventDefault();
      e.stopPropagation();
      showSample(litRef.current!);
      complete();
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("submit", onSubmit, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      ac.abort();
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [phase, running, mode, index, run, hooks, light, reserveBottom, showSample, steps, stop]);

  // ---- follow the lit element every frame (transforms only) --------------------
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let last = "";
    const tick = () => {
      const lit = litRef.current;
      const ring = ringRef.current;
      const r = lit && lit.isConnected ? lit.getBoundingClientRect() : null;
      // Padded ring, kept inside the viewport (a phone tab sits flush with the edge).
      const box = r && r.width > 0 && r.height > 0 ? ringBox(r) : null;
      const turn = phaseRef.current !== "demo";
      if (ring) {
        const key = box ? `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)},${phaseRef.current}` : "none";
        if (key !== last) {
          last = key;
          if (box) {
            ring.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`;
            ring.style.width = `${box.width}px`;
            ring.style.height = `${box.height}px`;
            ring.style.opacity = "1";
          } else ring.style.opacity = "0";
          ring.dataset.phase = phaseRef.current;
          // Shield: during a demonstration the page is the cursor's; on the
          // person's turn only the lit element can be pressed.
          const [t, b, lft, rgt] = shieldRefs.current;
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const hole = turn && box ? box : null;
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
      }
      // The sheet never sits on the lit element.
      const sheet = sheetRef.current;
      if (sheet && box) {
        const h = sheet.offsetHeight;
        const vh = window.innerHeight;
        const phoneNow = window.matchMedia(PHONE).matches;
        const w = phoneNow ? window.innerWidth : Math.min(480, window.innerWidth - 32);
        const left = (window.innerWidth - w) / 2;
        const bottomBox = { top: vh - (phoneNow ? 72 : 24) - h, left, width: w, height: h };
        const topBox = { top: phoneNow ? 72 : 80, left, width: w, height: h };
        const next = overlap(box, bottomBox) > 0 && overlap(box, topBox) < overlap(box, bottomBox) ? "top" : "bottom";
        setPlace((p) => (p === next ? p : next));
      } else if (!box) setPlace((p) => (p === "bottom" ? p : "bottom"));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  // Keep the sheet's top-placement offset right for its current height.
  const [sheetShift, setSheetShift] = useState(0);
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || place === "bottom") {
      setSheetShift(0);
      return;
    }
    const h = sheet.offsetHeight;
    const vh = window.innerHeight;
    setSheetShift(phone ? -(vh - 72 - h - 72) : -(vh - 24 - h - 80));
  }, [place, phone, mode, phase, line]);

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
      else if (mode === "watch-end") finishWatch();
      else if (mode === "done") stop("none");
      else skip();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, later, finishWatch, skip, stop]);

  useEffect(() => {
    if (!mounted || mode === "none") return;
    const id = requestAnimationFrame(() => {
      if (mode === "welcome" || mode === "done" || mode === "watch-end" || mode === "watch") primaryRef.current?.focus({ preventScroll: true });
      else if (phase === "demo") sheetRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [mounted, mode, phase, index]);

  if (!mounted || mode === "none") return null;

  const btn = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-input px-4 text-sm font-medium transition-colors motion-hover lg:min-h-10";
  const primaryBtn = cn(btn, "bg-pigment text-surface hover:opacity-90", focusRing);
  const secondaryBtn = cn(btn, "border border-line bg-surface text-ink hover:bg-canvas", focusRing);
  const quiet = cn("inline-flex min-h-11 items-center rounded-input px-2.5 text-sm text-slate transition-colors motion-hover hover:text-ink lg:min-h-8", focusRing);
  const card = mode === "welcome" || mode === "done" || mode === "watch-end";

  return createPortal(
    <div data-tour-root="" data-tour-mode={mode}>
      {running && (
        <>
          {/* Blocks stray presses: all of the page while the cursor works, all but the lit element on the person's turn. */}
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              ref={(el) => {
                shieldRefs.current[i] = el;
              }}
              aria-hidden="true"
              data-tour-shield=""
              onClick={() => {
                // A press outside on your turn: nudge toward the lit element.
                const ring = ringRef.current;
                if (phaseRef.current === "turn" && ring && !reducedRef.current) {
                  ring.animate([{ scale: "1.06" }, { scale: "1" }], { duration: 220, easing: EASE });
                }
              }}
              className="fixed left-0 top-0 z-[70] w-0 h-0"
            />
          ))}
          <div
            ref={ringRef}
            aria-hidden="true"
            data-tour-ring=""
            className={cn(
              "pointer-events-none fixed left-0 top-0 z-[71] rounded-card opacity-0 transition-[opacity,box-shadow] duration-[220ms] ease-standard",
              "outline outline-2 outline-pigment",
              phase === "turn" && "shadow-[0_0_0_9999px_color-mix(in_srgb,var(--color-ink)_22%,transparent)]",
              phase === "ok" && "outline-sage",
            )}
          />
          {sampleBox && (
            <div
              key={sampleBox.key}
              aria-hidden="true"
              data-tour-sample=""
              className="pointer-events-none fixed z-[72] flex items-center justify-center gap-2 rounded-input border border-dashed border-pigment bg-pigment-soft text-sm font-medium text-ink [animation:alpha-toast-in_220ms_var(--ease-standard)]"
              style={{ top: sampleBox.top, left: sampleBox.left, width: sampleBox.width, height: sampleBox.height }}
            >
              <SamplePortrait className="h-10 w-8 shrink-0" />
              <span className="truncate">sample-portrait.jpg</span>
              <Check size={16} className="shrink-0 text-sage" />
            </div>
          )}
          {/* The ghost pointer: an arrow on a laptop, a tap ring on a phone. */}
          <div
            ref={ghostRef}
            aria-hidden="true"
            data-tour-ghost=""
            className="pointer-events-none fixed left-0 top-0 z-[74] opacity-0 transition-opacity duration-[120ms]"
            style={{ transform: "translate3d(-100px,-100px,0)" }}
          >
            <div ref={pressRef} className={finger ? "-translate-x-1/2 -translate-y-1/2" : ""} style={{ transformOrigin: finger ? "50% 50%" : "0 0" }}>
              {finger ? (
                <div className="size-10 rounded-full border-2 border-pigment bg-pigment/15 shadow-md" />
              ) : (
                <svg width="22" height="26" viewBox="0 0 22 26" className="drop-shadow-md">
                  <path d="M1.5 1.5v19.2l5.1-4.6 3.4 8 3.3-1.4-3.4-7.9h7z" fill="var(--color-pigment)" stroke="var(--color-surface)" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <div ref={carryRef} className="absolute left-4 top-4 opacity-0 transition-opacity duration-[120ms]">
              <SamplePortrait className="h-12 w-10 drop-shadow-md" />
            </div>
          </div>
          <div ref={rippleRef} aria-hidden="true" className="pointer-events-none fixed left-0 top-0 z-[73]">
            <div className="size-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-pigment/40 opacity-0" />
          </div>
        </>
      )}

      {/* The sheet: one line, and the quiet way out. */}
      <div
        className={cn(
          "pointer-events-none fixed inset-x-0 z-[75] flex justify-center px-2 transition-transform duration-[220ms] ease-standard lg:px-4",
          "bottom-[calc(4rem+8px)] lg:bottom-6",
        )}
        style={{ transform: `translate3d(0, ${sheetShift}px, 0)` }}
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
          data-act={actKind}
          data-place={place}
          className={cn(
            "pointer-events-auto w-full rounded-modal bg-surface shadow-lg outline-none [animation:alpha-toast-in_220ms_var(--ease-standard)]",
            card ? "max-w-md p-4 lg:p-5" : "max-w-[30rem] px-4 py-3",
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
              <p className="text-sm text-slate">See how your day works in 30 seconds.</p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="button" onClick={() => begin("try", performance.now())} className={secondaryBtn}>
                  Try it myself
                </button>
                <button ref={primaryRef} type="button" onClick={() => begin("watch", performance.now())} className={primaryBtn}>
                  Watch how it works
                </button>
              </div>
            </div>
          )}

          {mode === "watch-end" && (
            <div className="flex flex-col gap-3">
              <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
                That is the whole day.
              </h2>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="button" onClick={finishWatch} className={secondaryBtn}>
                  Got it
                </button>
                <button ref={primaryRef} type="button" onClick={() => begin("try", performance.now())} className={primaryBtn}>
                  Now you try
                </button>
              </div>
            </div>
          )}

          {mode === "done" && (
            <div className="flex flex-col gap-3">
              <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
                You are ready.
              </h2>
              <p className="text-sm text-slate">The ? at the top brings this back any time.</p>
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

          {mode === "watch" && (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-3">
                <button
                  ref={primaryRef}
                  type="button"
                  aria-label={paused ? "Play" : "Pause"}
                  aria-pressed={paused}
                  onClick={() => setPaused((p) => !p)}
                  className={cn("flex size-11 shrink-0 items-center justify-center rounded-full bg-pigment-soft text-pigment transition-colors motion-hover hover:bg-pigment hover:text-surface lg:size-10", focusRing)}
                >
                  {paused ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M7 4.5v15l12-7.5z" />
                    </svg>
                  ) : (
                    <Pause size={16} />
                  )}
                </button>
                <p id={titleId} className="min-w-0 flex-1 text-base font-medium text-ink">
                  {line}
                </p>
                <button type="button" onClick={skip} className={cn(quiet, "-mr-2 shrink-0")}>
                  Close
                </button>
              </div>
              <div className="flex gap-1" aria-hidden="true">
                {steps.map((s, i) => (
                  <span key={s.id} className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                    <span className={cn("block h-full origin-left rounded-full bg-pigment transition-transform duration-[400ms] ease-standard", i < index ? "scale-x-100" : i === index ? "scale-x-50" : "scale-x-0")} />
                  </span>
                ))}
              </div>
            </div>
          )}

          {(mode === "try" || mode === "one") && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs text-slate">
                {mode === "try" && (
                  <span className="tabular-nums">
                    {index + 1} of {steps.length}
                  </span>
                )}
                {phase === "turn" && <span className="rounded-full bg-pigment-soft px-2 py-0.5 font-medium text-pigment" data-tour-your-turn="">Your turn</span>}
                {phase === "ok" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-sage/10 px-2 py-0.5 font-medium text-sage">
                    <Check size={12} /> Done
                  </span>
                )}
                <span className="ml-auto -mr-2 flex items-center">
                  {mode === "try" && index > 0 && (
                    <button type="button" onClick={back} className={quiet}>
                      Back
                    </button>
                  )}
                  <button type="button" onClick={skip} className={quiet}>
                    Skip
                  </button>
                </span>
              </div>
              <p id={titleId} className="text-base font-medium text-ink">
                {line}
              </p>
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
