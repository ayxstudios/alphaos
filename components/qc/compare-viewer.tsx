"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui";
import { Plus, Search } from "@/components/ui/icons";
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-slate">
          <Search size={14} />
          <span className="tabular-nums">{Math.round(t.scale * 100)}%</span>
          <span className="hidden sm:inline">· scroll to zoom, drag to pan (synced)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => zoomAt(0, 0, 1 / 1.4)}
            aria-label="Zoom out"
          >
            −
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => zoomAt(0, 0, 1.4)}
            aria-label="Zoom in"
          >
            <Plus size={14} />
          </Button>
          <Button size="sm" variant="ghost" onClick={reset} disabled={!zoomed}>
            Reset
          </Button>
        </div>
      </div>

      {/* Panes */}
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <Pane
          label="Reference"
          image={reference}
          transform={t}
          zoomed={zoomed}
          onZoom={zoomAt}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
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
        />
      </div>

      {/* Reference thumbnail rail — switch which photo the left pane shows. */}
      {references.length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto">
          <span className="shrink-0 text-xs text-slate">
            {references.length} reference photos:
          </span>
          {references.map((r, i) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRefIndex(i)}
              aria-label={`Reference photo ${i + 1}`}
              aria-pressed={i === refIndex}
              className={cn(
                "size-12 shrink-0 overflow-hidden rounded-input border transition-colors motion-hover",
                i === refIndex ? "border-pigment ring-2 ring-pigment" : "border-line hover:border-slate/50",
              )}
            >
              {r.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.url} alt="" className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-[10px] text-slate">
                  ?
                </span>
              )}
            </button>
          ))}
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
  ...handlers
}: {
  label: string;
  image: string | null;
  transform: Transform;
  zoomed: boolean;
  /** Zoom toward a point given in pane-centre-relative coordinates. */
  onZoom: (cx: number, cy: number, factor: number) => void;
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
    <div className="flex min-h-0 flex-col overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="text-xs font-medium text-slate">{label}</span>
      </div>
      <div
        ref={surfaceRef}
        {...handlers}
        className={cn(
          "relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-canvas",
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
