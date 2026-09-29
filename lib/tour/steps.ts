import type { Role } from "@/lib/auth/config";

/**
 * The first-run tour, per role: a short list of steps on the real screen.
 * Shared by the tour (components/tour) and the Quick guide (/help).
 *
 * Each step lives on one page (`path`). The tour points, the person clicks
 * (owner, 2026-09-25): the page dims, the real element is ringed, an arrow
 * runs from the step card to it, and the step completes on the person's own
 * click. To reach the page the tour first rings the page's menu item (the
 * sidebar, the bottom tab, or More then the item). Nothing is ever pressed,
 * sent, assigned, passed or uploaded for them.
 *
 * `say` is the step's copy, written for people who read English as a second
 * language: at most about 8 words, common words only, no idioms, one action.
 * The first sentence says what the thing is, the second what to press.
 *
 * Staff have three tours: the VA Day tour and the admin Overview tour (agent
 * mode, see `tourStepsFor`) and the older Today/QC tour when agent mode is off.
 *
 * Targets are CSS selectors, tried in order; `css@@Text` also requires the
 * element's text to start with Text. The first visible match wins.
 */
export type Sel = string[];

export type TourAct =
  /** The step's own sidebar item / bottom tab is the thing to press. */
  | { kind: "nav"; say: string }
  /** Press an element on the page. */
  | {
      kind: "click";
      target: Sel;
      say: string;
      /** Unused since the tour stopped demonstrating (2026-09-25); kept so copy edits merge cleanly. */
      undo?: "back" | "close" | "reclick" | { click: Sel };
      via?: Sel;
      /** When the target is already the selected one, quietly open this first. */
      reset?: string;
    }
  /** Type into a search box and press Enter. `sample` is unused since 2026-09-25. */
  | { kind: "search"; target: Sel; say: string; sample?: Sel }
  /** An upload drop zone: the person's press is caught (no file picker) and a sample lands. `via` opens it. */
  | { kind: "drop"; target: Sel; say: string; via?: Sel };

export type TourStep = {
  id: string;
  /** Short name, for the Quick guide list. */
  title: string;
  /** The page the step happens on. */
  path: string;
  /** Candidates, best first. When none can be found the step falls back to `nav`. */
  acts: TourAct[];
  /** The fallback: press the page's own menu item. */
  nav: { kind: "nav"; say: string };
};

const CARDS: Sel = ['[data-tour="card:in_design"]', '[data-tour="card:ready_to_assign"]', '[data-tour^="card:"]'];
const QC_DIALOG = '[role="dialog"][aria-label^="Compare"]';

/** VA tour when the Day queue is on: the three card types, then check, approve and send back. */
const VA_DAY_STEPS: TourStep[] = [
  {
    id: "day",
    title: "Day",
    path: "/day",
    acts: [],
    nav: { kind: "nav", say: "Day is your work list. Tap Day." },
  },
  {
    id: "card-portrait",
    title: "Portrait QC card",
    path: "/day",
    acts: [{ kind: "click", target: ['[data-tour="group:portrait"]'], say: "Portrait QC: check new art. Tap the title." }],
    nav: { kind: "nav", say: "Cards wait on Day. Tap Day." },
  },
  {
    id: "card-revision",
    title: "Revision QC card",
    path: "/day",
    acts: [{ kind: "click", target: ['[data-tour="group:revision"]'], say: "Revision QC: buyer asked for a change. Tap the title." }],
    nav: { kind: "nav", say: "Cards wait on Day. Tap Day." },
  },
  {
    id: "card-print",
    title: "Print and ship card",
    path: "/day",
    acts: [{ kind: "click", target: ['[data-tour="group:print"]'], say: "Print and ship: send to the printer. Tap the title." }],
    nav: { kind: "nav", say: "Cards wait on Day. Tap Day." },
  },
  {
    id: "compare",
    title: "Compare",
    path: "/day",
    acts: [{ kind: "click", target: ['[data-tour="day-compare"]'], say: "Compare shows photo and portrait. Tap Compare." }],
    nav: { kind: "nav", say: "Cards wait on Day. Tap Day." },
  },
  {
    id: "swap",
    title: "Swap sides",
    path: "/day",
    acts: [{ kind: "click", target: [`${QC_DIALOG} [data-tour="qc-swap"]`], say: "Swap moves the pictures. Tap Swap sides." }],
    nav: { kind: "nav", say: "Cards wait on Day. Tap Day." },
  },
  {
    id: "good",
    title: "Looks good",
    path: "/day",
    acts: [{ kind: "click", target: [`${QC_DIALOG} [data-tour="qc-good"]`], say: "Looks good sends it on. Tap it." }],
    nav: { kind: "nav", say: "Cards wait on Day. Tap Day." },
  },
  {
    id: "fix",
    title: "Needs a fix",
    path: "/day",
    acts: [{ kind: "click", target: [`${QC_DIALOG} [data-tour="qc-fix"]`], say: "Needs a fix sends it back. Tap it." }],
    nav: { kind: "nav", say: "Cards wait on Day. Tap Day." },
  },
  {
    id: "reason",
    title: "Pick a reason",
    path: "/day",
    acts: [{ kind: "click", target: [`${QC_DIALOG} [data-tour="qc-reasons"] button`], say: "Say what is wrong. Tap a reason." }],
    nav: { kind: "nav", say: "Cards wait on Day. Tap Day." },
  },
  {
    id: "close",
    title: "Close Compare",
    path: "/day",
    acts: [{ kind: "click", target: [`${QC_DIALOG} button[aria-label="Close"]`], say: "That is all. Tap X to close." }],
    nav: { kind: "nav", say: "Cards wait on Day. Tap Day." },
  },
];

