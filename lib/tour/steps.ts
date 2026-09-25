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
 * `say` is the step's copy: two short plain sentences, 12 to 22 words. The
 * first says what the thing is, the second what to do (what the pointer
 * demonstrates). Second person, no jargon.
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
    nav: { kind: "nav", say: "Today lists what needs you first. Open it and work from the top down." },
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
        say: "Search finds any order fast. Type a customer's name, then press Enter.",
      },
    ],
    nav: { kind: "nav", say: "Orders holds every order from every shop. Open it to find the one you need." },
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
        say: "Some orders arrive missing information. Open Needs details to see which ones need you.",
      },
    ],
    nav: { kind: "nav", say: "Orders holds every order from every shop. Open it to find the one you need." },
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
        say: "Finished portraits wait here for your check. Press Start QC to review the next one.",
      },
    ],
    nav: { kind: "nav", say: "Finished portraits wait here for your check. Open QC to see what is waiting." },
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
        say: "Messages holds every customer email. Open All mail to read or search them.",
      },
    ],
    nav: { kind: "nav", say: "Messages holds every customer email. Open it to answer the ones waiting on you." },
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
        say: "Print lists approved orders ready to print. Open Details to see where each one is.",
      },
    ],
    nav: { kind: "nav", say: "Print lists approved orders ready to print. Open it to send the next one." },
  },
];

const DESIGNER_STEPS: TourStep[] = [
  {
    id: "board",
    title: "My Board",
    path: "/board",
    acts: [],
    nav: { kind: "nav", say: "My Board holds every order given to you. Open it to see what is due first." },
  },
  {
    id: "card",
    title: "Open a card",
    path: "/board",
    acts: [{ kind: "click", target: CARDS, undo: "close", say: "Each card is one order with the customer's photos. Open a card to see the details." }],
    nav: { kind: "nav", say: "My Board holds every order given to you. Open it to see what is due first." },
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
        say: "Your finished portrait goes on the order card. Add it here when the design is done.",
      },
    ],
    nav: { kind: "nav", say: "My Board holds every order given to you. Open it to see what is due first." },
  },
  {
    id: "week",
    title: "My Week",
    path: "/me",
    acts: [],
    nav: { kind: "nav", say: "My Week shows your deadlines and what you earned. Check it at the start of each day." },
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
        say: "Orders holds every order from every shop. Open Overdue to see the late ones first.",
      },
    ],
    nav: { kind: "nav", say: "Orders holds every order from every shop. Open it to search or filter." },
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
        say: "Team and sign-ins lists everyone who can sign in. Choose a group to see who is in it.",
      },
    ],
    nav: { kind: "nav", say: "Designers lists who gets new orders, top first. Open it to manage your team." },
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
        say: "Each style goes to the designers who draw it. Open Designers to choose who they are.",
      },
    ],
    nav: { kind: "nav", say: "Portrait styles set who draws what and at what rate. Open it to change them." },
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
        say: "Settings connects your shops, email and printers. Open Customer Email to connect your mailbox.",
      },
    ],
    nav: { kind: "nav", say: "Settings connects your shops, email and printers. Open it when you add a shop." },
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
        say: "Money shows what each designer has earned. Choose a designer to see their orders.",
      },
    ],
    nav: { kind: "nav", say: "Money shows what each designer has earned. Open it to mark payments as paid." },
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
        say: "Health flags problems behind the scenes. Choose All Businesses to check every shop at once.",
      },
    ],
    nav: { kind: "nav", say: "Health flags problems behind the scenes. Open it when numbers look wrong." },
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


/** Just the first sentence (what the thing is), for the Quick guide's one-screen list. */
export function stepWhat(step: TourStep): string {
  const line = stepLine(step);
  const cut = line.indexOf(". ");
  return cut > 0 ? line.slice(0, cut + 1) : line;
}
