import type { Sel, TourAct, TourStep } from "./steps";

/**
 * The tour's hands: finds real elements, moves the ghost cursor to them and
 * presses them for real (a real click, so the real page responds). Browser
 * only; imported by the lazily loaded tour runtime.
 */

export class TourAborted extends Error {
  constructor() {
    super("tour aborted");
  }
}

export type Ghost = {
  /** Glide (or jump, with reduced motion) so the pointer's tip sits on x,y. */
  moveTo(x: number, y: number): Promise<void>;
  /** Press down and ripple. Resolves once the press lands (120ms). */
  press(): Promise<void>;
  /** A sample file riding along with the pointer (the upload demo). */
  carry(on: boolean): void;
  /** Lift the pointer off the screen (it comes back on the next move). */
  lift(): void;
};

export type Hooks = {
  signal: AbortSignal;
  reduced: boolean;
  isPaused(): boolean;
  ghost: Ghost;
  router: { push(href: string): void; back(): void; prefetch(href: string): void };
  /** Light an element: the ring follows it. */
  light(el: HTMLElement | null): void;
  /** Land the sample file on an element (never uploads anything). */
  sample(el: HTMLElement): void;
  /** Space the tour's own sheet takes at the bottom of the screen. */
  reserveBottom(): number;
  /** Time spent waiting on the server during the current demonstration. */
  stats: { netMs: number };
  /** How long the pointer rests on an element before pressing it. */
  dwell: number;
};

/** What a demonstration did, so it can be undone and handed to the person. */
export type Demo = {
  act: TourAct;
  line: string;
  /** Where we were just before the act (for undo "back"). */
  before: string;
  /** Where we were before travelling (for a nav act's undo). */
  origin: string;
  /** The element that was pressed. */
  el: HTMLElement | null;
};

const here = () => location.pathname + location.search;

function check(h: Hooks) {
  if (h.signal.aborted) throw new TourAborted();
}

/** Waits `ms` of unpaused time. */
export async function sleep(h: Hooks, ms: number) {
  let left = ms;
  let last = performance.now();
  while (left > 0) {
    check(h);
    await new Promise((r) => setTimeout(r, Math.min(left, 16)));
    const now = performance.now();
    if (!h.isPaused()) left -= now - last;
    last = now;
  }
  check(h);
}

/** A wait on the server (a page loading), counted apart from the tour's own motion. */
async function waitNet<T>(h: Hooks, fn: () => T | null | undefined | false, timeout: number): Promise<T | null> {
  const t0 = performance.now();
  try {
    return await waitFor(h, fn, timeout);
  } finally {
    h.stats.netMs += performance.now() - t0;
  }
}