/** Owner/admin tour when the Day queue is on: watch the whole business, move work, fix problems. */
const ADMIN_AGENT_STEPS: TourStep[] = [
  {
    id: "overview",
    title: "Overview",
    path: "/overview",
    acts: [],
    nav: { kind: "nav", say: "Overview lists every open order. Tap Overview." },
  },
  {
    id: "reassign",
    title: "Reassign",
    path: "/overview",
    acts: [{ kind: "click", target: ['[data-tour="reassign"]'], say: "Reassign moves an order. Tap Reassign." }],
    nav: { kind: "nav", say: "Overview lists every open order. Tap Overview." },
  },
  {
    id: "exceptions",
    title: "Exceptions",
    path: "/exceptions",
    acts: [],
    nav: { kind: "nav", say: "Problems wait here. Tap Exceptions." },
  },
  {
    id: "day",
    title: "Day",
    path: "/day",
    acts: [],
    nav: { kind: "nav", say: "Checks wait on Day. Tap Day." },
  },
  {
    id: "orders",
    title: "Orders",
    path: "/orders",
    acts: [],
    nav: { kind: "nav", say: "Every order is here. Tap Orders." },
  },
  {
    id: "team",
    title: "Designers",
    path: "/designers",
    acts: [],
    nav: { kind: "nav", say: "See who has room. Tap Designers." },
  },
  {
    id: "settings",
    title: "Settings",
    path: "/settings",
    acts: [],
    nav: { kind: "nav", say: "Connect shops and email. Tap Settings." },
  },
];

/** VA tour when the Day queue is off (the older Today and QC screens). */
const VA_STEPS: TourStep[] = [
  {
    id: "today",
    title: "Today",
    path: "/today",
    acts: [],
    nav: { kind: "nav", say: "Today lists your work. Tap Today." },
  },
  {
    id: "search",
    title: "Find an order",
    path: "/orders",
    acts: [
      {
        kind: "search",
        target: ['main input[name="q"]'],
        sample: ['[data-tour="order:customer"]'],
        say: "Find any order. Type a name, press Enter.",
      },
    ],
    nav: { kind: "nav", say: "Every order is here. Tap Orders." },
  },
  {
    id: "needs-details",
    title: "Needs details",
    path: "/orders",
    acts: [
      {
        kind: "click",
        target: ['[data-tour="page:orders"]'],
        undo: "back",
        reset: "/orders?view=active",
        say: "Some orders miss details. Tap Needs details.",
      },
    ],
    nav: { kind: "nav", say: "Every order is here. Tap Orders." },
  },
  {
    id: "qc",
    title: "QC",
    path: "/qc",
    acts: [
      {
        kind: "click",
        target: ['main a[href^="/qc/"]@@Start QC'],
        undo: "back",
        say: "Check each finished portrait. Tap Start QC.",
      },
    ],
    nav: { kind: "nav", say: "Check finished portraits here. Tap QC." },
  },
  {
    id: "messages",
    title: "Messages",
    path: "/emails",
    acts: [
      {
        kind: "click",
        target: ["main details > summary@@All mail"],
        undo: "reclick",
        say: "Customer emails are here. Tap All mail.",
      },
    ],
    nav: { kind: "nav", say: "Customer emails are here. Tap Messages." },
  },
  {
    id: "print",
    title: "Print",
    path: "/queue/print",
    acts: [
      {
        kind: "click",
        target: ["main details > summary@@Details"],
        undo: "reclick",
        say: "Approved orders wait to print. Tap Details.",
      },
    ],
    nav: { kind: "nav", say: "Approved orders wait to print. Tap Print." },
  },
];

