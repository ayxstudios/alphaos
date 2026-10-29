/**
 * Deliver together (owner, 29 Oct 2026): "if customers give multiple portraits
 * in different styles they should get all the portraits at the same time ...
 * even if there is multiple designers in the mix." Measured on prod: 21 buyers
 * with 2+ portrait orders within 3 days, 9 of 12 delivered 14 h to 94 h apart.
 *
 * A proof that passes QC while the same buyer's other portrait order is still
 * being drawn waits (its message stays a draft) until that order passes too,
 * or until just before its own due time, whichever comes first. Never late.
 *
 * This file is the pure rule (tested, no database). The loader, the hold, the
 * release and the sweep are in lib/orders/deliver-together-db.ts.
 */

/** Another order counts only when placed within this long of this one, either way. */
export const TOGETHER_WINDOW_MS = 72 * 3600 * 1000;
/** No due date on an order: placed + this. */
export const DEFAULT_DUE_MS = 48 * 3600 * 1000;
/**
 * A hold ends this long before the earliest due time, so the sweep (every 10
 * to 15 min) always gets the proof out before it is due.
 */
export const RELEASE_MARGIN_MS = 30 * 60 * 1000;
/** A hold shorter than one sweep is not worth it: the proof goes now. */
export const MIN_HOLD_MS = 15 * 60 * 1000;

/** activity_log action written when a proof is held (metadata: HoldEventMetadata). */
export const HELD_ACTION = "proof.held_for_siblings";
/** activity_log action written when a held proof is let go (metadata: messageId, reason, sent). */
export const RELEASED_ACTION = "proof.hold_released";

/** Statuses where the buyer is the one we wait on: her photos or details. Never held for. */
const BUYER_WAITING = new Set(["awaiting_photos", "awaiting_details"]);
/** The buyer already has the finished art (approved onward). */
const DELIVERED = new Set(["approved", "printing", "shipped", "delivered", "complete"]);
/** Not portrait work at all. */
const NOT_PORTRAIT = new Set(["fulfillment_only", "triage"]);

export type TogetherOrder = {
  id: string;
  number: string;
  businessId: string;
  status: string;
  placedAt: Date | null;
  createdAt: Date;
  dueAt: Date | null;
};

export type TogetherSibling = TogetherOrder & {
  /** How it is tied to this buyer: "buyer" = same customer row, email or Etsy buyer id; "notes" = only named in notes. */
  linkedBy: "buyer" | "notes";
  archived: boolean;
  /** Order lines that are portrait work (add-on lines such as rush or print and ship left out). */
  portraitLines: number;
  /** A proof of it already reached her or is on its way (sent, queued for Etsy, or a hold already let go). */
  proofOut: boolean;
  /** It passed QC and its proof is held to go with her other orders. */
  heldForSiblings: boolean;
};

export type TogetherRef = { id: string; number: string; status: string };

export type SiblingStanding =
  | { kind: "waiting" }
  | { kind: "ready" }
  | { kind: "skip"; reason: string };

export type TogetherDecision = {
  hold: boolean;
  /** Her other orders still being drawn or checked. */
  waitingOn: TogetherRef[];
  /** Her other orders already passed and held, which go out with this one. */
  ready: TogetherRef[];
  /** When a hold must end: the earliest due time of the group, less RELEASE_MARGIN_MS. Null when no other order counts. */
  holdUntil: Date | null;
  why: string;
};

const placedOf = (o: TogetherOrder): Date => o.placedAt ?? o.createdAt;

/** The order's own due time: due_at, else placed + 48 h. */
export function dueOf(o: TogetherOrder): Date {
  return o.dueAt ?? new Date(placedOf(o).getTime() + DEFAULT_DUE_MS);
}

/**
 * Does `s` belong with `order`, and if so is it still being worked (waiting)
 * or already passed and held (ready)? Pure.
 */
