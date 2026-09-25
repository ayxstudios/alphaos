#!/usr/bin/env node
/**
 * First-run tour check (headless Playwright), for the pointing tour
 * (owner, 2026-09-25: "you only point to what they should click").
 *
 * For each role (admin, va, designer) on a laptop (1440x900) and a phone
 * (390x844, touch):
 *   1. Welcome card offers "Show me around" and "Skip" (no auto-play).
 *   2. Show me around: for every ringed thing (the menu item, then the thing
 *      on the page) the page is dimmed with a rounded cut-out, a pigment ring
 *      sits around the real element, an arrow runs from the card to the ring,
 *      the card shows the two sentences and "N of M", has no Next button and
 *      never covers the element. Nothing moves or changes on its own for
 *      1.2s after arrival and nothing is pressed for the person (untrusted
 *      clicks are recorded in the page). The check then does the real thing
 *      (a click, typing + Enter, a press on the drop zone: no file picker)
 *      and the step must move on by itself. One screenshot per ringed thing.
 *   3. Done card, completion saved, never shows again after a reload.
 *   4. "?" has no Watch item; Show me around rings within 300ms; Back; Esc skips.
 *   5. Quick guide: one screen, a "Point me to it" per step that opens that
 *      page with that step lit, and closes once the person does it.
 * Plus, once: Later hides it until the next sign-in and goes quiet after 3.
 * Screenshots in var/tour-shots/ (gitignored).
 *
 *   npm run test:tour                      # starts proxy + next dev if nothing answers
 *   node scripts/tour-check.mjs --base http://localhost:3476 --roles va --viewports phone
 *
 * LOCAL ONLY: the database it resets must be on localhost (.env.local), see
 * scripts/local-db/setup-tour-db.sh.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true] : [])).filter((x) => x.length),
);

// ---- env + safety -------------------------------------------------------
function envLocal() {
  const out = {};
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
// Values set in the shell win over .env.local, so a check can point at its own
// local database without editing the env file (DIRECT_URL, AUTH_URL,
// NEON_LOCAL_PROXY, DATABASE_URL). The next dev it starts inherits the same.
const ENV = {
  ...envLocal(),
  ...Object.fromEntries(
    ["DIRECT_URL", "DATABASE_URL", "AUTH_URL", "NEON_LOCAL_PROXY"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
  ),
};
const dbUrl = (() => {
  try {
    return new URL(ENV.DIRECT_URL || "");
  } catch {
    return null;
  }
})();
if (!dbUrl || !["localhost", "127.0.0.1"].includes(dbUrl.hostname)) {
  console.error("tour-check: .env.local DIRECT_URL must point at a LOCAL database (see scripts/local-db/setup-tour-db.sh).");
  process.exit(2);
}
const DB = dbUrl.pathname.slice(1);
const PORT = Number(args.port || new URL(ENV.AUTH_URL || "http://localhost:3461").port || 3461);
const BASE = args.base || `http://localhost:${PORT}`;
const PROXY = ENV.NEON_LOCAL_PROXY || "127.0.0.1:5497";
const OUT = path.join(ROOT, args.out || "var/tour-shots");
const PASSWORD = args.password || "tourpass123";
const USERS = {
  admin: { email: "tour-admin@alphaos.test", first: "Amira", steps: 6, paths: ["/orders", "/designers", "/styles", "/settings", "/payouts", "/health"], extra: ["/orders?view=overdue", "/settings?section=email", "/health?scope=all"] },
  va: { email: "tour-va@alphaos.test", first: "Vera", steps: 6, paths: ["/today", "/orders", "/qc", "/emails", "/queue/print"], extra: ["/orders?view=needs_details", "/orders?q=Gwen"] },
  designer: { email: "tour-designer@alphaos.test", first: "Dina", steps: 4, paths: ["/board", "/me"] },
};
const ROLES = String(args.roles || "admin,va,designer").split(",");
const ALL_VIEWPORTS = [
  { name: "laptop", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];
const VIEWPORTS = ALL_VIEWPORTS.filter((v) => String(args.viewports || "laptop,phone").split(",").includes(v.name));
const LIMITS = { firstRing: 300, still: 1200, motionMin: 220, motionMax: 400 };
const timings = [];

function psql(sql) {
  return execFileSync("psql", ["-h", dbUrl.hostname, "-p", dbUrl.port || "5432", "-U", dbUrl.username || "neondb_owner", "-d", DB, "-Atc", sql], { encoding: "utf8" }).trim();
}
const onboardingOf = (email) => JSON.parse(psql(`select coalesce(onboarding::text, 'null') from "user" where email = '${email}'`) || "null");
async function waitForState(email, ok, ms = 30000) {
  const end = Date.now() + ms;
  let s = onboardingOf(email);
  while (!ok(s) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    s = onboardingOf(email);
  }
  return s;
}
const resetOnboarding = (email) => psql(`update "user" set onboarding = null where email = '${email}'`);

// ---- server (reuse, or start proxy + next dev) ---------------------------
const children = [];
async function up(url) {
  try {
    const r = await fetch(url, { redirect: "manual" });
    return r.status > 0;
  } catch {
    return false;
  }
}
async function ensureServer() {
  if (await up(`${BASE}/login`)) return;
  const nodeOptions = "--require ./scripts/local-db/neon-local.cjs --import ./scripts/local-db/neon-local.mjs";
  const env = { ...process.env, NEON_LOCAL_PROXY: PROXY, NODE_OPTIONS: nodeOptions, NEXT_DIST_DIR: ".next-tour" };
  const [ph, pp] = PROXY.split(":");
  const net = await import("node:net");
  const proxyUp = await new Promise((res) => {
    const s = net.connect({ host: ph, port: Number(pp) }, () => (s.end(), res(true)));
    s.on("error", () => res(false));
  });
  if (!proxyUp) children.push(spawn("node", ["scripts/local-db/ws-proxy.mjs", "--port", pp], { cwd: ROOT, stdio: "ignore" }));
  console.log(`starting next dev on :${PORT}`);
  children.push(spawn("npx", ["next", "dev", "-p", String(PORT)], { cwd: ROOT, env, stdio: "ignore" }));
  for (let i = 0; i < 180; i++) {
    if (await up(`${BASE}/login`)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("next dev did not come up");
}
const stopChildren = () => children.forEach((c) => c.kill("SIGTERM"));

// ---- reporting ------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes += 1;
  else failures += 1;
  if (!ok || args.verbose) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---- page helpers -----------------------------------------------------------
async function signIn(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 300000 }), page.click('button[type="submit"]')]);
  await page.waitForLoadState("domcontentloaded");
}

/** Records every click the page did not get from a person (a tour pressing something), except closing a drawer between steps. */
const AUTO_WATCH = () => {
  window.__tourAuto = [];
  window.addEventListener(
    "click",
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (e.isTrusted || !t || t.closest("[data-tour-root], [data-tour-tidy]")) return;
      window.__tourAuto.push((t.getAttribute("data-tour") || t.tagName) + " " + (t.textContent || "").trim().slice(0, 30));
    },
    true,
  );
};

