"use client";

import { cn } from "@/lib/utils";
import type { QcVersion } from "@/lib/qc/data";

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Version history strip: every prior submission in order. The most recent is the
 * one under review; clicking any thumbnail loads it into the right compare pane.
 */
export function VersionStrip({
  versions,
  selectedId,
  onSelect,
}: {
  versions: QcVersion[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (versions.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center rounded-card border border-dashed border-line/80 text-sm text-slate">
        No submissions yet
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2 overflow-x-auto pb-1">
      {versions.map((v, i) => {
        const isLatest = i === versions.length - 1;
        const selected = v.id === selectedId;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onSelect(v.id)}
            aria-pressed={selected}
            className={cn(
              "group flex w-32 shrink-0 flex-col gap-1 rounded-card border p-1.5 text-left transition-colors motion-hover",
              selected
                ? "border-pigment bg-pigment-soft"
                : "border-transparent bg-surface shadow-card hover:border-slate/30",
            )}
          >
            <div className="relative h-16 overflow-hidden rounded-input border border-line bg-canvas">
              {v.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.url} alt="" className="size-full object-cover" />
              ) : (
                <span className="flex size-full items-center justify-center text-xs text-slate">
                  no image
                </span>
              )}
              <span
                className={cn(
                  "absolute left-1 top-1 rounded-chip px-1.5 py-0.5 text-xs font-semibold",
                  isLatest ? "bg-pigment text-surface" : "bg-ink/70 text-surface",
                )}
              >
                {isLatest ? "Latest" : `v${i + 1}`}
              </span>
            </div>
            <span className="truncate text-xs font-medium text-ink">
              {v.uploadedBy ?? "Unknown"}
            </span>
            <span className="truncate text-xs text-slate">{when(v.createdAt)}</span>
          </button>
        );
      })}
    </div>
  );
}
