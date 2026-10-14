// The Approve queue (Yousif 2026-10-14): a tap on Approve moves on at once and
// the real send waits APPROVE_GRACE_MS so a too-fast tap can be stopped.
// Pure logic with injected effects so it is testable without a browser.

export const APPROVE_GRACE_MS = 8000;
export const SENT_LINGER_MS = 2000;

/** email = sent; etsy = queued as an Etsy message (no email on file); held = waits for an owner. */
export type CommitDelivery = "email" | "etsy" | "held";

export type CommitResult =
  | { ok: true; title: string; description?: string; delivery?: CommitDelivery }
  | { ok: false; code: string; message: string };

export type PendingRow = {
  orderId: string;
  orderNumber: string;
  customerName: string;
  /** "Send AI fix" (2026-10-14): the fix samples to apply before the send. */
  fixIds?: string[];
  /** pending = in the Stop window; sending = in flight (or flushed); sent; failed. */
  status: "pending" | "sending" | "sent" | "failed";
  startedAt: number;
  endsAt: number;
  message: string | null;
  /** Set once it went through: how the proof left. */
  delivery?: CommitDelivery;
};

/** stale = already checked; claimed = someone else has it open (lib/qc/claims.ts). */
export type StoreEvent = { type: "stale" | "claimed"; row: PendingRow; message: string };

export type StoreDeps = {
  /** Server action path with the 30 s timeout and stale-bundle handling. */
  commit: (orderId: string, fixIds?: string[]) => Promise<CommitResult>;
  /** keepalive POST used on pagehide; resolves with the answer when the page lives on. */
  beacon: (orderId: string, fixIds?: string[]) => Promise<CommitResult>;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  now: () => number;
  graceMs?: number;
  lingerMs?: number;
};

const ORDER_ID = /^[0-9a-f-]{36}$/i;

/** Ids safe to put in ?skip= : anything else is dropped. */
export function parseSkip(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => ORDER_ID.test(s)))];
}

export function createApprovalStore(deps: StoreDeps) {
  const grace = deps.graceMs ?? APPROVE_GRACE_MS;
  const linger = deps.lingerMs ?? SENT_LINGER_MS;
  let rows: PendingRow[] = [];
  const timers = new Map<string, unknown>();
  const subs = new Set<() => void>();
  const evSubs = new Set<(e: StoreEvent) => void>();

  const emit = () => subs.forEach((f) => f());
  const get = (id: string) => rows.find((r) => r.orderId === id);
  const patch = (id: string, p: Partial<PendingRow>) => {
    rows = rows.map((r) => (r.orderId === id ? { ...r, ...p } : r));
    emit();
  };
  const remove = (id: string) => {
    const t = timers.get(id);
    if (t !== undefined) deps.cancel(t);
    timers.delete(id);
    rows = rows.filter((r) => r.orderId !== id);
    emit();
  };

  function settle(id: string, res: CommitResult) {
    const row = get(id);
    if (!row) return;
    if (res.ok) {
      patch(id, { status: "sent", message: null, delivery: res.delivery ?? "email" });
      timers.set(id, deps.schedule(() => remove(id), linger));
    } else if (res.code === "stale" || res.code === "claimed") {
      remove(id);
      const type = res.code;
      evSubs.forEach((f) => f({ type, row, message: res.message }));
    } else {
      patch(id, { status: "failed", message: res.message });
    }
  }

  function send(id: string, via: "commit" | "beacon") {
    const t = timers.get(id);
    if (t !== undefined) deps.cancel(t);
    timers.delete(id);
    patch(id, { status: "sending", message: null });
    deps[via](id, get(id)?.fixIds).then(
      (res) => settle(id, res),
      () => settle(id, { ok: false, code: "network", message: "That didn't go through (connection dropped)." }),
    );
  }

  return {
    getRows: () => rows,
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    onEvent(f: (e: StoreEvent) => void) {
      evSubs.add(f);
      return () => void evSubs.delete(f);
    },
    /** Order ids the server still lists as awaiting QC: kept out of the queue. */
    skipIds: () => rows.filter((r) => r.status !== "sent").map((r) => r.orderId),
    enqueue(info: { orderId: string; orderNumber: string; customerName: string; fixIds?: string[] }) {
      if (get(info.orderId)) return;
      const startedAt = deps.now();
      rows = [...rows, { ...info, status: "pending", startedAt, endsAt: startedAt + grace, message: null }];
      timers.set(info.orderId, deps.schedule(() => send(info.orderId, "commit"), grace));
      emit();
    },
    /** True when stopped in time: nothing was sent. */
    stop(id: string): boolean {
      if (get(id)?.status !== "pending") return false;
      remove(id);
      return true;
    },
    retry(id: string) {
      if (get(id)?.status === "failed") send(id, "commit");
    },
    dismiss: remove,
    /** Page is going away: commit every row still in its Stop window at once. */
    flush() {
      for (const r of rows) if (r.status === "pending") send(r.orderId, "beacon");
    },
  };
}