/** The card, the ring, the arrow and the ringed element, measured in one go. */
async function measure(page) {
  return page.evaluate(() => {
    const sheet = document.querySelector("[data-tour-sheet]");
    const lit = document.querySelector("[data-tour-lit]");
    const ring = document.querySelector("[data-tour-ring]");
    const line = document.querySelector("[data-tour-arrow-line]");
    const head = document.querySelector("[data-tour-arrow-head]");
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const lines = (el) => (el ? Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) : 0);
    const d = sheet?.dataset ?? {};
    const path = line?.getAttribute("d") ?? "";
    const nums = path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    const card = sheet?.parentElement;
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      mode: d.mode ?? "",
      phase: d.phase ?? "",
      step: Number(d.step ?? -1),
      steps: Number(d.steps ?? 0),
      act: d.act ?? "",
      firstRing: d.firstRingMs == null ? null : Number(d.firstRingMs),
      line: d.line ?? "",
      whatLines: lines(sheet?.querySelector("[data-tour-what]")),
      todoLines: lines(sheet?.querySelector("[data-tour-todo]")),
      count: sheet?.querySelector("[data-tour-count]")?.textContent?.trim() ?? "",
      next: sheet ? [...sheet.querySelectorAll("button")].some((b) => /^next$/i.test(b.textContent.trim())) : false,
      sheet: box(sheet),
      lit: box(lit),
      litTag: lit ? lit.getAttribute("data-tour") || lit.tagName.toLowerCase() : "",
      ring: box(ring),
      ringOpacity: ring ? Number(getComputedStyle(ring).opacity) : 0,
      dim: ring ? getComputedStyle(ring).boxShadow : "",
      arrow: path ? { start: { x: nums[0], y: nums[1] }, end: { x: nums[nums.length - 2], y: nums[nums.length - 1] } } : null,
      head: !!head?.getAttribute("d"),
      cardMotion: card ? getComputedStyle(card).transitionDuration : "",
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small: sheet ? [...sheet.querySelectorAll("button, a[href]")].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim()) : [],
      path: location.pathname + location.search,
      announce: document.querySelector("[data-tour-root] [aria-live]")?.textContent ?? "",
      auto: window.__tourAuto ?? [],
    };
  });
}
const overlaps = (a, b) => a && b && !(a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1);
const inside = (r, m) => r && r.left >= -1 && r.top >= -1 && r.right <= m.vw + 1 && r.bottom <= m.vh + 1;
const near = (p, r, slack = 16) => p && r && p.x >= r.left - slack && p.x <= r.right + slack && p.y >= r.top - slack && p.y <= r.bottom + slack;
const words = (s) => s.split(/\s+/).filter(Boolean).length;
const sentences = (s) => (s.match(/[a-z][.?!](\s|$)/gi) ?? []).length;

