import type { Role } from "@/lib/auth/config";

/**
 * The first-run tour, per role. Shared by the tour itself
 * (components/tour/tour.tsx) and the Quick guide (/help), so the two always
 * teach the same steps. Every sentence describes what the page really does
 * today; when a page changes, change its step here.
 *
 * Targets are `data-tour` attribute values:
 *  - `nav`  the sidebar item (laptop),
 *  - `tab`  the phone bottom tab, when that page has one (else "More" is lit),
 *  - `page` an element on the page itself, used once the person is there
 *    (comma separated fallbacks: a board column may be empty on a phone).
 */
export type TourStep = {
  id: string;
  title: string;
  /** One sentence: what it is. */
  what: string;
  /** One sentence: what you do there. */
  how: string;
  /** Where "Try it" goes. */
  href: string;
  nav: string;
  tab?: string;
  page?: string;
};

const HOME_STAFF: TourStep = {
  id: "home",
  title: "Home",
  what: "Home is your start page, with the day's numbers at a glance.",
  how: "Look here first to see what needs you and what is running late.",
  href: "/dashboard",
  nav: "nav:/dashboard",
  tab: "tab:/dashboard",
};

const ORDERS: TourStep = {
  id: "orders",
  title: "Orders",
  what: "Orders holds every order from every shop, with a tab for each kind of work.",
  how: "Open the Needs Details tab and fill in any order that came in without its full details.",
  href: "/orders?view=needs_details",
  nav: "nav:/orders",
  tab: "tab:/orders",
  page: "page:orders",
};

const QC: TourStep = {
  id: "qc",
  title: "QC",
  what: "QC is where finished portraits wait for your check before the customer sees them.",
  how: "Tick every item on the checklist, type your name, then press Pass or Fail.",
  href: "/qc",
  nav: "nav:/qc",
  page: "page:qc",
};

const MESSAGES: TourStep = {
  id: "messages",
  title: "Messages",
  what: "Messages holds customer email, with anything that needs you at the top.",
  how: "Link each reply to its order, then answer it or send the drafts that are waiting.",
  href: "/emails",
  nav: "nav:/emails",
  tab: "tab:/emails",
  page: "page:messages",
};

const VA_STEPS: TourStep[] = [
  HOME_STAFF,
  {
    id: "today",
    title: "Today",
    what: "Today is one list of everything waiting on a person, most urgent at the top.",
    how: "Work from the top down; each row opens the order it is about.",
    href: "/today",
    nav: "nav:/today",
    tab: "tab:/today",
    page: "page:today",
  },
  ORDERS,
  QC,
  MESSAGES,
  {
    id: "designers",
    title: "Designers",
    what: "Designers shows each designer's board: what they are working on and when it is due.",
    how: "Pick a name to see their orders, and open a card to check on one.",
    href: "/board",
    nav: "nav:/board",
    page: "page:designers",
  },
  {
    id: "print",
    title: "Print",
    what: "Print lists approved orders that need a printed copy, oldest first.",
    how: "Place the print with the print company, press Sent to print, then add the tracking number.",
    href: "/queue/print",
    nav: "nav:/queue/print",
    page: "page:print",
  },
];

const DESIGNER_STEPS: TourStep[] = [
  {
    id: "home",
    title: "Home",
    what: "Home shows your own day: what is due, what is late and what you have earned.",
    how: "Look here first to decide which order to work on next.",
    href: "/dashboard",
    nav: "nav:/dashboard",
    tab: "tab:/dashboard",
  },
  {
    id: "board",
    title: "My Board",
    what: "My Board holds every order given to you, soonest deadline first.",
    how: "Press Start on an order in My Queue when you begin working on it.",
    href: "/board",
    nav: "nav:/board",
    tab: "tab:/board",
    page: "col:myQueue,page:board",
  },
  {
    id: "upload",
    title: "Upload your portrait",
    what: "Open an order card to see the customer's photos and notes.",
    how: "Upload the finished portrait on that card, then send it to Awaiting QC.",
    href: "/board",
    nav: "nav:/board",
    tab: "tab:/board",
    page: "col:inDesign,page:board",
  },
  {
    id: "fixes",
    title: "Fixes",
    what: "A portrait that needs changes comes back under Failed QC or Revisions, with a note.",
    how: "Read the note, upload a new version and send it back to QC.",
    href: "/board",
    nav: "nav:/board",
    tab: "tab:/board",
    page: "col:failedQc,col:revisions,page:board",
  },
  {
    id: "week",
    title: "My Week",
    what: "My Week shows your deadlines for the days ahead and what you have earned.",
    how: "Check it at the start of each day to plan your work.",
    href: "/me",
    nav: "nav:/me",
    tab: "tab:/me",
    page: "page:week",
  },
];

const ADMIN_STEPS: TourStep[] = [
  {
    ...HOME_STAFF,
    what: "Home shows how the business is doing: orders in, on time, overdue and designer pay.",
    how: "Look here first, then tap any number to see the orders behind it.",
  },
  {
    ...ORDERS,
    how: "Search by order number or customer, or open a tab such as Needs Details or Overdue.",
  },
  QC,
  MESSAGES,
  {
    id: "roster",
    title: "Designer Roster",
    what: "Designer Roster is the list new orders are handed out from, top to bottom.",
    how: "Set each designer's styles and daily limit here so work goes to the right person.",
    href: "/designers",
    nav: "nav:/designers",
    page: "page:roster",
  },
  {
    id: "money",
    title: "Money",
    what: "Money shows what each designer has earned and what is still to pay.",
    how: "Mark payments as paid once you have sent them, or export the list.",
    href: "/payouts",
    nav: "nav:/payouts",
    page: "page:money",
  },
  {
    id: "settings",
    title: "Settings",
    what: "Settings is where shops, customer email, portrait styles and print companies are connected.",
    how: "Come here when you add a shop or something stops coming in.",
    href: "/settings",
    nav: "nav:/settings",
    page: "page:settings",
  },
  {
    id: "health",
    title: "System Health",
    what: "System Health tells you when anything behind the scenes needs a look.",
    how: "Check it when numbers look wrong; anything listed at the top needs attention.",
    href: "/health",
    nav: "nav:/health",
    page: "page:health",
  },
];

export const TOUR_STEPS: Record<Role, TourStep[]> = {
  admin: ADMIN_STEPS,
  va: VA_STEPS,
  designer: DESIGNER_STEPS,
};

const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** "Seven short steps and you are ready." */
export function stepsSentence(role: Role): string {
  const n = TOUR_STEPS[role].length;
  return `${WORDS[n] ?? n} short steps and you are ready.`;
}

/** The pathname part of a step's link, for "am I already on this page?". */
export function stepPath(step: TourStep): string {
  return step.href.split("?")[0];
}