const DESIGNER_STEPS: TourStep[] = [
  {
    id: "board",
    title: "My Board",
    path: "/board",
    acts: [],
    nav: { kind: "nav", say: "Your orders are here. Tap My Board." },
  },
  {
    id: "card",
    title: "Open a card",
    path: "/board",
    acts: [{ kind: "click", target: CARDS, undo: "close", say: "One card is one order. Tap a card." }],
    nav: { kind: "nav", say: "Your orders are here. Tap My Board." },
  },
  {
    id: "upload",
    title: "Upload your portrait",
    path: "/board",
    acts: [
      {
        kind: "drop",
        target: ['[data-tour="card:drop"]', '[data-tour="card:upload"]'],
        via: CARDS,
        say: "Add your finished portrait here. Tap Upload.",
      },
    ],
    nav: { kind: "nav", say: "Your orders are here. Tap My Board." },
  },
  {
    id: "week",
    title: "My Week",
    path: "/me",
    acts: [],
    nav: { kind: "nav", say: "See your deadlines and pay. Tap My Week." },
  },
];

/** Owner/admin tour when the Day queue is off. */
const ADMIN_STEPS: TourStep[] = [
  {
    id: "orders",
    title: "Orders",
    path: "/orders",
    acts: [
      {
        kind: "click",
        target: ['main a[href*="view=overdue"]'],
        undo: "back",
        reset: "/orders?view=active",
        say: "Every order is here. Tap Overdue.",
      },
    ],
    nav: { kind: "nav", say: "Every order is here. Tap Orders." },
  },
  {
    id: "team",
    title: "Team and sign-ins",
    path: "/designers",
    acts: [
      {
        kind: "click",
        target: ['[data-tour="team"] [role="tab"]:nth-of-type(2)'],
        undo: { click: ['[data-tour="team"] [role="tab"]:nth-of-type(1)'] },
        say: "See who can sign in. Tap a group.",
      },
    ],
    nav: { kind: "nav", say: "See your team. Tap Designers." },
  },
  {
    id: "styles",
    title: "Portrait Styles",
    path: "/styles",
    acts: [
      {
        kind: "click",
        target: ["main button@@Designers ·"],
        undo: "close",
        say: "Each style has its designers. Tap Designers.",
      },
    ],
    nav: { kind: "nav", say: "Set who draws what. Tap Portrait Styles." },
  },
  {
    id: "settings",
    title: "Settings",
    path: "/settings",
    acts: [
      {
        kind: "click",
        target: ['main a[href="/settings?section=email"]'],
        undo: "back",
        reset: "/settings?section=etsy",
        say: "Connect shops and email. Tap Customer Email.",
      },
    ],
    nav: { kind: "nav", say: "Connect shops and email. Tap Settings." },
  },
  {
    id: "money",
    title: "Money",
    path: "/payouts",
    acts: [
      {
        kind: "click",
        target: ['main a[href*="designer="]'],
        undo: "back",
        say: "See what each designer earned. Tap a name.",
      },
    ],
    nav: { kind: "nav", say: "See what designers earned. Tap Money." },
  },
  {
    id: "health",
    title: "System Health",
    path: "/health",
    acts: [
      {
        kind: "click",
        target: ['main a[href="/health?scope=all"]'],
        undo: "back",
        reset: "/health",
        say: "Health shows hidden problems. Tap All Businesses.",
      },
    ],
    nav: { kind: "nav", say: "Health shows hidden problems. Tap Health." },
  },
];

export const TOUR_STEPS: Record<Role, TourStep[]> = {
  admin: ADMIN_STEPS,
  va: VA_STEPS,
  designer: DESIGNER_STEPS,
};

/** The tour for a role. With the Day queue on, staff get the Day and Overview tours. */
export function tourStepsFor(role: Role, agentMode: boolean): TourStep[] {
  if (agentMode && role === "va") return VA_DAY_STEPS;
  if (agentMode && role === "admin") return ADMIN_AGENT_STEPS;
  return TOUR_STEPS[role];
}

/** The line the Quick guide shows for a step (its preferred act). */
export function stepLine(step: TourStep): string {
  return (step.acts[0] ?? step.nav).say;
}


/** Just the first sentence (what the thing is), for the Quick guide's one-screen list. */
export function stepWhat(step: TourStep): string {
  const line = stepLine(step);
  const cut = line.indexOf(". ");
  return cut > 0 ? line.slice(0, cut + 1) : line;
}