/** A card's body copy: two sentences, two lines at most. */
async function checkCardCopy(tag, locator) {
  const c = await locator.evaluate((el) => {
    const p = el.querySelector("p");
    return { text: p?.textContent?.trim() ?? "", lines: p ? Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)) : 0 };
  });
  check(`${tag}: two plain sentences`, sentences(c.text) === 2 && words(c.text) <= 22 && !c.text.includes("—"), c.text);
  check(`${tag}: two lines at most`, c.lines >= 1 && c.lines <= 2, `${c.lines} lines`);
}

async function shot(page, name) {
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  for (let i = 0; ; i++) {
    try {
      await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 45000 });
      return;
    } catch (error) {
      if (i >= 1) throw error;
    }
  }
}

const motionOk = (d) => d.split(",").every((x) => {
  const ms = parseFloat(x) * (x.trim().endsWith("ms") ? 1 : 1000);
  return ms === 0 || (ms >= LIMITS.motionMin && ms <= LIMITS.motionMax);
});

/** Everything a ringed thing must be: dimmed, ringed, pointed at, explained, clear of the card, and still. */
async function assertPointing(page, label, m, phone) {
  check(`${label}: element ringed`, !!m.lit, m.litTag);
  check(`${label}: ring shown around the element`, m.ringOpacity > 0.9 && m.ring && m.lit && m.ring.left <= m.lit.left + 1 && m.ring.top <= m.lit.top + 1 && m.ring.right >= Math.min(m.lit.right, m.vw - 3) - 1 && m.ring.bottom >= Math.min(m.lit.bottom, m.vh - 3) - 1, `${JSON.stringify(m.ring)} vs ${JSON.stringify(m.lit)}`);
  check(`${label}: page dimmed around a cut-out`, /200vmax|\d{3,}px/.test(m.dim) && (m.dim.match(/rgb/g) ?? []).length >= 2, m.dim.slice(0, 80));
  check(`${label}: arrow from the card to the ring`, !!m.arrow && m.head && near(m.arrow.start, m.sheet) && near(m.arrow.end, m.ring), JSON.stringify(m.arrow));
  check(`${label}: card on screen`, inside(m.sheet, m), JSON.stringify(m.sheet));
  check(`${label}: ringed element on screen`, inside(m.lit, m), `${m.litTag} ${JSON.stringify(m.lit)}`);
  check(`${label}: card never on the element`, !overlaps(m.sheet, m.lit), `${m.litTag} card ${JSON.stringify(m.sheet)} lit ${JSON.stringify(m.lit)}`);
  if (m.mode === "try") check(`${label}: card says N of M`, m.count === `${m.step + 1} of ${m.steps}`, m.count);
  check(`${label}: no Next button`, !m.next);
  check(`${label}: no sideways overflow`, m.overflow <= 1, `${m.overflow}px`);
  if (phone) check(`${label}: tap targets >= 44px`, m.small.length === 0, m.small.join(", "));
  check(`${label}: two short sentences, 12 to 22 words`, sentences(m.line) === 2 && words(m.line) >= 12 && words(m.line) <= 22 && !m.line.includes("—"), m.line);
  check(`${label}: each line wraps to two lines at most`, m.whatLines >= 1 && m.whatLines <= 2 && m.todoLines <= 2, `${m.whatLines}+${m.todoLines}`);
  check(`${label}: card motion 220 to 400ms`, motionOk(m.cardMotion), m.cardMotion);
  check(`${label}: announced`, m.announce.includes(m.line), m.announce);
  // Nothing moves or happens on its own once it has arrived.
  await page.waitForTimeout(LIMITS.still);
  const later = await measure(page);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(`${label}: still after arrival (ring, arrow, card, page)`, same(m.ring, later.ring) && same(m.arrow, later.arrow) && same(m.sheet, later.sheet) && m.path === later.path && later.phase === "turn", `${m.path} -> ${later.path}, ${later.phase}`);
  check(`${label}: nothing pressed for the person`, later.auto.length === 0, later.auto.join(" | "));
}

