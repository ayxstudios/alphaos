"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { cn, styleLabel } from "@/lib/utils";
import { Avatar, Button, CopyButton, CopyField, Disclosure, StatusChip, useToast } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { AlertTriangle, Brush, Camera, Check, X } from "@/components/ui/icons";
import { Countdown } from "./countdown";
import { RevisionHistory } from "./revision-history";
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
import { optionsSummary } from "@/lib/orders/options-summary";
import { buildRevisionHistory, revisionCopyText } from "@/lib/orders/revision-history";
import { isWithCustomer, SENT_BACK_FROM } from "@/lib/orders/board-constants";
import type { CardDetail, CardEvent, CardImage } from "@/lib/orders/card-detail";
import { formatAt, formatDeadline } from "@/lib/time";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
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
  const history = useMemo(() => buildRevisionHistory(events), [events]);

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
              {/* The order number copies on its own (designers name files and
                  messages by it), never with the page around it. */}
              <CopyField text={card.orderNumber} what="order number" inline>
                <p className="text-xs font-medium text-slate">
                  Order <span className="select-all text-ink">{card.orderNumber}</span>
                </p>
              </CopyField>
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
                pinGroups={groupPins(revision.annotations ?? [], detail, events)}
              />
            )}

            <Gallery images={detail?.images ?? null} cover={card.thumbnailUrl} />

            {/* What goes ON the art, exactly as the customer typed it, from
                every item, each with its own Copy button. */}
            {card.personalization.length > 0 && (
              <section className="rounded-input bg-canvas px-3 py-2.5" aria-label="Personalization">
                <p className="text-xs font-medium text-slate">Personalization</p>
                <ul className="mt-1.5 flex flex-col gap-2">
                  {card.personalization.map((p, i) => {
                    const caption = [
                      p.item ? `Item ${p.item}` : null,
                      /^personali[sz]ation$/i.test(optionName(p.name)) ? null : optionName(p.name),
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <li key={i}>
                        <CopyField text={p.value} what={caption ? `personalization, ${caption}` : "personalization"}>
                          {caption && <span className="block text-xs text-slate">{caption}</span>}
                          <span className="block select-all whitespace-pre-wrap break-words text-base font-medium text-ink [overflow-wrap:anywhere]">
                            {p.value}
                          </span>
                        </CopyField>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* The shop's options as one human line; every option in full,
                exactly as the customer chose it, is one tap away. */}
            {card.options.length > 0 && (
              <details className="group rounded-input bg-canvas px-3">
                <summary
                  className={cn(
                    "-mx-3 flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-input px-3 py-2 [&::-webkit-details-marker]:hidden",
                    focusRing,
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-slate">Options</span>
                    <span className="block truncate text-sm text-ink group-open:hidden">
                      {optionsSummary(card.options) || `${card.options.length} option${card.options.length === 1 ? "" : "s"}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-medium text-pigment">
                    <span className="group-open:hidden">All options</span>
                    <span className="hidden group-open:inline">Hide</span>
                  </span>
                </summary>
                <dl className="flex flex-col gap-2 pb-3 text-sm">
                  {card.options.map((o, i) => (
                    <div key={i} className="min-w-0">
                      <dt className="text-xs text-slate">{optionName(o.name)}</dt>
                      <dd className="break-words text-ink [overflow-wrap:anywhere]">{o.value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}

            {card.notes && (
              <Disclosure summary="Notes and special requests" defaultOpen className="bg-amber/5 shadow-none">
                <CopyField text={card.notes} what="notes and special requests">
                  <p className="whitespace-pre-wrap break-words text-sm text-ink [overflow-wrap:anywhere]">{card.notes}</p>
                </CopyField>
              </Disclosure>
            )}

            {/* Every QC fail and revision so far, newest first: what was asked
                before stays readable (and copyable) after the next round.
                Folded while the newest one already shows at the top. */}
            {detail !== null && (
              <RevisionHistory
                notes={history}
                timeZone={designerView ? timeZone : undefined}
                defaultOpen={!revision}
              />
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
            <span className="select-all text-sm text-ink">{card.orderNumber}</span>
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
  // Orders with 2+ portraits get a per-portrait upload area: the designer says
  // which portrait a version is, so the strip, QC and the customer's proof all
  // know which is which (Jerome, 2026-10-14).
  const portraits = detail?.portraits ?? [];
  const multiPortrait = portraits.length >= 2;
  const [portraitId, setPortraitId] = useState<string | null>(null);
  const submissions = (detail?.images ?? []).filter((image) => image.type === "submission");
  const latestSubmission = submissions.at(-1) ?? null;
  const portraitNo = new Map(portraits.map((p) => [p.id, p.n]));
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
      ? "Ready. Press Submit for QC, or add a new version first."
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
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      toast({ variant: "danger", title: "No images selected" });
      return;
    }
    const empty = images.find((file) => file.size === 0);
    if (empty) {
      toast({ variant: "danger", title: "Empty file", description: `${empty.name} is empty (0 bytes). Choose the saved image again.` });
      return;
    }
    const tooBig = images.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (tooBig) {
      toast({ variant: "danger", title: "Upload too large", description: `${tooBig.name} is over 25 MB.` });
      return;
    }
    // Portraits (submission/final) on a 2+ portrait order must say which one;
    // reference photos stay order-wide.
    if (multiPortrait && type !== "reference" && !portraitId) {
      toast({
        variant: "warning",
        title: "Which portrait?",
        description: "This order has more than one portrait. Pick which one this upload is for first.",
      });
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

      // A flaky connection (designers send 5 to 10 MB portraits from home
      // Wi-Fi) must not cost the whole upload: every file gets three tries,
      // a stalled transfer is cut off instead of hanging, a refused or stale
      // link is replaced before the next try, and files go two at a time so
      // the later links are still fresh when their turn comes.
      const presignedAt = Date.now();
      const keys = presigned.uploads.map((target) => target.key);
      await runLimited(images.length, PARALLEL_UPLOADS, async (index) => {
        const file = images[index];
        const onProgress = (loaded: number, total: number) =>
          setProgress((rows) =>
            rows.map((row, i) =>
              i === index ? { ...row, loaded, total, status: loaded >= total ? "done" : "uploading" } : row,
            ),
          );
        let target = presigned.uploads[index];
        let issuedAt = presignedAt;
        let lastError: UploadError | null = null;
        for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
          try {
            await uploadToR2(target.uploadUrl, file, onProgress);
            keys[index] = target.key;
            return;
          } catch (error) {
            lastError = error instanceof UploadError ? error : new UploadError(file.name, 0);
            if (attempt === UPLOAD_ATTEMPTS) break;
            setProgress((rows) => rows.map((row, i) => (i === index ? { ...row, loaded: 0, status: "queued" } : row)));
            await sleep(1500 * attempt);
            if (lastError.status === 403 || Date.now() - issuedAt > PRESIGN_REFRESH_MS) {
              const again = await presignCardAssetUploads({
                orderId: card.orderId,
                type,
                files: [{ filename: file.name, contentType: file.type, size: file.size }],
              });
              if (!again.ok) throw new Error(again.message);
              target = again.uploads[0];
              issuedAt = Date.now();
            }
          }
        }
        throw new Error(
          `${(lastError ?? new UploadError(file.name, 0)).message} (tried ${UPLOAD_ATTEMPTS} times). Check your internet and try again.`,
        );
      });

      const saved = await saveCardAssetUploads({
        orderId: card.orderId,
        type,
        r2Keys: keys,
        // Single-portrait orders tag implicitly; multi-portrait uses the pick.
        orderItemId:
          type !== "reference" ? (multiPortrait ? portraitId : (portraits[0]?.id ?? null)) : null,
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
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => event.target.files && void upload(Array.from(event.target.files))}
        />
      </div>
      {/* 2+ portraits on one order: every upload says which portrait it is,
          so versions never blur together as one "latest". */}
      {canUpload && multiPortrait && type !== "reference" && (
        <fieldset className="mt-3">
          <legend className="text-xs font-medium text-ink">
            Which portrait is this upload for?
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {portraits.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={uploading}
                aria-pressed={portraitId === p.id}
                onClick={() => setPortraitId(p.id)}
                title={p.label || undefined}
                className={cn(
                  "flex min-h-9 max-w-full items-center rounded-input border px-2.5 py-1.5 text-sm transition-colors motion-hover",
                  focusRing,
                  portraitId === p.id
                    ? "border-pigment bg-pigment-soft font-medium text-ink"
                    : "border-line bg-surface text-slate hover:border-slate/40 hover:text-ink",
                )}
              >
                <span className="truncate">
                  Portrait {p.n}
                  {p.label ? ` · ${p.label}` : ""}
                </span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
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
          <p className="mb-2 text-xs font-medium text-ink">Portrait versions ({submissions.length}), newest last</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {submissions.map((image, index) => {
              const n = image.orderItemId ? portraitNo.get(image.orderItemId) : undefined;
              return (
                <div key={image.id} className="w-20 shrink-0">
                  <a href={image.url} target="_blank" rel="noopener noreferrer" aria-label="Open this version full size">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.url} alt="" className="size-20 rounded-input border border-line object-cover" />
                  </a>
                  <p className="mt-1 truncate text-xs text-slate">
                    {/* Which portrait a version belongs to, on 2+ portrait orders. */}
                    {multiPortrait && n ? `P${n} · ` : ""}
                    {`v${index + 1}${index === submissions.length - 1 ? ", latest" : ""}`}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

const UPLOAD_ATTEMPTS = 3;
const PARALLEL_UPLOADS = 2;
const PRESIGN_REFRESH_MS = 4 * 60 * 1000; // presigned PUT links live 5 minutes (lib/storage/r2.ts)
const UPLOAD_STALL_MS = 45 * 1000; // no bytes moved for this long = the connection is gone

class UploadError extends Error {
  status: number;
  constructor(filename: string, status: number) {
    super(`Upload failed for ${filename}: ${describeUploadFailure(status)}`);
    this.name = "UploadError";
    this.status = status;
  }
}

/** Status 0 is what the browser reports for a dropped, blocked or stalled connection. */
function describeUploadFailure(status: number): string {
  if (status === 0) return "the connection dropped";
  if (status === 403) return "the upload link was refused";
  return `storage answered ${status}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run fn(0..count-1) with at most `limit` in flight at once. */
async function runLimited(count: number, limit: number, fn: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, count)) }, async () => {
    while (next < count) {
      const index = next++;
      await fn(index);
    }
  });
  await Promise.all(workers);
}

function uploadToR2(
  url: string,
  file: File,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, UPLOAD_STALL_MS);
    };
    const settle = () => {
      if (stallTimer) clearTimeout(stallTimer);
    };
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (event) => {
      armStall();
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      settle();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size, file.size);
        resolve();
      } else {
        reject(new UploadError(file.name, xhr.status));
      }
    };
    xhr.onerror = () => {
      settle();
      reject(new UploadError(file.name, 0));
    };
    xhr.onabort = () => {
      settle();
      reject(new UploadError(file.name, 0));
      void stalled;
    };
    armStall();
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
      <p className="text-xs font-semibold text-slate">{label}</p>
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
 * on the proof they were dropped on, not on the fix. With a portrait given,
 * only versions tagged to that portrait count, so a pin dropped on Portrait 2
 * never overlays Portrait 1's image.
 */
function pinnedVersionUrl(detail: CardDetail | null, events: CardEvent[], orderItemId?: string): string | null {
  const versions = (detail?.images ?? []).filter(
    (img) => img.type === "submission" && (!orderItemId || img.orderItemId === orderItemId),
  );
  const asked = events
    .filter((e) => e.toState === "in_design" && e.fromState === "awaiting_approval")
    .reduce<number>((max, e) => Math.max(max, Date.parse(e.createdAt)), 0);
  const before = asked ? versions.filter((v) => Date.parse(v.createdAt) <= asked) : versions;
  return (before.at(-1) ?? versions.at(-1))?.url ?? null;
}

type PinGroup = {
  /** "Portrait 2" on multi-portrait orders; null = the whole (single) proof. */
  label: string | null;
  url: string | null;
  /** Pins keep the number the customer saw (drop order across all images). */
  pins: { n: number; x: number; y: number }[];
};

/**
 * Pins grouped by the portrait they were dropped on. Pins without a portrait
 * (single-portrait orders, older pins) form one unlabelled group over the
 * pinned proof version — exactly the old behaviour.
 */
function groupPins(
  annotations: { x: number; y: number; p?: number }[],
  detail: CardDetail | null,
  events: CardEvent[],
): PinGroup[] {
  const groups = new Map<number, PinGroup>();
  annotations.forEach((pin, i) => {
    const p = typeof pin.p === "number" ? pin.p : 0;
    let group = groups.get(p);
    if (!group) {
      const portrait = p > 0 ? (detail?.portraits ?? [])[p - 1] : undefined;
      group = {
        label: p > 0 ? `Portrait ${p}` : null,
        url: pinnedVersionUrl(detail, events, portrait?.id) ?? pinnedVersionUrl(detail, events),
        pins: [],
      };
      groups.set(p, group);
    }
    group.pins.push({ n: i + 1, x: pin.x, y: pin.y });
  });
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, g]) => g);
}