/** Polls every frame until `fn` returns something truthy, or `timeout` ms pass (null). */
export async function waitFor<T>(h: Hooks, fn: () => T | null | undefined | false, timeout = 8000): Promise<T | null> {
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

/** Like find, but visibility does not matter (reading text off the page). */
function findAny(sel: Sel): HTMLElement | null {
  for (const cand of sel) {
    const [css, text] = cand.split("@@");
    for (const el of document.querySelectorAll<HTMLElement>(css)) if (!el.closest("[data-tour-root]") && matches(el, text)) return el;
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

/** Closes open dialogs, drawers and the phone menu, the way a person would. */
export async function closeOverlays(h: Hooks) {
  let acted = false;
  for (const d of openDialogs()) {
    const x = d.querySelector<HTMLElement>('button[aria-label="Close"]');
    if (x) {
      x.click();
      acted = true;
    }
  }
  const nav = navDrawerClose();
  if (nav) {
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

/** Brings an element into the calm part of the screen (not under the sheet). */
async function intoView(h: Hooks, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const bottom = window.innerHeight - h.reserveBottom();
  const across = r.left >= 0 && r.right <= window.innerWidth;
  if (r.top >= 56 && r.bottom <= bottom && across) return;
  // A row that scrolls sideways (the Orders tabs on a phone) is centred too.
  el.scrollIntoView({ block: "center", inline: across ? "nearest" : "center", behavior: h.reduced ? "auto" : "smooth" });
  // Wait for the scroll to settle (two frames with the same position).
  let last = -1;
  let same = 0;
  await waitFor(
    h,
    () => {
      const top = Math.round(el.getBoundingClientRect().top * 1000 + el.getBoundingClientRect().left);
      same = top === last ? same + 1 : 0;
      last = top;
      return same >= 2;
    },
    700,
  );
}

function centre(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Glide to an element and press it for real. */
export async function press(h: Hooks, el: HTMLElement) {
  await intoView(h, el);
  h.light(el);
  const { x, y } = centre(el);
  await h.ghost.moveTo(x, y);
  if (h.dwell) await sleep(h, h.dwell);
  await h.ghost.press();
  check(h);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus({ preventScroll: true });
  else el.click();
}

/** Something (a dialog, a drawer) now sits on top of the element. */
function covered(el: HTMLElement) {
  if (!el.isConnected) return true;
  const r = el.getBoundingClientRect();
  // The first layer under the tour's own (its shield sits over everything).
  const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find((e) => !e.closest("[data-tour-root]"));
  return !!top && !el.contains(top);
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

/** No loading skeletons left on the page. */
function settled(h: Hooks) {
  return waitFor(h, () => !document.querySelector("main .animate-pulse"), 3000);
}

/** Walks to a step's page with the real menu, if not there already. */
export async function travel(h: Hooks, path: string) {
  if (location.pathname === path) return;
  await closeOverlays(h);
  for (const sel of navChain(path)) {
    const el = await waitFor(h, () => find(sel), 2500);
    if (!el) {
      h.router.push(path);
      break;
    }
    await press(h, el);
  }
  await waitNet(h, () => location.pathname === path, 15000);
}

function actTargets(act: TourAct): Sel | null {
  return act.kind === "nav" ? null : act.target;
}

/** Sets an input's value the way typing does, so React and forms see it. */
function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

/**
 * Plays one step's demonstration on the real page: travel there, then do
 * the act for real. Falls back to pressing the page's own menu item when
 * the page has nothing to act on (an empty queue).
 */
export async function demonstrate(h: Hooks, step: TourStep): Promise<Demo> {
  const origin = here();

  // Not on the same page as an open dialog we still need: tidy up first.
  if (openDialogs().length || navDrawerClose()) {
    const inDialog = step.acts.some((a) => {
      const t = actTargets(a);
      return t && openDialogs().some((d) => find(t, d));
    });
    if (!inDialog) await closeOverlays(h);
  }

  if (step.acts.length === 0) {
    // The menu item IS the lesson.
    if (location.pathname === step.path) {
      const [first] = navChain(step.path);
      const el = find(first);
      if (el) await press(h, el);
    } else await travel(h, step.path);
    // Let the page itself be the picture, not its loading skeleton.
    await waitNet(h, () => pageReady(step.path), 12000);
    return { act: step.nav, line: step.nav.say, before: origin, origin, el: null };
  }

  await travel(h, step.path);
  await waitNet(h, () => pageReady(step.path), 12000);

  // Pick the first act the page can do right now (short grace for late content).
  const pick = () => {
    for (const act of step.acts) {
      if (act.kind === "nav") continue;
      const el = find(act.target);
      if (el) return { act, el, via: null as HTMLElement | null };
      const via = "via" in act && act.via ? find(act.via) : null;
      if (via) return { act, el: null, via };
    }
    return null;
  };
  const got = (await waitFor(h, pick, 600)) ?? null;
  if (!got) {
    // Nothing to act on: the page's own menu item is the lesson.
    const [first] = navChain(step.path);
    const el = find(first);
    if (el) {
      h.light(el);
      const { x, y } = centre(el);
      await h.ghost.moveTo(x, y);
    }
    return { act: step.nav, line: step.nav.say, before: origin, origin, el: null };
  }

  const { act } = got;
  let el = got.el;
  if (!el && got.via) {
    await press(h, got.via);
    el = await waitFor(h, () => find(act.target), 4000);
    if (!el) return { act: step.nav, line: step.nav.say, before: origin, origin, el: null };
  }
  let target = el!;
  if (act.kind === "click" && act.reset && isSelected(target)) {
    // Already showing what the act would open: start from the plain view.
    h.router.push(act.reset);
    await waitNet(h, () => here() !== origin && pageReady(step.path) && find(act.target) && !isSelected(find(act.target)!), 6000);
    target = find(act.target) ?? target;
  }
  const before = here();

  if (act.kind === "click") {
    // Fetch the page the press opens while the pointer is still on its way.
    if (target instanceof HTMLAnchorElement) h.router.prefetch(target.href);
    await press(h, target);
    if (act.undo === "back") await waitNet(h, () => here() !== before && !document.querySelector("main .animate-pulse"), 3500);
    else if (act.undo === "close") await waitFor(h, () => openDialogs().length > 0, 4000);
    await sleep(h, 220);
    // The page re-rendered: keep the (new) pressed element in view and lit,
    // unless whatever opened now covers it.
    const now = target.isConnected ? target : find(act.target);
    if (!now || covered(now)) {
      // A new page or a drawer: the finger lifts instead of hovering over nothing.
      h.light(null);
      h.ghost.lift();
    } else {
      const was = now.getBoundingClientRect();
      await intoView(h, now);
      h.light(now);
      const r = now.getBoundingClientRect();
      if (Math.abs(r.left - was.left) > 1 || Math.abs(r.top - was.top) > 1) {
        // The row scrolled under the pointer: the pointer rests on the element again.
        await h.ghost.moveTo(r.left + r.width / 2, r.top + r.height / 2);
      }
    }
  } else if (act.kind === "search") {
    const input = target as HTMLInputElement;
    await press(h, input);
    const source = findAny(act.sample);
    const raw = source?.getAttribute("title") || source?.textContent || "";
    const word = raw.trim().split(/\s+/)[0] || "Emma";
    const perChar = Math.max(24, Math.floor(360 / word.length));
    for (let i = 1; i <= word.length; i++) {
      setValue(input, word.slice(0, i));
      await sleep(h, perChar);
    }
    await sleep(h, 120);
    if (input.form) submitGet(h, input.form);
    await waitNet(h, () => location.search.includes("q=") && pageReady(step.path), 8000);
  } else if (act.kind === "drop") {
    await intoView(h, target);
    h.light(target);
    const r = target.getBoundingClientRect();
    // Start just below and to the right of the drop zone, carrying the file.
    const sx = Math.min(window.innerWidth - 72, r.right - 24);
    const sy = Math.min(window.innerHeight - h.reserveBottom() - 16, r.bottom + 72);
    await h.ghost.moveTo(sx, sy);
    h.ghost.carry(true);
    await sleep(h, 120);
    const c = centre(target);
    await h.ghost.moveTo(c.x, c.y);
    await h.ghost.press();
    h.ghost.carry(false);
    h.sample(target);
    await sleep(h, 220);
  }
  return { act, line: act.say, before, origin, el: target };
}

/** Puts the page back the way it was, so the person can do it themselves. */
export async function undo(h: Hooks, demo: Demo) {
  const { act } = demo;
  if (act.kind === "nav") {
    if (here() !== demo.origin && location.pathname !== new URL(demo.origin, location.href).pathname) {
      h.router.back();
      await waitFor(h, () => here() === demo.origin, 8000);
      await settled(h);
    }
    return;
  }
  if (act.kind === "search") {
    if (here() !== demo.before) {
      h.router.back();
      await waitFor(h, () => here() === demo.before, 8000);
    }
    const input = await waitFor(h, () => find(act.target), 4000);
    if (input instanceof HTMLInputElement) setValue(input, "");
    return;
  }
  if (act.kind !== "click") return;
  if (act.undo === "back") {
    if (here() !== demo.before) {
      h.router.back();
      await waitFor(h, () => here() === demo.before, 8000);
    }
    await waitFor(h, () => find(act.target), 4000);
    await settled(h);
  } else if (act.undo === "close") {
    await closeOverlays(h);
  } else if (act.undo === "reclick") {
    const el = demo.el && demo.el.isConnected ? demo.el : find(act.target);
    el?.click();
  } else {
    find(act.undo.click)?.click();
  }
  await sleep(h, 120);
}

/** What the person presses on their turn: one element, or More then the item. */
export function turnChain(step: TourStep, demo: Demo): Sel[] {
  if (demo.act.kind === "nav") return navChain(step.path);
  return [demo.act.target];
}
