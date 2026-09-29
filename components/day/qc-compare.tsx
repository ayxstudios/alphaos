"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { Button, Textarea, useToast } from "@/components/ui";
import { Check, X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { tourIsRunning } from "@/lib/tour/live";
import { approveQcAction, bounceQcAction } from "@/app/(app)/day/actions";
import type { ChecklistItem } from "@/lib/qc/checklist";

type Img = { id: string; url: string | null };

/** Each chip points at one QC check, so the bounce keeps its failed check. */
const REASONS: { key: number; label: string }[] = [
  { key: 1, label: "Face not matching" },
  { key: 3, label: "Colors off" },
  { key: 4, label: "Text wrong" },
  { key: 2, label: "Wrong number of people or pets" },
  { key: 5, label: "Hands or edges look bad" },
];

/** One picture. Tap to zoom in, tap again to zoom out. When zoomed, drag to move. */
function ZoomPane({ image, alt, caption }: { image: Img | null; alt: string; caption: string }) {
  const [zoom, setZoom] = useState({ on: false, x: 0, y: 0 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  useEffect(() => setZoom({ on: false, x: 0, y: 0 }), [image?.id]);

  return (
    <figure className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
      <figcaption className="text-xs font-semibold uppercase tracking-wide text-slate">{caption}</figcaption>
      <div
        data-tour="qc-pane"
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-lg bg-canvas ring-1 ring-line/70"
        onPointerDown={(e) => {
          drag.current = { sx: e.clientX, sy: e.clientY, ox: zoom.x, oy: zoom.y, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !zoom.on) return;
          const dx = e.clientX - d.sx;
          const dy = e.clientY - d.sy;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          setZoom({ on: true, x: d.ox + dx, y: d.oy + dy });
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d || d.moved) return;
          if (zoom.on) return setZoom({ on: false, x: 0, y: 0 });
          const box = e.currentTarget.getBoundingClientRect();
          // Zoom toward the spot that was tapped.
          const x = (box.width / 2 - (e.clientX - box.left)) * 1.5;
          const y = (box.height / 2 - (e.clientY - box.top)) * 1.5;
          setZoom({ on: true, x, y });
        }}
      >
        {image?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt={alt}
            draggable={false}
            className="size-full object-contain transition-transform duration-150"
            style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.on ? 2.5 : 1})` }}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-slate">No picture</div>
        )}
        {image?.url && (
          <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-ink/70 px-2 py-0.5 text-xs text-surface">
            {zoom.on ? "Tap to zoom out" : "Tap to zoom in"}
          </span>
        )}
      </div>
    </figure>
  );
}

export function QcCompare({
  orderId,
  orderNumber,
  buyerPhotos,
  portrait,
  checklist,
  kind,
}: {
  orderId: string;
  orderNumber: string;
  buyerPhotos: Img[];
  portrait: Img | null;
  checklist: ChecklistItem[];
  kind: "portrait" | "revision";
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const [photoIx, setPhotoIx] = useState(0);
  const [fixing, setFixing] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [which, setWhich] = useState<"ok" | "fix" | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const have = new Set(checklist.map((c) => c.key));
  const chips = REASONS.filter((r) => have.has(r.key));
  const photo = buyerPhotos[photoIx] ?? null;

  function done(res: { ok: boolean; message: string }) {
    toast({ variant: res.ok ? "success" : "danger", title: res.message });
    if (res.ok) setOpen(false);
    else setError(res.message);
    router.refresh();
  }

  function looksGood() {
    setError(null);
    if (tourIsRunning()) return toast({ variant: "success", title: "That approves it. Nothing was sent in the tour." });
    setWhich("ok");
    start(async () => done(await approveQcAction(orderId)));
  }

  function needsFix() {
    setError(null);
    if (tourIsRunning()) return toast({ variant: "success", title: "That sends it back. Nothing was sent in the tour." });
    if (picked.length === 0) return setError("Tap what is wrong.");
    const text = [...chips.filter((c) => picked.includes(c.key)).map((c) => c.label), note.trim()].filter(Boolean).join(". ");
    setWhich("fix");
    start(async () => done(await bounceQcAction(orderId, text, picked)));
  }

  const buyerPane = (
    <ZoomPane key="buyer" image={photo} alt={`Buyer photo ${photoIx + 1}`} caption={`Buyer photo${buyerPhotos.length > 1 ? ` ${photoIx + 1} of ${buyerPhotos.length}` : ""}`} />
  );
  const portraitPane = <ZoomPane key="portrait" image={portrait} alt="Finished portrait" caption={kind === "revision" ? "New version" : "Portrait"} />;

  const modal = open && (
    <div role="dialog" aria-modal="true" aria-label={`Compare ${orderNumber}`} className="fixed inset-0 z-[60] flex flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="min-w-0 flex-1 truncate font-display text-base font-semibold text-ink">Compare {orderNumber}</h2>
        <Button type="button" variant="secondary" size="md" className="min-h-11" onClick={() => setSwapped((s) => !s)} data-tour="qc-swap">
          Swap sides
        </Button>
        <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="grid size-11 place-items-center rounded-input text-slate hover:bg-canvas">
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 md:flex-row md:p-4">
        {swapped ? [portraitPane, buyerPane] : [buyerPane, portraitPane]}
      </div>

      {buyerPhotos.length > 1 && (
        <div className="flex gap-2 overflow-x-auto px-3 pb-2">
          {buyerPhotos.map((p, i) => (
            <button
              key={p.id}
              type="button"
              aria-label={`Show buyer photo ${i + 1}`}
              onClick={() => setPhotoIx(i)}
              className={cn("size-12 shrink-0 overflow-hidden rounded-md ring-2", i === photoIx ? "ring-pigment" : "ring-transparent")}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.url && <img src={p.url} alt="" className="size-full object-cover" />}
            </button>
          ))}
        </div>
      )}

      <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto border-t border-line bg-surface p-3 md:p-4">
        {fixing && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-ink">What is wrong? Tap one or more.</p>
            <div className="flex flex-wrap gap-2" data-tour="qc-reasons">
              {chips.map((c) => {
                const on = picked.includes(c.key);
                return (
                  <button
                    key={c.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPicked((p) => (on ? p.filter((k) => k !== c.key) : [...p, c.key]))}
                    className={cn(
                      "min-h-11 rounded-full border px-4 text-sm",
                      on ? "border-rose/40 bg-rose/10 font-medium text-ink" : "border-line bg-canvas text-slate",
                    )}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            <Textarea label="More detail (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={800} placeholder="Tell the designer what to change" />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          {fixing ? (
            <>
              <Button type="button" variant="danger" size="lg" className="min-h-14 w-full text-base sm:flex-1" loading={pending && which === "fix"} disabled={pending} onClick={needsFix}>
                Send back to designer
              </Button>
              <Button type="button" variant="secondary" size="lg" className="min-h-14 w-full sm:w-auto" disabled={pending} onClick={() => setFixing(false)}>
                Back
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="lg" className="min-h-14 w-full bg-sage text-base text-surface sm:flex-1" loading={pending && which === "ok"} disabled={pending} onClick={looksGood} data-tour="qc-good">
                <Check size={18} aria-hidden="true" /> Looks good
              </Button>
              <Button type="button" variant="secondary" size="lg" className="min-h-14 w-full text-base sm:flex-1" disabled={pending} onClick={() => setFixing(true)} data-tour="qc-fix">
                Needs a fix
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <Button type="button" size="lg" variant="secondary" className="min-h-11 w-full sm:w-auto" onClick={() => setOpen(true)} data-tour="day-compare">
        Compare
      </Button>
      {mounted && modal ? createPortal(modal, document.body) : null}
    </>
  );
}