function RevisionBlock({
  kind,
  reason,
  failedItems,
  pinGroups,
}: {
  kind: "qc" | "customer";
  reason: string | null;
  failedItems: string[];
  pinGroups: PinGroup[];
}) {
  const qc = kind === "qc";
  const note = revisionNote(reason, failedItems);
  const copy = revisionCopyText(note, failedItems);
  const pinCount = pinGroups.reduce((sum, g) => sum + g.pins.length, 0);
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-input border p-3",
        qc ? "border-rose/20 bg-rose/10" : "border-pigment/20 bg-pigment-soft",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "flex items-center gap-1.5 text-sm font-semibold",
            qc ? "text-rose" : "text-pigment",
          )}
        >
          <AlertTriangle size={14} className="shrink-0" />
          {qc ? "QC failed" : "Revision requested"}
        </span>
        {copy && <CopyButton text={copy} what={qc ? "QC note" : "revision note"} />}
      </div>
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
      {pinCount > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-ink">
            The customer marked {pinCount} spot{pinCount === 1 ? "" : "s"} on the proof:
          </p>
          {pinGroups.map((group, gi) => (
            <div key={gi} className="space-y-1">
              {group.label && <p className="text-xs font-medium text-slate">{group.label}</p>}
              {group.url ? (
                <div className="relative overflow-hidden rounded-input border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={group.url}
                    alt={`${group.label ?? "Latest submission"} with revision pins`}
                    className="block w-full"
                  />
                  {group.pins.map((p) => (
                    <span
                      key={p.n}
                      className="pointer-events-none absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-pigment text-xs font-semibold text-surface shadow-md ring-2 ring-surface"
                      style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                    >
                      {p.n}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate">
                  Pin positions were saved but no portrait image is available to show them on.
                </p>
              )}
            </div>
          ))}
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
