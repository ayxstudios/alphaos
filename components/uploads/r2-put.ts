/** Browser-side direct-to-R2 upload helpers, shared by the card modal and the QC fail pictures. */
export const UPLOAD_ATTEMPTS = 3;
export const PARALLEL_UPLOADS = 2;
export const PRESIGN_REFRESH_MS = 4 * 60 * 1000; // presigned PUT links live 5 minutes (lib/storage/r2.ts)
export const UPLOAD_STALL_MS = 45 * 1000; // no bytes moved for this long = the connection is gone

export class UploadError extends Error {
  status: number;
  constructor(filename: string, status: number) {
    super(`Upload failed for ${filename}: ${describeUploadFailure(status)}`);
    this.name = "UploadError";
    this.status = status;
  }
}

/** Status 0 is what the browser reports for a dropped, blocked or stalled connection. */
export function describeUploadFailure(status: number): string {
  if (status === 0) return "the connection dropped";
  if (status === 403) return "the upload link was refused";
  return `storage answered ${status}`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run fn(0..count-1) with at most `limit` in flight at once. */
export async function runLimited(count: number, limit: number, fn: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, count)) }, async () => {
    while (next < count) {
      const index = next++;
      await fn(index);
    }
  });
  await Promise.all(workers);
}

export function uploadToR2(
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

