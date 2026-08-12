"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { Avatar, Button, StatusChip, useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { AlertTriangle, Camera, X } from "@/components/ui/icons";
import { Countdown } from "./countdown";
import {
  cardLabels,
  describeEvent,
  LABEL_CLASS,
  relativeTime,
} from "./card-meta";
import {
  loadCard,
  postComment,
  presignCardAssetUploads,
  saveCardAssetUploads,
  type CardAssetType,
} from "@/app/(app)/board/actions";
import type { BoardCard } from "@/lib/orders/board-data";
import type { CardDetail, CardEvent, CardImage } from "@/lib/orders/card-detail";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
type ViewerRole = "admin" | "va" | "designer";
type UploadProgress = {
  name: string;
  loaded: number;
  total: number;
  status: "queued" | "uploading" | "done" | "failed";
};

const dateFmt = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function CardModal({
  card,
  viewerRole,
  onClose,
}: {
  card: BoardCard;
  viewerRole: ViewerRole;
  onClose: () => void;
}) {
  const toast = useToast();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [events, setEvents] = useState<CardEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  // Enter animation.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // ESC + scroll lock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Lazy-load the history + images when the card opens.
  useEffect(() => {
    let alive = true;
    loadCard(card.orderId)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setEvents(d.events);
      })
      .catch(() => alive && toast({ variant: "danger", title: "Couldn’t load card history" }));
    return () => {
      alive = false;
    };
  }, [card.orderId, toast]);

  async function send() {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    const res = await postComment(card.orderId, text);
    setPosting(false);
    if (res.ok) {
      setEvents((e) => [...e, res.event]);
      setDraft("");
    } else {
      toast({ variant: "danger", title: "Message not sent", description: res.message });
    }
  }

  const labels = cardLabels(card);
  const revision = card.qcFail ?? card.customerRevision;

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      <div
        onClick={onClose}
        className={cn(
          "fixed inset-0 bg-ink/40 transition-opacity motion-layout",
          visible ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${card.orderNumber}`}
        className={cn(
          "relative z-10 my-auto flex w-full max-w-3xl flex-col-reverse overflow-hidden rounded-modal bg-surface shadow-lg md:flex-row",
          "transition-[opacity,transform] motion-layout",
          visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2",
        )}
      >
        {/* Close — floats above both columns. */}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={cn(
            "absolute right-3 top-3 z-20 inline-flex size-8 items-center justify-center rounded-input bg-surface/80 text-slate backdrop-blur",
            "transition-colors motion-hover hover:bg-canvas hover:text-ink",
            focusRing,
          )}
        >
          <X size={18} />
        </button>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 space-y-5 overflow-y-auto p-5 md:max-h-[85vh]">
            <Gallery images={detail?.images ?? null} cover={card.thumbnailUrl} />
            <CardUploadPanel
              card={card}
              viewerRole={viewerRole}
              detail={detail}
              onSaved={(next) => {
                setDetail(next);
                setEvents(next.events);
              }}
            />

            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-slate">
                Order {card.orderNumber}
              </p>
              <h2 className="font-display text-xl font-semibold text-ink">
                {card.title ?? "Custom portrait"}
              </h2>
            </div>

            {card.options.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {card.options.map((o, i) => (
                  <li
                    key={i}
                    className="rounded bg-canvas px-2 py-1 text-xs text-slate"
                  >
                    <span className="text-ink">{o.name}:</span> {o.value}
                  </li>
                ))}
              </ul>
            )}

            {card.notes && (
              <Section title="Notes / special requests">
                <p className="whitespace-pre-wrap rounded-input bg-amber/5 p-3 text-sm text-ink">
                  {card.notes}
                </p>
              </Section>
            )}

            {revision && (
              <RevisionBlock
                kind={card.qcFail ? "qc" : "customer"}
                reason={revision.reason}
                failedItems={revision.failedItems}
              />
            )}

            <Section title="Activity">
              <div className="flex flex-col gap-3">
                {detail === null ? (
                  <FeedSkeleton />
                ) : events.length === 0 ? (
                  <p className="text-sm text-slate">No activity yet.</p>
                ) : (
                  events.map((e) => <FeedItem key={e.id} event={e} />)
                )}
              </div>
            </Section>
          </div>

          {/* Composer — pinned under the feed. */}
          <div className="border-t border-line p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder="Write a message to the team…"
                className={cn(
                  "min-h-[2.5rem] flex-1 resize-none rounded-input border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-slate",
                  focusRing,
                )}
              />
              <Button size="sm" onClick={send} loading={posting} disabled={!draft.trim()}>
                Send
              </Button>
            </div>
            <p className="mt-1 px-1 text-[11px] text-slate">⌘/Ctrl + Enter to send</p>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="shrink-0 space-y-4 border-b border-line bg-canvas/40 p-4 md:w-64 md:border-b-0 md:border-l">
          <Meta label="Status">
            <StatusChip status={card.status} />
          </Meta>
          <Meta label="Due">
            <div className="flex items-center gap-2">
              <Countdown dueAt={card.dueAt} />
              {card.dueAt && (
                <span className="text-xs text-slate">
                  {dateFmt.format(new Date(card.dueAt))}
                </span>
              )}
            </div>
          </Meta>
          {labels.length > 0 && (
            <Meta label="Labels">
              <div className="flex flex-wrap gap-1">
                {labels.map((l, i) => (
                  <span
                    key={i}
                    className={cn(
                      "inline-flex max-w-full truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
                      LABEL_CLASS[l.tone],
                    )}
                  >
                    {l.text}
                  </span>
                ))}
              </div>
            </Meta>
          )}
          <Meta label="Order number">
            <span className="text-sm text-ink">{card.orderNumber}</span>
          </Meta>
          <Meta label="Customer">
            <span className="text-sm text-ink">{card.customerName}</span>
          </Meta>
          <Meta label="Figures">
            <span className="text-sm text-ink">
              {card.figuresResolved ? card.figureCount : "Unresolved"}
              {card.style ? ` · ${card.style}` : ""}
            </span>
          </Meta>
          <Meta label="Source">
            <span className="text-sm capitalize text-ink">{card.source}</span>
          </Meta>
        </aside>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate">{title}</h3>
      {children}
    </section>
  );
}

function CardUploadPanel({
  card,
  viewerRole,
  detail,
  onSaved,
}: {
  card: BoardCard;
  viewerRole: ViewerRole;
  detail: CardDetail | null;
  onSaved: (detail: CardDetail) => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const designer = viewerRole === "designer";
  const canDesignerUpload = card.status === "in_design";
  const [type, setType] = useState<CardAssetType>(designer ? "submission" : "reference");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const submissions = (detail?.images ?? []).filter((image) => image.type === "submission");
  const latestSubmission = submissions.at(-1) ?? null;
  const canUpload = !designer || canDesignerUpload;

  useEffect(() => {
    if (designer) setType("submission");
  }, [designer]);

  async function upload(files: File[]) {
    if (!canUpload) {
      toast({
        variant: "warning",
        title: "Upload locked",
        description: "Finished portraits cannot be changed after the card leaves design.",
      });
      return;
    }
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      toast({ variant: "danger", title: "No images selected" });
      return;
    }
    const tooBig = images.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (tooBig) {
      toast({ variant: "danger", title: "Upload too large", description: `${tooBig.name} is over 25 MB.` });
      return;
    }

    setUploading(true);
    setProgress(images.map((file) => ({ name: file.name, loaded: 0, total: file.size, status: "queued" })));
    try {
      const presigned = await presignCardAssetUploads({
        orderId: card.orderId,
        type,
        files: images.map((file) => ({
          filename: file.name,
          contentType: file.type,
          size: file.size,
        })),
      });
      if (!presigned.ok) throw new Error(presigned.message);

      await Promise.all(
        presigned.uploads.map(async (target, index) => {
          await uploadToR2(target.uploadUrl, images[index], (loaded, total) => {
            setProgress((rows) =>
              rows.map((row, i) =>
                i === index ? { ...row, loaded, total, status: loaded >= total ? "done" : "uploading" } : row,
              ),
            );
          });
        }),
      );

      const saved = await saveCardAssetUploads({
        orderId: card.orderId,
        type,
        r2Keys: presigned.uploads.map((target) => target.key),
      });
      if (!saved.ok) throw new Error(saved.message);
      onSaved(saved.detail);
      toast({
        variant: "success",
        title: images.length === 1 ? "Photo uploaded" : `${images.length} photos uploaded`,
      });
      if (fileRef.current) fileRef.current.value = "";
    } catch (error) {
      setProgress((rows) => rows.map((row) => (row.status === "done" ? row : { ...row, status: "failed" })));
      toast({
        variant: "danger",
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Could not upload photos",
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="rounded-card border border-line bg-canvas/60 p-3">
      <div className="flex flex-wrap items-end gap-2">
        {designer ? (
          <div className="min-w-40 flex-1">
            <span className="text-xs font-medium text-ink">Finished portrait</span>
            <p className="mt-1 text-xs text-slate">
              {canDesignerUpload
                ? latestSubmission
                  ? "Upload another version before submitting to QC. The newest version is reviewed first."
                  : "Upload the finished portrait before moving this card to QC."
                : "Uploads are locked after the card leaves design."}
            </p>
          </div>
        ) : (
          <label className="flex min-w-40 flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-ink">Add photos</span>
            <select
              value={type}
              disabled={uploading}
              onChange={(event) => setType(event.currentTarget.value as CardAssetType)}
              className={cn(
                "h-9 rounded-input border border-line bg-surface px-2.5 text-sm text-ink",
                focusRing,
              )}
            >
              <option value="reference">Reference photos</option>
              <option value="submission">Portrait upload</option>
              <option value="final">Final portrait</option>
            </select>
          </label>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={uploading}
          disabled={!canUpload}
          onClick={() => fileRef.current?.click()}
        >
          <Camera size={15} />
          {latestSubmission && designer ? "Replace" : "Upload"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => event.target.files && void upload(Array.from(event.target.files))}
        />
      </div>
      <button
        type="button"
        disabled={uploading || !canUpload}
        onClick={() => fileRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void upload(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "mt-3 flex h-16 w-full items-center justify-center gap-2 rounded-input border border-dashed border-line bg-surface text-sm text-slate",
          "transition-colors hover:border-pigment/40 hover:text-ink disabled:pointer-events-none disabled:opacity-60",
          focusRing,
        )}
      >
        <Camera size={16} />
        {uploading
          ? "Uploading..."
          : designer
            ? canDesignerUpload
              ? "Drop finished portrait here or click Upload"
              : "Uploads locked after QC"
            : "Drop images here or click Upload"}
      </button>
      {progress.length > 0 && (
        <div className="mt-3 space-y-2">
          {progress.map((row) => {
            const pct = row.total > 0 ? Math.round((row.loaded / row.total) * 100) : 0;
            return (
              <div key={row.name} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-ink">{row.name}</span>
                  <span className={row.status === "failed" ? "text-rose" : "text-slate"}>
                    {row.status === "done" ? "Done" : row.status === "failed" ? "Failed" : `${pct}%`}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-line">
                  <div
                    className={cn("h-full rounded-full", row.status === "failed" ? "bg-rose" : "bg-pigment")}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {submissions.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium text-ink">Portrait versions</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {submissions.map((image, index) => (
              <div key={image.id} className="w-20 shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.url} alt="" className="size-20 rounded-input border border-line object-cover" />
                <p className="mt-1 truncate text-[11px] text-slate">
                  {index === submissions.length - 1 ? "Latest" : `v${index + 1}`}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function uploadToR2(
  url: string,
  file: File,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size, file.size);
        resolve();
      } else {
        reject(new Error(`Upload failed for ${file.name}`));
      }
    };
    xhr.onerror = () => reject(new Error(`Upload failed for ${file.name}`));
    xhr.send(file);
  });
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate">{label}</p>
      {children}
    </div>
  );
}

function Gallery({ images, cover }: { images: CardImage[] | null; cover: string | null }) {
  // Before detail loads, show the cover we already have from the card.
  const list = images ?? (cover ? [{ id: "cover", type: "reference" as const, url: cover, uploadedBy: null, createdAt: "" }] : []);
  if (list.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 rounded-card border border-dashed border-line bg-canvas text-slate">
        <Camera size={18} />
        <span className="text-sm">No photos yet</span>
      </div>
    );
  }
  const [hero, ...rest] = list;
  return (
    <div className="space-y-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={hero.url}
        alt=""
        className="max-h-72 w-full rounded-card border border-line object-cover"
      />
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {rest.map((img) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={img.id}
              src={img.url}
              alt={img.type}
              className="size-16 rounded-input border border-line object-cover"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RevisionBlock({
  kind,
  reason,
  failedItems,
}: {
  kind: "qc" | "customer";
  reason: string | null;
  failedItems: string[];
}) {
  const qc = kind === "qc";
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-input border p-3",
        qc ? "border-rose/20 bg-rose/10" : "border-pigment/20 bg-pigment-soft",
      )}
    >
      <span
        className={cn(
          "flex items-center gap-1.5 text-sm font-semibold",
          qc ? "text-rose" : "text-pigment",
        )}
      >
        <AlertTriangle size={14} className="shrink-0" />
        {qc ? "QC failed" : "Revision requested"}
      </span>
      {failedItems.length > 0 && (
        <ul className="ml-1 list-inside list-disc text-sm text-ink">
          {failedItems.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {reason && <p className="text-sm italic text-slate">&ldquo;{reason}&rdquo;</p>}
    </div>
  );
}

function FeedItem({ event }: { event: CardEvent }) {
  const actor = event.actorName ?? "System";
  const when = relativeTime(event.createdAt);

  if (event.action === "comment") {
    return (
      <div className="flex gap-2.5">
        <Avatar name={actor} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <span className="font-semibold text-ink">{actor}</span>{" "}
            <span className="text-slate">· {when}</span>
          </p>
          <div className="mt-1 whitespace-pre-wrap rounded-input rounded-tl-none bg-canvas p-2.5 text-sm text-ink">
            {event.body}
          </div>
        </div>
      </div>
    );
  }

  const desc = describeEvent(event);
  const reason = typeof event.metadata?.reason === "string" ? event.metadata.reason : null;
  const failed = Array.isArray(event.metadata?.failedItems)
    ? (event.metadata!.failedItems as string[])
    : [];

  return (
    <div className="flex gap-2.5">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-line" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate">
          <span className="font-medium text-ink">{actor}</span> {desc}{" "}
          <span className="text-slate">· {when}</span>
        </p>
        {failed.length > 0 && (
          <ul className="ml-1 mt-0.5 list-inside list-disc text-xs text-slate">
            {failed.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        )}
        {reason && <p className="mt-0.5 text-xs italic text-slate">&ldquo;{reason}&rdquo;</p>}
      </div>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-2.5">
          <span className="size-7 shrink-0 rounded-full bg-canvas" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-1/3 rounded bg-canvas" />
            <div className="h-3 w-2/3 rounded bg-canvas" />
          </div>
        </div>
      ))}
    </div>
  );
}