export function siblingStanding(order: TogetherOrder, s: TogetherSibling): SiblingStanding {
  const skip = (reason: string): SiblingStanding => ({ kind: "skip", reason });
  if (s.id === order.id) return skip("same order");
  if (s.businessId !== order.businessId) return skip("another business");
  // Notes can name an order for a style reference or another person: only a real buyer match holds a proof.
  if (s.linkedBy !== "buyer") return skip("only named in the notes");
  if (s.archived) return skip("archived");
  if (s.status === "cancelled") return skip("cancelled or refunded");
  if (DELIVERED.has(s.status)) return skip("already delivered");
  if (NOT_PORTRAIT.has(s.status) || s.portraitLines < 1) return skip("not a portrait order");
  if (BUYER_WAITING.has(s.status)) return skip("waiting on the buyer");
  if (s.status === "on_hold") return skip("on hold");
  if (Math.abs(placedOf(s).getTime() - placedOf(order).getTime()) > TOGETHER_WINDOW_MS) return skip("placed more than 72 h apart");
  if (s.heldForSiblings) return { kind: "ready" };
  // She already has a proof of it (or it is on its way): holding this one gains nothing.
  if (s.proofOut) return skip("its proof already went to her");
  return { kind: "waiting" };
}

const refOf = (o: TogetherOrder): TogetherRef => ({ id: o.id, number: o.number, status: o.status });

