import type { Role } from "@/lib/auth/config";

/**
 * The first-run tour, per role: a short list of demonstrations on the real
 * screen. Shared by the tour (components/tour) and the Quick guide (/help).
 *
 * Each step lives on one page (`path`). The ghost cursor travels there with
 * the real sidebar item (laptop) or bottom tab / More menu (phone), then does
 * the step's `act` for real: opening a list, a tab, a drawer, the search box,
 * a filter. Nothing is ever sent, assigned, passed or uploaded. Then the
 * person does the same thing themselves.
 *
 * `say` is the step's only line of copy: second person, 9 words at most,
 * written as the instruction the cursor is demonstrating.
 *
 * Targets are CSS selectors, tried in order; `css@@Text` also requires the
 * element's text to start with Text. The first visible match wins.
 */
export type Sel = string[];

export type TourAct =
  /** The step's own sidebar item / bottom tab is the thing to press. */
  | { kind: "nav"; say: string }
  /** Press an element on the page. `undo` puts the page back before "Your turn". */
  | {
      kind: "click";
      target: Sel;
      say: string;
      undo: "back" | "close" | "reclick" | { click: Sel };
      via?: Sel;
      /** When the target is already the selected one, quietly open this first. */
      reset?: string;
    }
  /** Type into a search box and press Enter (the demo types a name from the page). */
  | { kind: "search"; target: Sel; say: string; sample: Sel }
  /** Show a sample file landing on an upload drop zone. Never uploads. */
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

const VA_STEPS: TourStep[] = [
  {
    id: "today",
    title: "Today",
    path: "/today",
    acts: [],
    nav: { kind: "nav", say: "Open Today to see what needs you first." },
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
        say: "Type a name, then press Enter to search.",
      },
    ],
    nav: { kind: "nav", say: "Open Orders to see every order." },
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
        say: "Open Needs Details for orders missing information.",
      },
    ],
    nav: { kind: "nav", say: "Open Orders to see every order." },
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
        say: "Press Start QC to check the next portrait.",
      },
    ],
    nav: { kind: "nav", say: "Open QC to see portraits waiting for you." },
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
        say: "Open All mail to see every customer email.",
      },
    ],
    nav: { kind: "nav", say: "Open Messages to answer customer email." },
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
        say: "Open Details to see where each print is.",
      },
    ],
    nav: { kind: "nav", say: "Open Print for orders ready to print." },
  },
];

const DESIGNER_STEPS: TourStep[] = [
  {
    id: "board",
    title: "My Board",
    path: "/board",
    acts: [],
    nav: { kind: "nav", say: "Open My Board to see your orders." },
  },
  {
    id: "card",
    title: "Open a card",
    path: "/board",
    acts: [{ kind: "click", target: CARDS, undo: "close", say: "Open a card to see the order." }],
    nav: { kind: "nav", say: "Open My Board to see your orders." },
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
        say: "Drop your finished portrait here.",
      },
    ],
    nav: { kind: "nav", say: "Open My Board to see your orders." },
  },
  {
    id: "week",
    title: "My Week",
    path: "/me",
    acts: [],
    nav: { kind: "nav", say: "Open My Week to see what is due." },
  },
];

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
        say: "Open Overdue to see every late order.",
      },
    ],
    nav: { kind: "nav", say: "Open Orders to see every order." },
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
        say: "Choose a group to see who can sign in.",
      },
    ],
    nav: { kind: "nav", say: "Open Designer Roster to manage your team." },
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
        say: "Open Designers to choose who draws each style.",
      },
    ],
    nav: { kind: "nav", say: "Open Portrait Styles to set styles and rates." },
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
        say: "Open Customer Email to set up customer mail.",
      },
    ],
    nav: { kind: "nav", say: "Open Settings to connect shops and email." },
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
        say: "Choose a designer to see what they earned.",
      },
    ],
    nav: { kind: "nav", say: "Open Money to see what designers earned." },
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
        say: "Choose All Businesses to check every shop at once.",
      },
    ],
    nav: { kind: "nav", say: "Open System Health when numbers look wrong." },
  },
];

export const TOUR_STEPS: Record<Role, TourStep[]> = {
  admin: ADMIN_STEPS,
  va: VA_STEPS,
  designer: DESIGNER_STEPS,
};

/** The line the Quick guide shows for a step (its preferred act). */
export function stepLine(step: TourStep): string {
  return (step.acts[0] ?? step.nav).say;
}

