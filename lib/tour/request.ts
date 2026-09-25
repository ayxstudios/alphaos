/**
 * The tiny, always-loaded half of the tour: the event other parts of the app
 * fire to start it. Everything else (components/tour/tour-runtime.tsx) is
 * loaded on demand.
 */
export const TOUR_START_EVENT = "alphaos:tour-start";

export type TourMode = "try" | "one";

/** `detail` of TOUR_START_EVENT. `one` opens a single step's page with it lit (the Quick guide's "Point me to it"). */
export type TourStartDetail = { mode?: TourMode; step?: number };

export type TourRequest =
  | { id: number; kind: "welcome" }
  | { id: number; kind: "resume"; step: number }
  | { id: number; kind: "start"; mode: TourMode; step: number; at: number };

/** Start the tour from anywhere (menu items, the Quick guide). */
export function startTour(detail: TourStartDetail = {}) {
  window.dispatchEvent(new CustomEvent<TourStartDetail>(TOUR_START_EVENT, { detail }));
}
