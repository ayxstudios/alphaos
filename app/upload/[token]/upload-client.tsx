"use client";

import { useCallback, useRef, useState } from "react";

import { Button } from "@/components/ui";
import { presignAction, saveAction } from "./actions";

type Props = {
  token: string;
  ask: string;
  detail: string;
  receivedCount: number;
  open: boolean;
  devStore: boolean;
};

type FileState = {
  id: string;
  file: File;
  previewUrl: string | null;
  progress: number; // 0..100
  status: "pending" | "uploading" | "done" | "error";
  error: string | null;
  key: string | null;
};

const ACCEPT = "image/jpeg,image/png,image/heic,image/heif,image/webp,.jpg,.jpeg,.png,.heic,.heif,.webp";
const MAX_FILES = 20;
const MAX_BYTES = 25 * 1024 * 1024;

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function canPreview(file: File): boolean {
  return /^image\/(jpeg|png|webp)$/i.test(file.type);
}

/** XHR PUT so we get real upload progress (fetch has no upload progress event). */
function putWithProgress(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
    xhr.send(file);
  });
}

export function UploadClient({ token, ask, detail, receivedCount, open, devStore }: Props) {
  const [files, setFiles] = useState<FileState[]>([]);
  const [note, setNote] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((list: FileList | File[]) => {
    setError(null);
    const incoming = Array.from(list);
    setFiles((prev) => {
      const room = MAX_FILES - prev.length;
      if (room <= 0) {
        setError(`You can upload up to ${MAX_FILES} photos at a time.`);
        return prev;
      }
      const next: FileState[] = [];
      for (const file of incoming.slice(0, room)) {
        if (file.size > MAX_BYTES) {
          next.push({ id: newId(), file, previewUrl: null, progress: 0, status: "error", error: "Over 25 MB", key: null });
          continue;
        }
        next.push({
          id: newId(),
          file,
          previewUrl: canPreview(file) ? URL.createObjectURL(file) : null,
          progress: 0,
          status: "pending",
          error: null,
          key: null,
        });
      }
      return [...prev, ...next];
    });
  }, []);

  function removeFile(id: string) {
    setFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }

  const uploadable = files.filter((f) => f.status !== "error");
  const canSubmit = !submitting && open && (uploadable.length > 0 || note.trim().length > 0);

  async function onSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      // Keys already uploaded in an earlier pass of this session (a retry after
      // a partial failure) never get re-uploaded.
      const toUpload = files.filter((f) => f.status === "pending" || f.status === "error");
      const alreadyDoneKeys = files.filter((f) => f.status === "done").map((f) => f.key);

      let justUploadedKeys: string[] = [];
      if (toUpload.length) {
        const presign = await presignAction(
          token,
          toUpload.map((f) => ({ filename: f.file.name, contentType: f.file.type, size: f.file.size })),
        );
        if (!presign.ok) {
          setError(presign.message);
          setSubmitting(false);
          return;
        }
        setFiles((prev) =>
          prev.map((f) => (toUpload.some((t) => t.id === f.id) ? { ...f, status: "uploading", error: null } : f)),
        );

        const results = await Promise.all(
          toUpload.map(async (f, i) => {
            const up = presign.uploads[i];
            try {
              await putWithProgress(up.uploadUrl, f.file, (pct) => {
                setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, progress: pct } : x)));
              });
              return { id: f.id, key: up.key, ok: true as const };
            } catch (err) {
              return { id: f.id, ok: false as const, message: err instanceof Error ? err.message : "Upload failed" };
            }
          }),
        );

        setFiles((prev) =>
          prev.map((f) => {
            const r = results.find((x) => x.id === f.id);
            if (!r) return f;
            return r.ok
              ? { ...f, status: "done", progress: 100, key: r.key }
              : { ...f, status: "error", error: r.message };
          }),
        );

        if (results.some((r) => !r.ok)) {
          setError("Some photos didn't upload. You can try again, or remove them and continue with the rest.");
          setSubmitting(false);
          return;
        }
        justUploadedKeys = results.filter((r) => r.ok).map((r) => r.key);
      }

      const allKeys = [...alreadyDoneKeys, ...justUploadedKeys].filter((k): k is string => !!k);
      const savedRes = await saveAction(token, allKeys, note);
      if (!savedRes.ok) {
        setError(savedRes.message);
        setSubmitting(false);
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-card border border-sage/30 bg-sage/10 p-6 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-sage text-surface">
          <CheckIcon />
        </span>
        <h2 className="text-lg font-semibold text-ink">Got them, thank you!</h2>
        <p className="text-sm text-slate">
          Your photos are with our team. We&rsquo;ll be in touch as soon as your
          portrait is ready to review.
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <p className="rounded-card border border-line bg-surface p-4 text-center text-sm text-slate">
        This order is closed, so photos can no longer be added. If you think
        this is a mistake, please reply to the email we sent you.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {devStore && (
        <p className="rounded-input border border-amber/30 bg-amber/10 p-2.5 text-center text-xs font-medium text-amber">
          Dev store — local test mode, not real storage
        </p>
      )}

      <div className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4 text-center">
        <h2 className="text-lg font-semibold text-ink">{ask}</h2>
        {detail && <p className="text-sm text-slate">{detail}</p>}
        {receivedCount > 0 && (
          <p className="mt-1 text-xs font-medium text-sage">
            We already have {receivedCount} photo{receivedCount === 1 ? "" : "s"} from you
          </p>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        className={
          "flex cursor-pointer flex-col items-center gap-2 rounded-card border-2 border-dashed p-8 text-center motion-hover " +
          (dragOver ? "border-pigment bg-pigment-soft" : "border-line bg-surface hover:border-pigment/50")
        }
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-pigment-soft text-pigment">
          <UploadIcon />
        </span>
        <p className="text-base font-medium text-ink">Tap to choose photos</p>
        <p className="text-xs text-slate">or drag them here — JPG, PNG or HEIC, up to 25 MB each</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="flex flex-col gap-2">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 rounded-input border border-line bg-surface p-2.5"
            >
              <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-input bg-canvas">
                {f.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.previewUrl} alt="" className="size-full object-cover" />
                ) : (
                  <span className="text-[10px] font-medium uppercase text-slate">
                    {f.file.name.split(".").pop()?.slice(0, 4) ?? "img"}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{f.file.name}</p>
                {f.status === "uploading" && (
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full rounded-full bg-pigment transition-[width] duration-200"
                      style={{ width: `${f.progress}%` }}
                    />
                  </div>
                )}
                {f.status === "error" && <p className="text-xs text-rose">{f.error}</p>}
                {f.status === "done" && <p className="text-xs text-sage">Uploaded</p>}
              </div>
              {f.status !== "uploading" && (
                <button
                  type="button"
                  onClick={() => removeFile(f.id)}
                  aria-label={`Remove ${f.file.name}`}
                  className="shrink-0 rounded-full p-1.5 text-slate hover:bg-canvas hover:text-ink"
                >
                  <CloseIcon />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Anything we should know? (optional)"
        className="w-full rounded-input border border-line bg-canvas p-3 text-sm text-ink placeholder:text-slate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pigment"
      />

      {error && (
        <p className="rounded-input border border-rose/30 bg-rose/10 p-3 text-sm text-rose">{error}</p>
      )}

      <Button size="lg" onClick={onSubmit} loading={submitting} disabled={!canSubmit}>
        Send my photos
      </Button>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 16V4m0 0-4 4m4-4 4 4M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
