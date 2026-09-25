import type { Sel, TourAct, TourStep } from "./steps";

/**
 * The tour's eyes: finds the real element for each step and points at it.
 * It never presses anything for the person (owner, 2026-09-25: "you should
 * have them click it, you only point to what they should click"). Each step
 * is a short chain of links (the menu item that opens the page, then the
 * thing on the page); the runtime rings each link and waits for the person's
 * own click, Enter or press. Browser only; imported by the lazily loaded tour
 * runtime.
 *
 * The only things it ever does by itself are quiet housekeeping between
 * steps: closing a drawer the person opened in an earlier step when the next
 * step lies elsewhere, opening a list at its plain view when the thing to
 * press is already the selected one, and (from the Quick guide's "Point me
 * to it") opening the step's page.
 */

export class TourAborted extends Error {
  constructor() {
    super("tour aborted");
  }
}

/** One thing to point at, and what the card says while it is ringed. */
export type Link = {
  sel: Sel;
  line: string;
  /** How the person completes it: a click, a search (Enter), or a press on a drop zone. */
  kind: "nav" | "more" | "click" | "search" | "drop";
};

export type Hooks = {
  signal: AbortSignal;
  router: { push(href: string): void; prefetch(href: string): void };
  /** Ring the link's element and resolve when the person has done it. */
  point(link: Link): Promise<void>;
  /** Nothing to point at while a page opens: the card shows `line`, the ring rests. */
  rest(line: string): void;
};

const here = () => location.pathname + location.search;

function check(h: Pick<Hooks, "signal">) {
  if (h.signal.aborted) throw new TourAborted();
}

/** Polls every frame until `fn` returns something truthy, or `timeout` ms pass (null). */
export async function waitFor<T>(h: Pick<Hooks, "signal">, fn: () => T | null | undefined | false, timeout = 8000): Promise<T | null> {
  const end = performance.now() + timeout;
  for (;;) {
    check(h);
    const v = fn();
    if (v) return v;
    if (performance.now() > end) return null;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
}

export function isShown(el: Element): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  if (el.closest('[aria-hidden="true"], [data-tour-root]')) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}

function matches(el: Element, text: string | undefined) {
  return !text || (el.textContent ?? "").trim().startsWith(text);
}

/** First visible element for the candidates, in order. */
export function find(sel: Sel, scope: ParentNode = document): HTMLElement | null {
  for (const cand of sel) {
    const [css, text] = cand.split("@@");
    for (const el of scope.querySelectorAll<HTMLElement>(css)) if (isShown(el) && matches(el, text)) return el;
  }
  return null;
}

/** Open dialogs and drawers that are not the tour's own. */
function openDialogs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((d) => isShown(d));
}

function navDrawerClose(): HTMLElement | null {
  return find(['button[aria-label="Close navigation"]']);
}

/** Closes open dialogs, drawers and the phone menu between steps (housekeeping, never a lesson). */
export async function closeOverlays(h: Pick<Hooks, "signal">) {
  let acted = false;
  for (const d of openDialogs()) {
    const x = d.querySelector<HTMLElement>('button[aria-label="Close"]');
    if (x) {
      x.setAttribute("data-tour-tidy", "");
      x.click();
      acted = true;
    }
  }
  const nav = navDrawerClose();
  if (nav) {
    nav.setAttribute("data-tour-tidy", "");
    nav.click();
    acted = true;
  }
  if (acted) await waitFor(h, () => openDialogs().length === 0 && !navDrawerClose(), 800);
}

/** The sidebar item, or the bottom tab, or More then the item in the menu. */
export function navChain(path: string): Sel[] {
  const nav = [`[data-tour="nav:${path}"]`];
  if (find(nav)) return [nav];
  const tab = [`[data-tour="tab:${path}"]`];
  if (find(tab)) return [tab];
  return [['[data-tour="tab:more"]'], nav];
}

/** The menu's own name for a page ("Messages"), read off the sidebar. */
function navLabel(path: string, fallback: string) {
  const el = document.querySelector(`[data-tour="nav:${path}"] span:last-child`);
  return el?.textContent?.trim() || fallback;
}