/** The person does the ringed thing, for real. */
async function perform(page, label, m) {
  const lit = page.locator("[data-tour-lit]");
  if (m.act === "search") {
    await lit.fill("Gwen");
    await lit.press("Enter");
  } else if (m.act === "drop") {
    const chooser = page.waitForEvent("filechooser", { timeout: 1500 }).then(() => true, () => false);
    await lit.click();
    check(`${label}: no real upload (no file picker)`, !(await chooser));
  } else await lit.click();
  const moved = await page
    .waitForFunction(() => {
      const d = document.querySelector("[data-tour-sheet]")?.dataset;
      return !d || d.phase !== "turn" || !["try", "one"].includes(d.mode);
    }, null, { timeout: 10000 })
    .then(() => true, () => false);
  check(`${label}: completes on the person's own action`, moved);
}

/** Waits for the next ringed thing, or for the tour to leave `mode`. */
async function nextTurn(page, mode) {
  await page.waitForFunction(
    (md) => {
      const d = document.querySelector("[data-tour-sheet]")?.dataset;
      return !d || d.mode !== md || (d.phase === "turn" && document.querySelector("[data-tour-lit]"));
    },
    mode,
    { timeout: 30000 },
  );
  // Let the arrival (glide, pulse, arrow draw) finish.
  await page.waitForTimeout(500);
  return measure(page);
}

/** Plays the whole guided tour by doing each ringed thing. */
async function playThrough(page, tag, phone, u) {
  const steps = new Set();
  let n = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const m = await nextTurn(page, "try");
    if (m.mode !== "try") break;
    steps.add(m.step);
    n += 1;
    const label = `${tag} step ${m.step + 1} (${m.act} ${m.litTag})`;
    await assertPointing(page, label, m, phone);
    await shot(page, `${tag}-s${m.step + 1}-${String(n).padStart(2, "0")}-${m.act}`);
    await perform(page, label, m);
  }
  check(`${tag}: every step pointed at`, steps.size === u.steps, `${steps.size}/${u.steps}`);
  return n;
}

async function warmUp(page, u) {
  // A dev server compiles each route on first visit; the timing checks are for a warm one.
  for (const p of [...u.paths, ...(u.extra ?? []), "/help", "/dashboard"]) {
    await page.goto(`${BASE}${p}`, { waitUntil: "load", timeout: 120000 }).catch(() => {});
    if (p === "/qc") {
      const href = await page.locator('main a[href^="/qc/"]').first().getAttribute("href").catch(() => null);
      if (href) await page.goto(`${BASE}${href}`, { waitUntil: "load", timeout: 120000 }).catch(() => {});
    }
  }
}

