"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { cn, styleLabel } from "@/lib/utils";
import { Avatar, Button, Disclosure, StatusChip, useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { AlertTriangle, Brush, Camera, Check, X } from "@/components/ui/icons";
import { Countdown } from "./countdown";
import {
  cardLabels,
  describeEvent,
  designerStateLabel,
  eventActor,
  LABEL_CLASS,
  optionName,
  relativeTime,
  revisionNote,
} from "./card-meta";
import {
  loadCard,
  postComment,
  presignCardAssetUploads,
  saveCardAssetUploads,
  type CardAssetType,
} from "@/app/(app)/board/actions";
import type { BoardCard } from "@/lib/orders/board-data";
import { isWithCustomer, SENT_BACK_FROM } from "@/lib/orders/board-constants";
import type { CardDetail, CardEvent, CardImage } from "@/lib/orders/card-detail";
import { formatAt, formatDeadline } from "@/lib/time";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// The same types the server accepts (lib/storage/r2.ts ALLOWED_IMAGE_TYPES): a
// file outside them is refused here, in plain words, before any upload starts.
const UPLOAD_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;
const UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif";
type ViewerRole = "admin" | "va" | "designer";
type UploadProgress = {
  name: string;
  loaded: number;
  total: number;
  status: "queued" | "uploading" | "done" | "failed";
};

const dateFmt = {
  format: (value: Date | string | number) =>
    formatAt(value, { weekday: "short", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }),
};

export function CardModal({
  card,
  viewerRole,
  timeZone,
  onClose,
  onSubmitForQc,
  onStart,
}: {
  card: BoardCard;
  viewerRole: ViewerRole;
  /** The designer's zone; their deadline is shown in it (staff keep the app zone). */
  timeZone?: string;
  onClose: () => void;
  /** Designer only: send the card to Awaiting QC from here (true = moved). */
  onSubmitForQc?: () => Promise<boolean>;
  /** Designer only: start a queued card from here (true = moved). */
  onStart?: () => Promise<boolean>;
}) {
  const toast = useToast();
  const router = useRouter();
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
  const designerView = viewerRole === "designer";
  // A designer reads their own words for a queued card ("In your queue").
  const chipLabel = designerView ? designerStateLabel(card.status) : undefined;
  // Passed QC or complete: nothing left on the designer's clock.
  const designerDone = designerView && (card.status === "complete" || isWithCustomer(card.status));

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
          // Phone: the work (upload, photos, notes) first, the details panel
          // after it; status and deadline sit under the title instead.
          "relative z-10 my-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-modal bg-surface shadow-lg md:flex-row",
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
            "absolute right-3 top-3 z-20 inline-flex size-11 items-center justify-center rounded-input bg-surface/80 text-slate backdrop-blur md:size-8",
            "transition-colors motion-hover hover:bg-canvas hover:text-ink",
            focusRing,
          )}
        >
          <X size={18} />
        </button>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 space-y-5 overflow-y-auto p-5 md:max-h-[85vh]">
            <div className="space-y-1 pr-8">
              <p className="text-xs font-medium text-slate">Order {card.orderNumber}</p>
              <h2 className="font-display text-xl font-semibold text-ink">
                {card.title ?? "Custom portrait"}
              </h2>
              <div className="flex flex-wrap items-center gap-2 pt-1 md:hidden">
                <StatusChip status={card.status} label={chipLabel} />
                {/* A designer's finished part has no clock: the chip says where it is. */}
                {!designerDone && (
                  <Countdown
                    dueAt={viewerRole === "designer" ? card.dueAt : card.orderDueAt}
                    done={card.status === "complete"}
                    withCustomer={viewerRole === "designer" && isWithCustomer(card.status)}
                  />
                )}
              </div>
            </div>
            <CardUploadPanel
              card={card}
              viewerRole={viewerRole}
              detail={detail}
              onSaved={(next) => {
                setDetail(next);
                setEvents(next.events);
                // The board card behind learns it now has a version to submit.
                router.refresh();
              }}
              onSubmitForQc={
                onSubmitForQc
                  ? async () => {
                      if (await onSubmitForQc()) onClose();
                    }
                  : undefined
              }
              onStart={onStart}
            />

            {/* What to fix sits right under the upload, before the photos:
                it is the first thing a designer back on this card needs. */}
            {revision && (
              <RevisionBlock
                kind={card.qcFail ? "qc" : "customer"}
                reason={revision.reason}
                failedItems={revision.failedItems}
                annotations={revision.annotations ?? []}
                pinImageUrl={pinnedVersionUrl(detail, events)}
              />
            )}

            <Gallery images={detail?.images ?? null} cover={card.thumbnailUrl} />

            {card.options.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {card.options.map((o, i) => (
                  <li
                    key={i}
                    className="rounded bg-canvas px-2 py-1 text-xs text-slate"
                  >
                    <span className="text-ink">{optionName(o.name)}:</span> {o.value}
                  </li>
                ))}
              </ul>
            )}

            {card.notes && (
              <Disclosure summary="Notes and special requests" defaultOpen className="bg-amber/5 shadow-none">
                <p className="whitespace-pre-wrap text-sm text-ink">{card.notes}</p>
              </Disclosure>
            )}

            <Disclosure
              summary="Activity"
              hint={detail === null ? "loading" : `${events.length} event${events.length === 1 ? "" : "s"}`}
              defaultOpen={events.length <= 6}
              className="bg-canvas/60 shadow-none"
            >
              <div className="flex flex-col gap-3">
                {detail === null ? (
                  <FeedSkeleton />
                ) : events.length === 0 ? (
                  <p className="text-sm text-slate">No activity yet.</p>
                ) : (
                  events.map((e) => <FeedItem key={e.id} event={e} viewerRole={viewerRole} />)
                )}
              </div>
            </Disclosure>
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
              <Button size="sm" className="max-md:h-11" onClick={send} loading={posting} disabled={!draft.trim()}>
                Send
              </Button>
            </div>
            {/* A keyboard shortcut means nothing on a phone. */}
            <p className="mt-1 hidden px-1 text-xs text-slate md:block">⌘/Ctrl + Enter to send</p>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="shrink-0 space-y-4 border-t border-line bg-canvas/40 p-4 md:w-64 md:border-t-0 md:border-l">
          <Meta label="Status">
            <StatusChip status={card.status} label={chipLabel} />
          </Meta>
          {viewerRole === "designer" ? (
            // The designer's own deadline (their assignment), never the
            // customer SLA; gone once their part is done (the status says so).
            !designerDone && <Meta label="Your deadline">
              <DueLine
                dueAt={card.dueAt}
                done={card.status === "complete"}
                withCustomer={isWithCustomer(card.status)}
                timeZone={timeZone}
              />
            </Meta>
          ) : (
            <>
              <Meta label="Customer due">
                <DueLine dueAt={card.orderDueAt} done={card.status === "complete"} />
              </Meta>
              {card.assignmentDueAt && (
                <Meta label="Designer due">
                  <DueLine dueAt={card.assignmentDueAt} done={card.status === "complete"} />
                </Meta>
              )}
            </>
          )}
          {labels.length > 0 && (
            <Meta label="Labels">
              <div className="flex flex-wrap gap-1">
                {labels.map((l, i) => (
                  <span
                    key={i}
                    className={cn(
                      "inline-flex max-w-full truncate rounded px-1.5 py-0.5 text-xs font-medium",
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
              {card.figuresResolved ? card.figureCount : "Not set yet"}
              {card.style ? ` · ${styleLabel(card.style)}` : ""}
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

function CardUploadPanel({
  card,
  viewerRole,
  detail,
  onSaved,
  onSubmitForQc,
  onStart,
}: {
  card: BoardCard;
  viewerRole: ViewerRole;
  detail: CardDetail | null;
  onSaved: (detail: CardDetail) => void;
  onSubmitForQc?: () => Promise<void>;
  onStart?: () => Promise<boolean>;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const designer = viewerRole === "designer";
  const canDesignerUpload = card.status === "in_design";
  const [type, setType] = useState<CardAssetType>(designer ? "submission" : "reference");
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const submissions = (detail?.images ?? []).filter((image) => image.type === "submission");
  const latestSubmission = submissions.at(-1) ?? null;
  // After a send-back (QC fail, revision) the old versions no longer count:
  // the server refuses Submit for QC until a newer version is uploaded.
  const lastSendBack = (detail?.events ?? [])
    .filter((e) => e.toState === "in_design" && e.fromState && (SENT_BACK_FROM as readonly string[]).includes(e.fromState))
    .reduce<string | null>((max, e) => (!max || e.createdAt > max ? e.createdAt : max), null);
  const freshVersion =
    !!latestSubmission && (!lastSendBack || Date.parse(latestSubmission.createdAt) > Date.parse(lastSendBack));
  const canUpload = !designer || canDesignerUpload;
  // Why a designer can't upload right now, in the card's own terms: a card
  // that hasn't been started is NOT locked, it just needs starting first.
  const designerNote =
    card.status === "ready_to_assign"
      ? "Start this card, then add the finished portrait here."
      : card.status === "awaiting_qc"
        ? "Sent for QC. If it comes back, add a new version here."
        : card.status === "complete"
          ? "Finished. Nothing more to do here."
          : "Passed QC. Nothing more to do here.";
  const designerHint = !canDesignerUpload
    ? designerNote
    : freshVersion
      ? "Ready for QC. To change it first, add a new version."
      : latestSubmission
        ? "Add a new version with the changes, then submit it for QC."
        : "Add the finished portrait, then submit it for QC.";

  useEffect(() => {
    if (designer) setType("submission");
  }, [designer]);

  async function upload(files: File[]) {
    if (!canUpload) {
      toast({ variant: "warning", title: "Upload not open", description: designerNote });
      return;
    }
    const images = files.filter((file) => UPLOAD_TYPES.test(file.type));
    const refused = files.find((file) => !UPLOAD_TYPES.test(file.type));
    if (refused) {
      // One wrong file stops the lot, so nothing half-uploads without the person noticing.
      toast({
        variant: "danger",
        title: "That file can't be added",
        description: `${refused.name} is not a PNG, JPG, WebP or HEIC image. Save it as a PNG or JPG and try again.`,
      });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (!images.length) return;
    const empty = images.find((file) => file.size === 0);
    if (empty) {
      toast({ variant: "danger", title: "That file is empty", description: `${empty.name} has nothing in it. Choose the saved image again.` });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    const tooBig = images.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (tooBig) {
      toast({ variant: "danger", title: "That file is too big", description: `${tooBig.name} is over 25 MB. Save a smaller copy (a full-size JPG is usually well under) and add that.` });
      if (fileRef.current) fileRef.current.value = "";
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
      // The new version now shows in the strip below; the finished progress
      // bar would only repeat it.
      setProgress([]);
      toast({
        variant: "success",
        title:
          designer && type === "submission"
            ? images.length === 1
              ? "New version added"
              : `${images.length} new versions added`
            : images.length === 1
              ? "Photo uploaded"
              : `${images.length} photos uploaded`,
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
    <section className="rounded-card bg-canvas/60 p-3" data-tour="card:upload">
      <div className="flex flex-wrap items-end gap-2">
        {designer ? (
          // Two buttons (Submit for QC, Add new version) get a row of their
          // own under the text instead of one wrapping on its own.
          <div className={cn("min-w-40 flex-1", canDesignerUpload && freshVersion && "basis-full")}>
            <span className="text-sm font-medium text-ink">Finished portrait</span>
            <p className="mt-0.5 text-sm text-slate">{designerHint}</p>
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
        {/* No upload control at all while a designer can't upload: the note
            above says what to do instead. */}
        {/* A designer's queued card starts right here (no need to close the
            card and find the board button, or drag on a laptop). */}
        {designer && card.status === "ready_to_assign" && onStart && (
          <Button
            type="button"
            size="sm"
            className="max-md:h-11 max-md:w-full"
            loading={starting}
            onClick={async () => {
              setStarting(true);
              try {
                await onStart();
              } finally {
                setStarting(false);
              }
            }}
          >
            <Brush size={15} />
            Start
          </Button>
        )}
        {/* On a phone the big tap area below is the upload control, so the
            same action is not offered twice; a laptop keeps the button. */}
        {canUpload && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            // After Submit for QC when both show (the main action first).
            className={cn("max-md:h-11", designer && "order-last max-md:hidden")}
            loading={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Camera size={15} />
            {/* Versions are never overwritten: each upload adds one. */}
            {latestSubmission && designer ? "Add new version" : "Upload"}
          </Button>
        )}
        {designer && canDesignerUpload && freshVersion && onSubmitForQc && (
          <Button
            type="button"
            size="sm"
            className="max-md:h-11 max-md:w-full"
            loading={submitting}
            disabled={uploading}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onSubmitForQc();
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <Check size={15} />
            Submit for QC
          </Button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          multiple
          className="hidden"
          onChange={(event) => event.target.files && void upload(Array.from(event.target.files))}
        />
      </div>
      {canUpload && (
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          data-tour="card:drop"
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
          {uploading ? (
            "Uploading..."
          ) : (
            <>
              {/* Nobody drags files on a phone: there it is simply a tap target. */}
              <span className="md:hidden">
                {designer ? (latestSubmission ? "Tap to add a new version" : "Tap to add the finished portrait") : "Tap to add images"}
              </span>
              <span className="hidden md:inline">
                {designer
                  ? latestSubmission
                    ? "Drop a new version here or click Add new version"
                    : "Drop finished portrait here or click Upload"
                  : "Drop images here or click Upload"}
              </span>
            </>
          )}
        </button>
      )}
      {progress.length > 0 && (
        <div className="mt-3 space-y-2">
          {progress.map((row, i) => {
            const pct = row.total > 0 ? Math.round((row.loaded / row.total) * 100) : 0;
            return (
              <div key={`${i}-${row.name}`} className="space-y-1">
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
          <p className="mb-2 text-xs font-medium text-ink">Portrait versions ({submissions.length}), newest last</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {submissions.map((image, index) => (
              <div key={image.id} className="w-20 shrink-0">
                <a href={image.url} target="_blank" rel="noopener noreferrer" aria-label="Open this version full size">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.url} alt="" className="size-20 rounded-input border border-line object-cover" />
                </a>
                <p className="mt-1 truncate text-xs text-slate">
                  {`v${index + 1}${index === submissions.length - 1 ? ", latest" : ""}`}
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

function DueLine({
  dueAt,
  done = false,
  withCustomer = false,
  timeZone,
}: {
  dueAt: string | null;
  done?: boolean;
  withCustomer?: boolean;
  timeZone?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2">
      <Countdown dueAt={dueAt} done={done} withCustomer={withCustomer} />
      {dueAt && !withCustomer && (
        <span className="text-xs text-slate">{timeZone ? formatDeadline(dueAt, timeZone) : dateFmt.format(new Date(dueAt))}</span>
      )}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-slate">{label}</p>
      {children}
    </div>
  );
}

function Gallery({ images, cover }: { images: CardImage[] | null; cover: string | null }) {
  // Before detail loads, show the cover we already have from the card.
  // Portrait versions live in the Finished portrait strip above, so they are
  // not repeated here: this is what the customer sent.
  const list = (images ?? (cover ? [{ id: "cover", type: "reference" as const, url: cover, uploadedBy: null, createdAt: "" }] : [])).filter(
    (img) => img.type !== "submission",
  );
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
      <p className="text-sm font-medium text-ink">{list.every((img) => img.type === "reference") ? "Customer photos" : "Photos"}</p>
      <a href={hero.url} target="_blank" rel="noopener noreferrer" aria-label="Open photo full size" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={hero.url}
          alt=""
          className="max-h-72 w-full rounded-card border border-line bg-canvas object-contain"
        />
      </a>
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {rest.map((img) => (
            <a key={img.id} href={img.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${img.type} photo full size`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.type} className="size-16 rounded-input border border-line object-cover" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The version the customer put their pins on: the newest one from before the
 * latest revision request. Once a fixed version is added, the pins still sit
 * on the proof they were dropped on, not on the fix.
 */
function pinnedVersionUrl(detail: CardDetail | null, events: CardEvent[]): string | null {
  const versions = (detail?.images ?? []).filter((img) => img.type === "submission");
  const asked = events
    .filter((e) => e.toState === "in_design" && e.fromState === "awaiting_approval")
    .reduce<number>((max, e) => Math.max(max, Date.parse(e.createdAt)), 0);
  const before = asked ? versions.filter((v) => Date.parse(v.createdAt) <= asked) : versions;
  return (before.at(-1) ?? versions.at(-1))?.url ?? null;
}

function RevisionBlock({
  kind,
  reason,
  failedItems,
  annotations,
  pinImageUrl,
}: {
  kind: "qc" | "customer";
  reason: string | null;
  failedItems: string[];
  annotations: { x: number; y: number }[];
  pinImageUrl: string | null;
}) {
  const qc = kind === "qc";
  const note = revisionNote(reason, failedItems);
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
      {/* The person's own words first: they say what to change. The ticked
          checks follow as the detail. */}
      {note && <p className="text-sm text-ink">&ldquo;{note}&rdquo;</p>}
      {failedItems.length > 0 && (
        <ul className="ml-5 list-outside list-disc space-y-0.5 text-sm text-slate">
          {failedItems.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {annotations.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-ink">
            The customer marked {annotations.length} spot{annotations.length === 1 ? "" : "s"} on the proof:
          </p>
          {pinImageUrl ? (
            <div className="relative overflow-hidden rounded-input border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pinImageUrl} alt="Latest submission with revision pins" className="block w-full" />
              {annotations.map((p, i) => (
                <span
                  key={i}
                  className="pointer-events-none absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-pigment text-xs font-semibold text-surface shadow-md ring-2 ring-surface"
                  style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                >
                  {i + 1}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate">Pin positions were saved but no portrait image is available to show them on.</p>
          )}
        </div>
      )}
    </div>
  );
}

function FeedItem({ event, viewerRole }: { event: CardEvent; viewerRole: ViewerRole }) {
  const actor = eventActor(event);
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

  const desc = describeEvent(event, viewerRole);
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