/** "#A", "#A and #B", "#A, #B and #C". */
export function numbersPhrase(refs: { number: string }[]): string {
  const n = refs.map((r) => (r.number.startsWith("#") ? r.number : `#${r.number}`));
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/**
 * Should this order's proof, which just passed QC, wait for the buyer's other
 * portrait orders? Pure: `siblings` are her other orders as loaded, `now` the
 * clock. Hold only while one counting order is still being worked AND now is
 * before holdUntil. holdUntil is this order's due time, never later than the
 * earliest due time of any counting order, less RELEASE_MARGIN_MS: a finished
 * portrait is never pushed past her due date.
 */
export function deliverTogetherDecision(order: TogetherOrder, siblings: TogetherSibling[], now: Date): TogetherDecision {
  const waiting: TogetherSibling[] = [];
  const ready: TogetherSibling[] = [];
  for (const s of siblings) {
    const st = siblingStanding(order, s);
    if (st.kind === "waiting") waiting.push(s);
    else if (st.kind === "ready") ready.push(s);
  }
  const group = [...waiting, ...ready];
  const base = { waitingOn: waiting.map(refOf), ready: ready.map(refOf) };
  if (!group.length) {
    return { ...base, hold: false, holdUntil: null, why: "No other open portrait order from her within 72 h." };
  }
  const earliest = Math.min(dueOf(order).getTime(), ...group.map((s) => dueOf(s).getTime()));
  const holdUntil = new Date(earliest - RELEASE_MARGIN_MS);
  if (!waiting.length) {
    return { ...base, hold: false, holdUntil, why: `Her other order ${numbersPhrase(ready)} is ready: they go together now.` };
  }
  if (holdUntil.getTime() - now.getTime() < MIN_HOLD_MS) {
    return { ...base, hold: false, holdUntil, why: `Her other order ${numbersPhrase(waiting)} is not ready, but this one is due: it goes now so it is never late.` };
  }
  return {
    ...base,
    hold: true,
    holdUntil,
    why: `Comes together with her other order ${numbersPhrase(waiting)}: sends when that passes QC, or at ${holdUntil.toISOString()} at the latest.`,
  };
}

/** What a held proof's message carries in metadata.deliverTogether (machine-readable for the agent over SQL). */
export type HoldState = {
  heldAt: string;
  holdUntil: string;
  waitingOn: TogetherRef[];
  why: string;
  /** Who passed QC: the release sends as their approval. */
  passedBy: string | null;
  releasedAt?: string;
  releaseReason?: string;
  releasedBy?: string | null;
};

/** The hold on a message's metadata, or null (junk ignored). */
export function holdOf(metadata: unknown): HoldState | null {
  const h = (metadata as { deliverTogether?: unknown } | null)?.deliverTogether as Record<string, unknown> | undefined;
  if (!h || typeof h !== "object" || typeof h.holdUntil !== "string" || typeof h.heldAt !== "string") return null;
  const waitingOn = Array.isArray(h.waitingOn)
    ? (h.waitingOn as Record<string, unknown>[]).flatMap((w) =>
        w && typeof w.id === "string" && typeof w.number === "string" ? [{ id: w.id, number: w.number, status: String(w.status ?? "") }] : [],
      )
    : [];
  return {
    heldAt: h.heldAt,
    holdUntil: h.holdUntil,
    waitingOn,
    why: typeof h.why === "string" ? h.why : "",
    passedBy: typeof h.passedBy === "string" ? h.passedBy : null,
    ...(typeof h.releasedAt === "string" ? { releasedAt: h.releasedAt } : {}),
    ...(typeof h.releaseReason === "string" ? { releaseReason: h.releaseReason } : {}),
    ...(typeof h.releasedBy === "string" || h.releasedBy === null ? { releasedBy: h.releasedBy as string | null } : {}),
  };
}

/** Why a held proof was let go by the sweep or the next pass. */
export type VerdictReason = "she_asked" | "due" | "group_ready";

/**
 * Should the sweep let this held proof go now? Pure. The stored holdUntil is
 * never pushed later by a fresh look; a fresh decision can only end it sooner.
 * Within MIN_HOLD_MS of holdUntil it goes (the sweep runs every 10 to 15 min).
 * `lastBuyerWordsAt` = her newest message on this order or any order of its
 * group: a buyer who wrote after the hold began is chasing, so it goes at once.
 */
export function releaseVerdict(
  hold: HoldState,
  fresh: TogetherDecision | null,
  now: Date,
  lastBuyerWordsAt: Date | null = null,
): { release: true; reason: VerdictReason } | { release: false } {
  const heldAt = Date.parse(hold.heldAt);
  if (lastBuyerWordsAt && !Number.isNaN(heldAt) && lastBuyerWordsAt.getTime() > heldAt) return { release: true, reason: "she_asked" };
  const stored = Date.parse(hold.holdUntil);
  const until = Math.min(Number.isNaN(stored) ? 0 : stored, fresh?.holdUntil ? fresh.holdUntil.getTime() : Infinity);
  // The last sweep before holdUntil lets it go: the next one may come too late.
  if (until - now.getTime() < MIN_HOLD_MS) return { release: true, reason: "due" };
  if (!fresh || !fresh.hold || fresh.waitingOn.length === 0) return { release: true, reason: "group_ready" };
  return { release: false };
}

/** activity_log action on each order a held proof waits on (designer-safe: order numbers only). */
export const SIBLING_WAITING_ACTION = "proof.sibling_waiting";
/** activity_log action on those orders once that held proof went (or was closed). */
export const SIBLING_RELEASED_ACTION = "proof.sibling_released";

export type SiblingSignal = { action: string; metadata: unknown; createdAt: Date };

/**
 * The quiet board label on an order another of her portraits waits for, or
 * null. Pure: `signals` are this order's SIBLING_WAITING / SIBLING_RELEASED
 * rows. A wait counts while no release row names the same held message and
 * its holdUntil is still ahead. Order numbers only, never a buyer detail.
 */
export function togetherWaitingNote(signals: SiblingSignal[], now: Date): string | null {
  const released = new Set(
    signals
      .filter((r) => r.action === SIBLING_RELEASED_ACTION)
      .map((r) => String((r.metadata as { messageId?: unknown } | null)?.messageId ?? "")),
  );
  const open = new Map<string, string>();
  for (const r of signals) {
    if (r.action !== SIBLING_WAITING_ACTION) continue;
    const m = (r.metadata ?? {}) as { messageId?: unknown; heldOrderNumber?: unknown; holdUntil?: unknown };
    const id = String(m.messageId ?? "");
    const until = typeof m.holdUntil === "string" ? Date.parse(m.holdUntil) : NaN;
    if (!id || released.has(id) || Number.isNaN(until) || until <= now.getTime()) continue;
    if (typeof m.heldOrderNumber === "string" && m.heldOrderNumber) open.set(id, m.heldOrderNumber);
  }
  if (!open.size) return null;
  const numbers = numbersPhrase([...new Set(open.values())].map((number) => ({ number })));
  return `Her other portrait ${numbers} is done and waits for this one, so she gets them together.`;
}
