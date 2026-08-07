export const SYNC_STALE_MS = 60 * 60 * 1000;

export type SyncHealth = "ok" | "stale" | "never";

export function syncHealth(lastSyncAt: string | null | undefined, now = new Date()): SyncHealth {
  if (!lastSyncAt) return "never";
  const t = new Date(lastSyncAt).getTime();
  if (!Number.isFinite(t)) return "never";
  return now.getTime() - t > SYNC_STALE_MS ? "stale" : "ok";
}

export function formatSyncTime(lastSyncAt: string | null | undefined): string {
  if (!lastSyncAt) return "never";
  const d = new Date(lastSyncAt);
  if (!Number.isFinite(d.getTime())) return "never";
  return d.toLocaleString();
}
