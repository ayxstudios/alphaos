"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { presignQcFeedbackUploads, registerQcFeedbackUploads } from "@/app/(app)/qc/feedback-uploads";
import { Camera, X } from "@/components/ui/icons";
import { focusRing } from "@/components/ui/styles";
import { PRESIGN_REFRESH_MS, UPLOAD_ATTEMPTS, UploadError, sleep, uploadToR2 } from "@/components/uploads/r2-put";
import { MAX_QC_ATTACHMENTS, MAX_QC_ATTACHMENT_BYTES } from "@/lib/qc/attachments";
import { cn } from "@/lib/utils";

export type PickedPicture = {
  localId: string;
  name: string;
  preview: string;
  status: "uploading" | "done" | "failed";
  /** 0..1 while uploading. */
  progress: number;
  assetId?: string;
  error?: string;
  file: File;
};

/**
 * Pictures for a failed QC. Each picture uploads the moment it is picked
 * (presign, PUT with retries, register), so by the time the reviewer taps
 * Fail the only thing left to send is the asset ids. `busy` is true while any
 * picture is still on its way: the Fail button waits for it.
 */
export function useQcPictures(orderId: string) {
  const [pictures, setPictures] = useState<PickedPicture[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const all = useRef<PickedPicture[]>([]);
  all.current = pictures;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const p of all.current) URL.revokeObjectURL(p.preview);
    };
  }, []);

  const patch = useCallback((localId: string, change: Partial<PickedPicture>) => {
    if (!alive.current) return;
    setPictures((rows) => rows.map((r) => (r.localId === localId ? { ...r, ...change } : r)));
  }, []);

  const send = useCallback(
    async (localId: string, file: File) => {
      patch(localId, { status: "uploading", progress: 0, error: undefined });
      const meta = { filename: file.name, contentType: file.type, size: file.size };
      try {
        const first = await presignQcFeedbackUploads({ orderId, files: [meta] });
        if (!first.ok) throw new Error(first.message);
        let target = first.uploads[0];
        let issuedAt = Date.now();
        let lastError: UploadError | null = null;
        let uploaded = false;
        for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS && !uploaded; attempt++) {
          try {
            await uploadToR2(target.uploadUrl, file, (loaded, total) =>
              patch(localId, { progress: total ? loaded / total : 0 }),
            );
            uploaded = true;
          } catch (error) {
            lastError = error instanceof UploadError ? error : new UploadError(file.name, 0);
            if (attempt === UPLOAD_ATTEMPTS) break;
            await sleep(1500 * attempt);
            if (lastError.status === 403 || Date.now() - issuedAt > PRESIGN_REFRESH_MS) {
              const again = await presignQcFeedbackUploads({ orderId, files: [meta] });
              if (!again.ok) throw new Error(again.message);
              target = again.uploads[0];
              issuedAt = Date.now();
            }
          }
        }
        if (!uploaded) {
          throw new Error(`${(lastError ?? new UploadError(file.name, 0)).message}. Check your internet and retry.`);
        }
        const saved = await registerQcFeedbackUploads({ orderId, keys: [target.key] });
        if (!saved.ok) throw new Error(saved.message);
        patch(localId, { status: "done", progress: 1, assetId: saved.pictures[0]?.assetId });
      } catch (error) {
        patch(localId, {
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed. Try again.",
        });
      }
    },
    [orderId, patch],
  );

  const add = useCallback(
    (files: File[]) => {
      setNotice(null);
      const room = MAX_QC_ATTACHMENTS - all.current.length;
      const rejected: string[] = [];
      const take: File[] = [];
      for (const f of files) {
        if (!f.type.startsWith("image/")) rejected.push(`${f.name} is not a picture`);
        else if (f.size > MAX_QC_ATTACHMENT_BYTES) rejected.push(`${f.name} is over 20 MB`);
        else if (take.length >= room) rejected.push(`only ${MAX_QC_ATTACHMENTS} pictures fit`);
        else take.push(f);
      }
      if (rejected.length) setNotice(`Skipped: ${[...new Set(rejected)].join("; ")}.`);
      const rows: PickedPicture[] = take.map((file) => ({
        localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        preview: URL.createObjectURL(file),
        status: "uploading",
        progress: 0,
        file,
      }));
      if (!rows.length) return;
      setPictures((prev) => [...prev, ...rows]);
      for (const row of rows) void send(row.localId, row.file);
    },
    [send],
  );

  const remove = useCallback((localId: string) => {
    setPictures((rows) => {
      const gone = rows.find((r) => r.localId === localId);
      if (gone) URL.revokeObjectURL(gone.preview);
      return rows.filter((r) => r.localId !== localId);
    });
  }, []);

  const retry = useCallback(
    (localId: string) => {
      const row = all.current.find((r) => r.localId === localId);
      if (row) void send(localId, row.file);
    },
    [send],
  );

  const reset = useCallback(() => {
    setPictures((rows) => {
      for (const r of rows) URL.revokeObjectURL(r.preview);
      return [];
    });
    setNotice(null);
  }, []);

  // A different order never inherits the last one's pictures.
  useEffect(() => reset, [orderId, reset]);

  return {
    pictures,
    notice,
    add,
    remove,
    retry,
    reset,
    busy: pictures.some((p) => p.status === "uploading"),
    failedCount: pictures.filter((p) => p.status === "failed").length,
    /** Asset ids of the pictures that landed; send these with the fail. */
    assetIds: pictures.filter((p) => p.status === "done" && p.assetId).map((p) => p.assetId as string),
  };
}

