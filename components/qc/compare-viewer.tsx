"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui";
import { Minus, Plus, Search } from "@/components/ui/icons";
import type { QcImage } from "@/lib/qc/data";

type Transform = { scale: number; x: number; y: number };

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

function clampScale(s: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * Side-by-side reference vs. delivered portrait with SYNCED zoom and pan: a
 * single transform drives both panes, so zooming or dragging either side shows
 * the same magnification of the same region on the other — the core QC gesture.
 *
 * Wheel/pinch zooms toward the cursor; drag pans; double-click resets.
 */
export function CompareViewer({
  references,
  portrait,
  portraitLabel,
}: {
  references: QcImage[];
  portrait: string | null;
  portraitLabel: string;
}) {
  const [t, setT] = useState<Transform>(IDENTITY);
  const [refIndex, setRefIndex] = useState(0);
  // Phone only: tap "Enlarge" on a pane to see it full screen.
  const [enlarged, setEnlarged] = useState<{ label: string; image: string } | null>(null);
  const dragging = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );

  const reference = references[refIndex]?.url ?? null;

  const reset = useCallback(() => setT(IDENTITY), []);

  // Zoom toward a point given in pane-centre-relative coordinates.
  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setT((prev) => {
      const scale = clampScale(prev.scale * factor);
      if (scale === prev.scale) return prev;
      if (scale === 1) return IDENTITY;
      // Keep the point under the cursor fixed: screen = translate + scale*point.
      const x = cx - ((cx - prev.x) / prev.scale) * scale;
      const y = cy - ((cy - prev.y) / prev.scale) * scale;
      return { scale, x, y };
    });
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = { startX: e.clientX, startY: e.clientY, origX: t.x, origY: t.y };
    },
    [t.x, t.y],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragging.current;
    if (!d) return;
    setT((prev) => ({
      ...prev,
      x: d.origX + (e.clientX - d.startX),
      y: d.origY + (e.clientY - d.startY),
    }));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging.current) {
      dragging.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  }, []);

  const zoomed = t.scale > 1;
  const many = references.length > 1;

  // Left / right arrows flip through the customer's photos (never while typing).
  useEffect(() => {
    if (!many) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setRefIndex((i) => (i + step + references.length) % references.length);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [many, references.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Every photo the customer sent, up top where it cannot be missed. */}
      {many && (
        <div
          className="rounded-card border border-pigment/25 bg-pigment-soft/60 p-2.5"
          data-testid="customer-photo-strip"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-2">
            <p className="text-sm font-semibold text-ink">
              Customer sent {references.length} photos
            </p>
            <p className="text-xs text-slate">
              Showing photo {refIndex + 1} of {references.length}
              <span className="hidden sm:inline"> · use ← → to switch</span>
            </p>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-0.5" role="group" aria-label="Customer photos">
            {references.map((r, i) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRefIndex(i)}
                aria-label={`Customer photo ${i + 1} of ${references.length}`}
                aria-pressed={i === refIndex}
                className={cn(
                  "relative size-16 shrink-0 overflow-hidden rounded-input border-2 bg-surface transition-all motion-hover sm:size-[4.5rem]",
                  i === refIndex
                    ? "border-pigment ring-2 ring-pigment/40"
                    : "border-transparent opacity-70 hover:opacity-100",
                )}
              >
                {r.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.url} alt="" className="size-full object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center text-xs text-slate">?</span>
                )}
                <span
                  className={cn(
                    "absolute bottom-0.5 left-0.5 rounded-chip px-1.5 text-xs font-semibold leading-5",
                    i === refIndex ? "bg-pigment text-surface" : "bg-ink/70 text-surface",
                  )}
                >
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-slate">
          <Search size={14} />
          <span className="tabular-nums">{Math.round(t.scale * 100)}%</span>
          <span className="hidden sm:inline">· scroll to zoom, drag to move, both pictures move together</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => zoomAt(0, 0, 1 / 1.4)}
            aria-label="Zoom out"
            className="min-w-11 sm:min-w-0"
          >
            <Minus size={14} />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => zoomAt(0, 0, 1.4)}
            aria-label="Zoom in"
            className="min-w-11 sm:min-w-0"
          >
            <Plus size={14} />
          </Button>
          <Button size="sm" variant="ghost" onClick={reset} disabled={!zoomed}>
            Reset
          </Button>
        </div>
      </div>

      {/* Panes */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
        <Pane
          label={many ? `Customer photo ${refIndex + 1} of ${references.length}` : "Customer photo"}
          image={reference}
          transform={t}
          zoomed={zoomed}
          onZoom={zoomAt}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
          onEnlarge={setEnlarged}
        />
        <Pane
          label={portraitLabel}
          image={portrait}
          transform={t}
          zoomed={zoomed}
          onZoom={zoomAt}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
          onEnlarge={setEnlarged}
        />
      </div>

      {enlarged && (
        <div
          role="dialog"
          aria-label={`${enlarged.label} enlarged`}
          className="fixed inset-0 z-50 flex flex-col bg-ink/90 p-3 md:hidden"
          onClick={() => setEnlarged(null)}
        >
          <div className="flex items-center justify-between pb-2 text-sm text-white">
            <span>{enlarged.label}</span>
            <Button size="sm" variant="secondary" onClick={() => setEnlarged(null)}>Close</Button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enlarged.image} alt={enlarged.label} className="min-h-0 flex-1 object-contain" />
        </div>
      )}
    </div>
  );
}

function Pane({
  label,
  image,
  transform,
  zoomed,
  onZoom,
  onEnlarge,
  ...handlers
}: {
  label: string;
  image: string | null;
  transform: Transform;
  zoomed: boolean;
  /** Zoom toward a point given in pane-centre-relative coordinates. */
  onZoom: (cx: number, cy: number, factor: number) => void;
  onEnlarge: (v: { label: string; image: string }) => void;
} & Pick<
  React.HTMLAttributes<HTMLDivElement>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onDoubleClick"
>) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Native, non-passive wheel listener — React registers onWheel as passive, so
  // preventDefault there is a no-op and the page would scroll instead of zoom.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      onZoom(cx, cy, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [onZoom]);

  return (
    <div className="flex h-[22rem] flex-col overflow-hidden md:h-auto md:min-h-[26rem] rounded-card bg-surface shadow-card">
      <div className="flex items-center justify-between border-b border-line/70 px-3 py-1.5">
        <span className="min-w-0 break-words text-sm font-semibold leading-tight text-ink">{label}</span>
        {image && (
          <button
            type="button"
            onClick={() => onEnlarge({ label, image })}
            className="-my-1.5 inline-flex min-h-11 shrink-0 items-center pl-2 text-sm font-medium text-pigment md:hidden"
          >
            Enlarge
          </button>
        )}
      </div>
      <div
        ref={surfaceRef}
        {...handlers}
        className={cn(
          "relative min-h-0 flex-1 touch-pan-y select-none md:touch-none overflow-hidden bg-canvas",
          zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
        )}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={label}
            draggable={false}
            className="absolute inset-0 size-full object-contain"
            style={{
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
              transformOrigin: "center",
            }}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-slate">
            No image
          </div>
        )}
      </div>
    </div>
  );
}
