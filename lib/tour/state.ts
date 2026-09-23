/**
 * First-run tour state, stored per user in `user.onboarding` (jsonb, nullable).
 * Pure module: safe to import from server and client code.
 *
 * Rules (owner brief, 2026-09-23):
 *  - a small welcome card on first sign-in, then a guided tour;
 *  - once completed or dismissed ("Skip tour"), it never shows on its own again;
 *  - "Later" hides it until the next sign-in, at most LATER_LIMIT times, then quiet;
 *  - the "?" menu can always restart it.
 */
export const TOUR_VERSION = 1;
export const LATER_LIMIT = 3;

export type OnboardingState = {
  version: number;
  /** ISO time the latest run started (Start, or "Show me around"). */
  startedAt?: string | null;
  completedAt?: string | null;
  dismissedAt?: string | null;
  /** Zero-based index of the last step shown in the latest run. */
  lastStep?: number;
  /** How many times "Later" was pressed, and when it last was. */
  laterCount?: number;
  laterAt?: string | null;
};

export type TourOpening =
  /** Show the welcome card (Start / Later). */
  | { kind: "welcome" }
  /** A run is in progress in this sign-in: pick it back up (page reload). */
  | { kind: "resume"; step: number }
  | { kind: "none" };

const ms = (iso?: string | null) => (iso ? Date.parse(iso) || 0 : 0);

/**
 * What the shell should open on load. `signedInAt` is the epoch ms of this
 * session's sign-in (0 for sessions minted before it was recorded, which
 * keeps a "Later" quiet until the person signs in again).
 */
export function tourOpening(state: OnboardingState | null | undefined, signedInAt: number): TourOpening {
  if (!state) return { kind: "welcome" };
  const started = ms(state.startedAt);
  const finished = Math.max(ms(state.completedAt), ms(state.dismissedAt));
  // A run started in this sign-in and not finished: resume where it was.
  if (started && started > finished && signedInAt > 0 && started >= signedInAt) {
    return { kind: "resume", step: Math.max(0, state.lastStep ?? 0) };
  }
  if (state.completedAt || state.dismissedAt) return { kind: "none" };
  if ((state.laterCount ?? 0) >= LATER_LIMIT) return { kind: "none" };
  // "Later" (or an unfinished run) waits for the next sign-in.
  const lastTouch = Math.max(ms(state.laterAt), started);
  if (lastTouch && lastTouch >= signedInAt) return { kind: "none" };
  return { kind: "welcome" };
}

export type TourEvent =
  | { type: "start" }
  | { type: "step"; step: number }
  | { type: "complete" }
  | { type: "dismiss" }
  | { type: "later" };

/** Next stored state for an event. Pure, so the server action stays tiny. */
export function applyTourEvent(prev: OnboardingState | null | undefined, event: TourEvent, now = new Date()): OnboardingState {
  const base: OnboardingState = { ...(prev ?? {}), version: TOUR_VERSION };
  const iso = now.toISOString();
  switch (event.type) {
    case "start":
      return { ...base, startedAt: iso, lastStep: 0 };
    case "step":
      return { ...base, lastStep: Math.max(0, Math.min(20, Math.floor(event.step))) };
    case "complete":
      return { ...base, completedAt: iso };
    case "dismiss":
      return { ...base, dismissedAt: iso };
    case "later":
      return { ...base, laterAt: iso, laterCount: (base.laterCount ?? 0) + 1 };
  }
}
