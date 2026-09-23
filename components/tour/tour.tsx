"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, X } from "@/components/ui/icons";
import type { Role } from "@/lib/auth/config";
import { TOUR_STEPS, stepPath, stepsSentence, type TourStep } from "@/lib/tour/steps";
import { tourOpening, type OnboardingState, type TourEvent } from "@/lib/tour/state";
import { recordTourEvent } from "@/app/(app)/help/actions";

/** Fired by the "?" menu and the Quick guide to (re)start the tour. */
export const TOUR_START_EVENT = "alphaos:tour-start";

type Mode = "none" | "welcome" | "tour" | "done";
type Via = "page" | "nav" | "tab" | "more" | null;
type Box = { top: number; left: number; width: number; height: number };

const SHEET_QUERY = "(max-width: 1023px)"; // below lg the app is in phone layout (bottom tabs)
const GAP = 14;
const EDGE = 12;
const PAD = 6; // spotlight breathing room around the target

/**
 * The spotlight around a target, padded but kept inside the viewport: a
 * target flush with the screen edge (the phone's bottom tab bar) would
 * otherwise push the ring off screen.
 */
function spotBox(r: DOMRect): Box {
  const ring = 2; // the 2px outline is drawn outside the box
  const top = Math.max(ring, r.top - PAD);
  const left = Math.max(ring, r.left - PAD);
  const bottom = Math.min(window.innerHeight - ring, r.bottom + PAD);
  const right = Math.min(window.innerWidth - ring, r.right + PAD);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function isShown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
}

/** First visible element for a key; `key` may list fallbacks, comma separated. */
function findTarget(key: string | undefined): { el: HTMLElement; key: string } | null {
  if (!key) return null;
  for (const one of key.split(",").map((k) => k.trim()).filter(Boolean)) {
    const all = document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(one)}"]`);
    for (const el of all) if (isShown(el)) return { el, key: one };
  }
  return null;
}