/** The links that walk to a page with the real menu, each with its line. */
export function navLinks(step: TourStep): Link[] {
  const chain = navChain(step.path);
  if (chain.length === 1) return [{ sel: chain[0], line: step.nav.say, kind: "nav" }];
  const label = navLabel(step.path, step.title);
  return [
    { sel: chain[0], line: `${label} is in the More menu at the bottom. Tap More, then tap ${label}.`, kind: "more" },
    { sel: chain[1], line: step.nav.say, kind: "nav" },
  ];
}

/** A tab or link that is already the current one (pressing it changes nothing). */
function isSelected(el: HTMLElement) {
  if (el.getAttribute("aria-current") === "page" || el.getAttribute("aria-selected") === "true") return true;
  return el instanceof HTMLAnchorElement && new URL(el.href).pathname + new URL(el.href).search === here();
}

/** The page has painted its real content (no loading skeletons left). */
function pageReady(path: string) {
  return location.pathname === path && !!document.querySelector("main h1") && !document.querySelector("main .animate-pulse");
}

/**
 * Submits a GET search form in place (client navigation, same URL the form
 * would load), so the tour never reloads the page under the person.
 */
export function submitGet(h: Pick<Hooks, "router">, form: HTMLFormElement) {
  const params = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (typeof v === "string" && v !== "") params.set(k, v);
  const action = form.getAttribute("action") || location.pathname;
  h.router.push(params.size ? `${action}?${params}` : action);
}

function actTarget(act: TourAct): Sel | null {
  return act.kind === "nav" ? null : act.target;
}

/**
 * One step: walk to its page with the real menu (the person clicks each
 * item), then ring the thing on the page and wait for the person to do it.
 * `open` (the Quick guide's "Point me to it") opens the page quietly instead.
 * When the page has nothing to act on (an empty queue), the menu item was
 * the lesson.
 */
export async function runStep(h: Hooks, step: TourStep, open = false): Promise<void> {
  // An earlier step's drawer is in the way, unless this step happens inside it.
  if (openDialogs().length || navDrawerClose()) {
    const inDialog = step.acts.some((a) => {
      const t = actTarget(a);
      const via = "via" in a && a.via ? a.via : null;
      return openDialogs().some((d) => (t && find(t, d)) || (via && find(via, d)));
    });
    if (!inDialog) await closeOverlays(h);
  }

  let walked = false;
  if (step.acts.length === 0) {
    // The menu item IS the lesson.
    for (const link of navLinks(step)) await h.point(link);
    return;
  }
  if (location.pathname !== step.path) {
    if (open) {
      h.rest(step.acts[0].say);
      h.router.push(step.path);
    } else {
      for (const link of navLinks(step)) await h.point(link);
      walked = true;
      h.rest(step.acts[0].say);
    }
    await waitFor(h, () => pageReady(step.path), 15000);
  }

  // The first act the page can do right now (short grace for late content).
  const pick = () => {
    for (const act of step.acts) {
      if (act.kind === "nav") continue;
      if (find(act.target)) return { act, via: null as Sel | null };
      const via = "via" in act && act.via ? act.via : null;
      if (via && find(via)) return { act, via };
    }
    return null;
  };
  const got = await waitFor(h, pick, 1200);
  if (!got) {
    // Nothing to act on here. Just walked in with the menu: that was the step.
    if (walked) return;
    for (const link of navLinks(step)) await h.point({ ...link, line: link.kind === "nav" ? step.nav.say : link.line });
    return;
  }
  const { act, via } = got;
  if (act.kind === "nav") return;
  if (via) {
    // The drop zone lives inside a card: the person opens the card first.
    await h.point({ sel: via, line: act.say, kind: "click" });
    if (!(await waitFor(h, () => find(act.target), 5000))) return;
  }
  if (act.kind === "click" && act.reset) {
    const el = find(act.target);
    if (el && isSelected(el)) {
      // Already showing what the press would open: start from the plain view.
      const from = here();
      h.router.push(act.reset);
      await waitFor(h, () => here() !== from && pageReady(step.path) && find(act.target) && !isSelected(find(act.target)!), 6000);
    }
  }
  await h.point({ sel: act.target, line: act.say, kind: act.kind });
}

/** The line a step opens with (what the card says before anything is ringed). */
export function firstLine(step: TourStep): string {
  return (step.acts[0] ?? step.nav).say;
}