export type QcPicturesState = ReturnType<typeof useQcPictures>;

/** The "Add pictures" control plus thumbnails with remove / retry. */
export function QcPicturePicker({ state, disabled = false }: { state: QcPicturesState; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const full = state.pictures.length >= MAX_QC_ATTACHMENTS;
  return (
    <div className="flex flex-col gap-2" data-testid="qc-picture-picker">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">
          Pictures <span className="font-normal text-slate">(optional, up to {MAX_QC_ATTACHMENTS})</span>
        </span>
        <button
          type="button"
          disabled={disabled || full}
          onClick={() => input.current?.click()}
          data-testid="qc-picture-add"
          className={cn(
            "inline-flex min-h-11 items-center gap-1.5 rounded-input border border-line px-3 text-sm font-medium text-ink sm:min-h-9",
            "transition-colors motion-hover hover:bg-canvas disabled:opacity-50",
            focusRing,
          )}
        >
          <Camera size={16} /> Add picture
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="qc-picture-input"
          onChange={(e) => {
            state.add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      {state.notice ? (
        <p className="text-xs text-rose" role="alert">
          {state.notice}
        </p>
      ) : null}
      {state.pictures.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {state.pictures.map((p) => (
            <li key={p.localId} className="flex w-24 flex-col gap-1">
              <div className="relative size-24 overflow-hidden rounded-input border border-line bg-canvas">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.preview} alt={p.name} className={cn("size-full object-cover", p.status !== "done" && "opacity-60")} />
                {p.status === "uploading" && (
                  <span className="absolute inset-x-0 bottom-0 h-1 bg-line">
                    <span className="block h-full bg-sage" style={{ width: `${Math.round(p.progress * 100)}%` }} />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => state.remove(p.localId)}
                  aria-label={`Remove ${p.name}`}
                  className={cn(
                    "absolute right-1 top-1 inline-flex size-7 items-center justify-center rounded-full bg-ink/70 text-surface",
                    focusRing,
                  )}
                >
                  <X size={14} />
                </button>
              </div>
              {p.status === "uploading" && <span className="text-xs text-slate">Uploading...</span>}
              {p.status === "done" && <span className="text-xs text-sage">Ready</span>}
              {p.status === "failed" && (
                <span className="flex flex-col gap-0.5 text-xs text-rose" role="alert">
                  <span className="break-words">{p.error}</span>
                  <button type="button" onClick={() => state.retry(p.localId)} className={cn("self-start font-semibold underline", focusRing)}>
                    Retry
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