/** The element to light for this step: on-page first, then the nav, then the phone tab, then More. */
function resolveTarget(step: TourStep, pathname: string): { el: HTMLElement | null; via: Via; key: string | null } {
  const path = stepPath(step);
  const onPage = pathname === path || pathname.startsWith(path + "/");
  const order: [string | undefined, Via][] = [
    [onPage ? step.page : undefined, "page"],
    [step.nav, "nav"],
    [step.tab, "tab"],
    ["tab:more", "more"],
  ];
  for (const [key, via] of order) {
    const hit = findTarget(key);
    if (hit) return { el: hit.el, via, key: hit.key };
  }
  return { el: null, via: null, key: null };
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

type CardPlace =
  | { kind: "float"; top: number; left: number; width: number }
  | { kind: "sheet"; bottom: number; lifted: boolean }
  | { kind: "sheet-top" };

/** Laptop: beside the target, never on top of it. Phone: a bottom sheet that steps aside for the target. */
function placeCard(target: Box | null, card: { w: number; h: number }, sheet: boolean): CardPlace {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (sheet) {
    if (!target) return { kind: "sheet", bottom: 0, lifted: false };
    // Target in the bottom tab bar: lift the sheet to sit just above it.
    if (target.top > vh - 88) return { kind: "sheet", bottom: Math.max(0, vh - target.top + 10), lifted: true };
    const sheetBox = { top: vh - card.h, left: 0, width: vw, height: card.h };
    if (overlapArea(target, sheetBox) === 0) return { kind: "sheet", bottom: 0, lifted: false };
    return { kind: "sheet-top" };
  }
  const width = Math.min(360, vw - EDGE * 2);
  if (!target) return { kind: "float", top: Math.max(EDGE, vh / 2 - card.h / 2), left: vw / 2 - width / 2, width };
  const clampTop = (t: number) => Math.max(EDGE, Math.min(vh - card.h - EDGE, t));
  const clampLeft = (l: number) => Math.max(EDGE, Math.min(vw - width - EDGE, l));
  const midTop = clampTop(target.top + target.height / 2 - card.h / 2);
  const candidates = [
    { top: midTop, left: target.left + target.width + GAP }, // right (sidebar items)
    { top: target.top + target.height + GAP, left: clampLeft(target.left) }, // below
    { top: target.top - card.h - GAP, left: clampLeft(target.left) }, // above
    { top: midTop, left: target.left - width - GAP }, // left
  ];
  for (const c of candidates) {
    const box = { top: c.top, left: c.left, width, height: card.h };
    const inside = c.top >= EDGE && c.left >= EDGE && c.top + card.h <= vh - EDGE && c.left + width <= vw - EDGE;
    if (inside && overlapArea(box, target) === 0) return { kind: "float", top: c.top, left: c.left, width };
  }
  // A target bigger than the gaps around it: the corner that covers it least.
  const corners = [
    { top: EDGE, left: EDGE },
    { top: EDGE, left: vw - width - EDGE },
    { top: vh - card.h - EDGE, left: EDGE },
    { top: vh - card.h - EDGE, left: vw - width - EDGE },
  ];
  let best = corners[0];
  let bestArea = Infinity;
  for (const c of corners) {
    const area = overlapArea({ top: c.top, left: c.left, width, height: card.h }, target);
    if (area < bestArea) {
      best = c;
      bestArea = area;
    }
  }
  return { kind: "float", top: best.top, left: best.left, width };
}

function sameBox(a: Box | null, b: Box | null) {
  if (!a || !b) return a === b;
  return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

function samePlace(a: CardPlace | null, b: CardPlace | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function save(event: TourEvent) {
  // Fire and forget: the tour never waits on (or breaks because of) a save.
  void recordTourEvent(event).catch(() => {});
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Tour({
  role,
  firstName,
  onboarding,
  signedInAt,
}: {
  role: Role;
  firstName: string;
  onboarding: OnboardingState | null;
  signedInAt: number;
}) {
  const steps = TOUR_STEPS[role];
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<Mode>(() => {
    const open = tourOpening(onboarding, signedInAt);
    return open.kind === "welcome" ? "welcome" : open.kind === "resume" ? "tour" : "none";
  });
  const [index, setIndex] = useState(() => {
    const open = tourOpening(onboarding, signedInAt);
    return open.kind === "resume" ? Math.min(open.step, steps.length - 1) : 0;
  });
  const [sheet, setSheet] = useState(false);
  const [spot, setSpot] = useState<Box | null>(null);
  const [via, setVia] = useState<Via>(null);
  const [litKey, setLitKey] = useState<string | null>(null);
  const [place, setPlace] = useState<CardPlace | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const litRef = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const step = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const mq = window.matchMedia(SHEET_QUERY);
    const sync = () => setSheet(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const clearLit = useCallback(() => {
    litRef.current?.removeAttribute("data-tour-lit");
    litRef.current = null;
  }, []);

  const close = useCallback(
    (next: Mode) => {
      clearLit();
      setSpot(null);
      setPlace(null);
      setMode(next);
      if (next === "none") {
        const back = returnFocus.current;
        returnFocus.current = null;
        if (back && document.contains(back)) back.focus();
      }
    },
    [clearLit],
  );

  const begin = useCallback(() => {
    if (!returnFocus.current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    save({ type: "start" });
    setIndex(0);
    setMode("tour");
  }, []);

  // "?" menu -> Show me around, and the Quick guide's button.
  useEffect(() => {
    const onStart = () => begin();
    window.addEventListener(TOUR_START_EVENT, onStart);
    return () => window.removeEventListener(TOUR_START_EVENT, onStart);
  }, [begin]);

  const goTo = useCallback(
    (i: number) => {
      const next = Math.max(0, Math.min(steps.length - 1, i));
      setIndex(next);
      save({ type: "step", step: next });
    },
    [steps.length],
  );

  const next = useCallback(() => {
    if (last) {
      save({ type: "complete" });
      close("done");
    } else goTo(index + 1);
  }, [close, goTo, index, last]);

  const skip = useCallback(() => {
    save({ type: "dismiss" });
    close("none");
  }, [close]);

  const later = useCallback(() => {
    save({ type: "later" });
    close("none");
  }, [close]);

  // Follow the target every frame while the tour is open: it survives
  // navigation (Try it), streaming pages, scrolling and resizing.
  useEffect(() => {
    if (mode !== "tour" || !mounted) return;
    let frame = 0;
    let scrolledFor: HTMLElement | null = null;
    const tick = () => {
      const found = resolveTarget(step, window.location.pathname);
      if (found.el !== litRef.current) {
        litRef.current?.removeAttribute("data-tour-lit");
        litRef.current = found.el;
        found.el?.setAttribute("data-tour-lit", "");
      }
      if (found.el && found.el !== scrolledFor) {
        scrolledFor = found.el;
        found.el.scrollIntoView({
          block: found.via === "page" ? "center" : "nearest",
          inline: "nearest",
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
      }
      const r = found.el?.getBoundingClientRect();
      const box = r ? spotBox(r) : null;
      setSpot((prev) => (sameBox(prev, box) ? prev : box));
      setVia((prev) => (prev === found.via ? prev : found.via));
      setLitKey((prev) => (prev === found.key ? prev : found.key));
      const card = cardRef.current;
      if (card) {
        const size = { w: card.offsetWidth, h: card.offsetHeight };
        const p = placeCard(box, size, window.matchMedia(SHEET_QUERY).matches);
        setPlace((prev) => (samePlace(prev, p) ? prev : p));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mode, mounted, step]);

  useEffect(() => {
    if (mode === "none") clearLit();
  }, [mode, clearLit]);
  useEffect(() => () => clearLit(), [clearLit]);

  // Keep keyboard focus on the card's main button whenever it opens or moves on.
  useEffect(() => {
    if (!mounted || mode === "none") return;
    if (mode === "tour" && !returnFocus.current && document.activeElement instanceof HTMLElement) {
      returnFocus.current = document.activeElement;
    }
    const id = requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [mode, index, mounted]);

  // Esc: Skip tour (tour), Later (welcome), close (done). Tab: while the tour
  // card is open (modal) focus stays inside it, wherever focus happened to be;
  // the welcome and done cards are small and non-modal, so Tab can leave them.
  useEffect(() => {
    if (mode === "none") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (mode === "tour") skip();
        else if (mode === "welcome") later();
        else close("none");
        return;
      }
      if (e.key !== "Tab" || mode !== "tour") return;
      const card = cardRef.current;
      if (!card) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"));
      if (items.length === 0) return;
      const active = document.activeElement;
      const at = items.indexOf(active as HTMLElement);
      if (at === -1 || (e.shiftKey && at === 0) || (!e.shiftKey && at === items.length - 1)) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [mode, skip, later, close]);

  if (!mounted || mode === "none") return null;

  const btn = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-input px-4 text-sm font-medium transition-colors motion-hover lg:min-h-10";
  const primaryBtn = cn(btn, "bg-pigment text-surface hover:opacity-90", focusRing);
  const secondaryBtn = cn(btn, "border border-line bg-surface text-ink hover:bg-canvas", focusRing);
  const quietBtn = cn(btn, "px-2 text-slate hover:text-ink", focusRing);

  // Small, non-modal cards: welcome (first sign-in) and done.
  if (mode === "welcome" || mode === "done") {
    const welcome = mode === "welcome";
    return createPortal(
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-tour-welcome={welcome ? "" : undefined}
        data-tour-done={welcome ? undefined : ""}
        className={cn(
          "fixed z-[65] bg-surface shadow-lg [animation:alpha-toast-in_220ms_var(--ease-standard)]",
          "inset-x-0 bottom-0 rounded-t-modal px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4",
          "lg:inset-x-auto lg:bottom-6 lg:right-6 lg:w-[22rem] lg:rounded-modal lg:p-5",
        )}
      >
        <div className="mx-auto flex max-w-lg flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
              {welcome ? `Welcome, ${firstName}.` : "You are ready."}
            </h2>
            {!welcome && (
              <button type="button" aria-label="Close" onClick={() => close("none")} className={cn("-mr-2 -mt-2 flex size-11 shrink-0 items-center justify-center rounded-input text-slate hover:bg-canvas hover:text-ink", focusRing)}>
                <X size={18} />
              </button>
            )}
          </div>
          <p id={bodyId} className="text-sm text-slate">
            {welcome ? stepsSentence(role) : "The ? button at the top brings this tour and the quick guide back any time."}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {welcome ? (
              <>
                <button type="button" onClick={later} className={secondaryBtn}>
                  Later
                </button>
                <button ref={primaryRef} type="button" onClick={begin} className={primaryBtn}>
                  Start
                </button>
              </>
            ) : (
              <>
                <Link href="/help" onClick={() => close("none")} className={secondaryBtn}>
                  Quick guide
                </Link>
                <button ref={primaryRef} type="button" onClick={() => close("none")} className={primaryBtn}>
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const onThisPage = pathname === stepPath(step) || pathname.startsWith(stepPath(step) + "/");
  const cardStyle: React.CSSProperties =
    place?.kind === "float"
      ? { top: place.top, left: place.left, width: place.width }
      : place?.kind === "sheet"
        ? { bottom: place.bottom, left: place.lifted ? 8 : 0, right: place.lifted ? 8 : 0 }
        : place?.kind === "sheet-top"
          ? { top: 8, left: 8, right: 8 }
          : sheet
            ? { bottom: 0, left: 0, right: 0, visibility: "hidden" }
            : { top: 0, left: 0, width: 360, visibility: "hidden" };
  const flatBottom = place?.kind === "sheet" && !place.lifted;

  return createPortal(
    <>
      {/* Catches clicks so the page underneath stays still during the tour. */}
      <div className="fixed inset-0 z-[70]" aria-hidden="true" />
      {spot ? (
        <div
          aria-hidden="true"
          data-tour-spotlight=""
          className="pointer-events-none fixed z-[70] rounded-card transition-[top,left,width,height] duration-[220ms] ease-standard"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            outline: "2px solid var(--color-pigment)",
            outlineOffset: 0,
            boxShadow: "0 0 0 9999px color-mix(in srgb, var(--color-ink) 45%, transparent)",
          }}
        />
      ) : (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[70]" style={{ background: "color-mix(in srgb, var(--color-ink) 45%, transparent)" }} />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-tour-card=""
        data-step={index}
        data-steps={steps.length}
        data-target={litKey ?? ""}
        data-via={via ?? ""}
        data-has-page={step.page ? "true" : "false"}
        style={cardStyle}
        className={cn(
          "fixed z-[71] flex flex-col gap-3 bg-surface p-4 shadow-lg lg:p-5",
          sheet ? "mx-auto max-w-lg" : "rounded-modal",
          sheet && (flatBottom ? "rounded-t-modal pb-[max(1rem,env(safe-area-inset-bottom))]" : "rounded-modal"),
        )}
      >
        <p className="text-xs font-medium text-slate">
          Step {index + 1} of {steps.length}
        </p>
        <div className="flex flex-col gap-1.5" aria-live="polite">
          <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
            {step.title}
          </h2>
          <div id={bodyId} className="flex flex-col gap-1.5">
            <p className="text-sm text-ink">{step.what}</p>
            <p className="text-sm text-slate">{step.how}</p>
            {via === "more" && <p className="text-sm text-slate">On a phone, you will find it under More.</p>}
          </div>
        </div>
        <div className="flex items-center gap-1.5" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.id + i} className={cn("h-1.5 rounded-full transition-[width,background-color] duration-[220ms]", i === index ? "w-5 bg-pigment" : i < index ? "w-1.5 bg-pigment/40" : "w-1.5 bg-line")} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={skip} className={cn(quietBtn, "-ml-2 mr-auto")}>
            Skip tour
          </button>
          {index > 0 && (
            <button type="button" onClick={() => goTo(index - 1)} className={secondaryBtn}>
              Back
            </button>
          )}
          {!onThisPage && (
            <button
              type="button"
              onClick={() => router.push(step.href)}
              className={secondaryBtn}
              aria-label={`Try it: open ${step.title}`}
            >
              Try it <ArrowRight size={14} />
            </button>
          )}
          <button ref={primaryRef} type="button" onClick={next} className={primaryBtn}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