// ---- the walk -----------------------------------------------------------------
async function walkRole(browser, role, vp) {
  const u = USERS[role];
  const phone = vp.name === "phone";
  const tag = `${role}-${vp.name}`;
  const context = await browser.newContext({ viewport: vp.viewport, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 });
  await context.addInitScript(AUTO_WATCH);
  const page = await context.newPage();
  // A loaded machine can take minutes to compile a route on a dev server; these are ceilings, not targets.
  page.setDefaultNavigationTimeout(300000);
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/Failed to load resource|favicon|Download the React DevTools/.test(msg.text())) errors.push(msg.text().slice(0, 200));
  });

  // Warm the routes with the tour quiet, then a fresh first sign-in.
  psql(`update "user" set onboarding = '{"version":1,"dismissedAt":"2026-01-01T00:00:00.000Z"}' where email = '${u.email}'`);
  await signIn(page, u.email);
  await warmUp(page, u);
  const lazy = await page.evaluate(() => performance.getEntriesByType("resource").some((e) => /tour-runtime/.test(e.name)));
  check(`${tag}: tour code not loaded on an ordinary page`, !lazy);
  await context.clearCookies();
  resetOnboarding(u.email);
  errors.length = 0;
  await signIn(page, u.email);
  if (!page.url().includes("/dashboard")) await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });

  // 1. Welcome.
  const welcome = page.locator('[data-tour-sheet][data-mode="welcome"]');
  await welcome.waitFor({ state: "visible", timeout: 60000 });
  const welcomeText = await welcome.innerText();
  check(`${tag}: welcome greets by first name`, welcomeText.includes(`Welcome, ${u.first}.`), welcomeText.split("\n")[0]);
  await checkCardCopy(`${tag} welcome`, welcome);
  check(`${tag}: welcome is a small card`, await welcome.evaluate((el) => el.getBoundingClientRect().height < window.innerHeight * 0.45));
  check(`${tag}: welcome offers Show me around and Skip`, (await welcome.getByRole("button", { name: "Show me around" }).count()) === 1 && (await welcome.getByRole("button", { name: "Skip", exact: true }).count()) === 1);
  check(`${tag}: no Watch anywhere on the welcome`, !/watch/i.test(welcomeText), welcomeText);
  await page.waitForTimeout(300);
  await shot(page, `${tag}-00-welcome`);

  // 2. Show me around: every step by doing it.
  await welcome.getByRole("button", { name: "Show me around" }).click();
  const first = await nextTurn(page, "try");
  check(`${tag}: Show me around rings the first thing < ${LIMITS.firstRing}ms`, first.firstRing !== null && first.firstRing < LIMITS.firstRing, `${first.firstRing}ms`);
  timings.push({ tag, mode: "welcome", firstRing: first.firstRing });
  await playThrough(page, tag, phone, u);

  // 3. Done, saved, quiet.
  const done = page.locator('[data-tour-sheet][data-mode="done"]');
  await done.waitFor({ state: "visible", timeout: 30000 });
  await checkCardCopy(`${tag} done`, done);
  await shot(page, `${tag}-99-done`);
  await done.getByRole("button", { name: "Done", exact: true }).click();
  check(`${tag}: nothing left on screen after Done`, (await page.locator("[data-tour-sheet], [data-tour-lit], [data-tour-ring]").count()) === 0);
  const state = await waitForState(u.email, (s) => !!s?.completedAt);
  check(`${tag}: completion saved`, !!state?.completedAt && state.version === 1, JSON.stringify(state));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  check(`${tag}: never shows again after completing`, (await page.locator("[data-tour-sheet]").count()) === 0);

  // 4. "?" -> Show me around, timed from the press; Back; Esc skips.
  await page.getByRole("button", { name: "Help", exact: true }).hover();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Help", exact: true }).click();
  check(`${tag}: "?" has no Watch item`, (await page.getByRole("menuitem", { name: /watch/i }).count()) === 0);
  await page.getByRole("menuitem", { name: "Show me around" }).click();
  const m0 = await nextTurn(page, "try");
  check(`${tag}: "?" Show me around rings < ${LIMITS.firstRing}ms`, m0.firstRing !== null && m0.firstRing < LIMITS.firstRing && m0.step === 0, `${m0.firstRing}ms step ${m0.step}`);
  timings.push({ tag, mode: "menu", firstRing: m0.firstRing });
  // Do step 1 (every link of it), then Back.
  let m = m0;
  while (m.mode === "try" && m.step === 0) {
    await perform(page, `${tag} menu step 1`, m);
    m = await nextTurn(page, "try");
  }
  check(`${tag}: step 1 done moves to step 2`, m.step === 1, `${m.step}`);
  await page.locator("[data-tour-sheet]").getByRole("button", { name: "Back", exact: true }).click();
  const backOk = await page.locator('[data-tour-sheet][data-step="0"][data-phase="turn"]').waitFor({ timeout: 30000 }).then(() => true, () => false);
  check(`${tag}: Back goes to the previous step`, backOk);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check(`${tag}: Esc skips the tour`, (await page.locator("[data-tour-sheet]").count()) === 0);
  check(`${tag}: skip saved`, !!(await waitForState(u.email, (s) => !!s?.dismissedAt))?.dismissedAt);

  // 5. Quick guide: one screen, a Point me to it per step.
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("menuitem", { name: "Quick guide" }).click();
  await page.waitForURL("**/help", { timeout: 60000 });
  await page.getByRole("heading", { name: "Quick guide" }).waitFor({ timeout: 60000 });
  const guide = await page.evaluate(() => {
    const ol = document.querySelector("[data-tour-guide]");
    return {
      steps: ol?.querySelectorAll(":scope > li").length ?? 0,
      point: document.querySelectorAll('button[aria-label^="Point me to it:"]').length,
      watch: /watch how/i.test(document.querySelector("main")?.textContent ?? ""),
      listBottom: ol?.getBoundingClientRect().bottom ?? 9999,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check(`${tag}: guide lists the tour steps`, guide.steps === u.steps, `${guide.steps}`);
  check(`${tag}: a Point me to it per step`, guide.point === u.steps, `${guide.point}`);
  check(`${tag}: no Watch on the guide`, !guide.watch);
  check(`${tag}: guide steps fit one screen`, guide.listBottom <= vp.viewport.height - (phone ? 64 : 0), `${Math.round(guide.listBottom)}`);
  check(`${tag}: guide has no sideways overflow`, guide.overflow <= 1, `${guide.overflow}px`);
  await shot(page, `${tag}-help`);
  const pick = Math.min(1, u.steps - 1);
  await page.locator('button[aria-label^="Point me to it:"]').nth(pick).click();
  // The runtime mounts after the press: wait for its card before reading the turn.
  await page.locator('[data-tour-sheet][data-mode="one"]').waitFor({ timeout: 30000 });
  let one = await nextTurn(page, "one");
  check(`${tag}: Point me to it lights that step`, one.mode === "one" && one.step === pick, `${one.mode} ${one.step}`);
  await assertPointing(page, `${tag} point me (${one.act} ${one.litTag})`, one, phone);
  await shot(page, `${tag}-point-me`);
  while (one.mode === "one") {
    await perform(page, `${tag} point me`, one);
    one = await nextTurn(page, "one");
  }
  const closed = await page.waitForFunction(() => !document.querySelector("[data-tour-sheet]"), null, { timeout: 30000 }).then(() => true, () => false);
  check(`${tag}: Point me to it closes after the person does it`, closed);

  check(`${tag}: nothing pressed for the person all walk`, ((await page.evaluate(() => window.__tourAuto ?? [])) ?? []).length === 0);
  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

/** Later: hidden until the next sign-in, quiet after three. */
async function later(browser) {
  const u = USERS.va;
  resetOnboarding(u.email);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(300000);
  page.setDefaultTimeout(180000);
  for (let n = 1; n <= 3; n++) {
    await signIn(page, u.email);
    const welcome = page.locator('[data-tour-sheet][data-mode="welcome"]');
    await welcome.waitFor({ state: "visible", timeout: 60000 });
    check(`later: welcome shows on sign-in ${n}`, true);
    await welcome.getByRole("button", { name: "Later", exact: true }).click();
    await waitForState(u.email, (st) => st?.laterCount === n);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    check(`later: hidden for the rest of sign-in ${n}`, (await page.locator("[data-tour-sheet]").count()) === 0);
    await context.clearCookies();
  }
  check("later: counted 3 times", onboardingOf(u.email)?.laterCount === 3, JSON.stringify(onboardingOf(u.email)));
  await signIn(page, u.email);
  await page.waitForTimeout(2500);
  check("later: quiet after the third Later", (await page.locator("[data-tour-sheet]").count()) === 0);
  await context.close();
}

// ---- main ----------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith(".png")) fs.rmSync(path.join(OUT, f));
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = createRequire("/Users/almacorp2/Documents/ai-employee-agent/package.json")("playwright"));
}

let code = 1;
try {
  await ensureServer();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const role of ROLES) {
      for (const vp of VIEWPORTS) {
        const before = failures;
        try {
          await walkRole(browser, role, vp);
        } catch (error) {
          check(`${role}-${vp.name}: walk finished`, false, String(error?.message || error).split("\n")[0]);
        }
        console.log(`${failures === before ? "ok  " : "FAIL"}  ${role} on ${vp.name}`);
      }
    }
    if (!args["skip-later"]) {
      try {
        await later(browser);
        console.log("ok    later");
      } catch (error) {
        check("later finished", false, String(error?.message || error).split("\n")[0]);
      }
    }
  } finally {
    await browser.close();
  }
  console.log("\ntimings (ms):");
  for (const t of timings) {
    console.log(`  ${t.tag} ${t.mode}: first ring ${t.firstRing}`);
  }
  fs.writeFileSync(path.join(OUT, "timings.json"), JSON.stringify(timings, null, 2));
  console.log(`\n${passes} passed, ${failures} failed. Screenshots: ${path.relative(ROOT, OUT)}/`);
  code = failures ? 1 : 0;
} finally {
  stopChildren();
}
process.exit(code);
