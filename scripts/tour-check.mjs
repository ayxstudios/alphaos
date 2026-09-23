#!/usr/bin/env node
/**
 * First-run tour check (headless Playwright), for the show-don't-tell tour.
 *
 * For each role (admin, va, designer) on a laptop (1280x800) and a phone
 * (390x844, touch, reduced motion):
 *   1. Welcome card -> "Watch how it works": plays every step on its own to
 *      the end card. Start to first ghost movement < 300ms, each step's
 *      demonstration < 4s, the whole watch 30 to 45s, the sheet never on the
 *      lit element, nothing overflows sideways.
 *   2. "Now you try": every step demonstrates, then waits; the check performs
 *      the real action on the lit element (a click, typing + Enter, a press
 *      on the drop zone) and the step must complete by itself. Same timing and
 *      overlap checks, phone tap targets >= 44px, one screenshot per step.
 *   3. Done card, completion saved, never shows again after a reload.
 *   4. "?" -> Watch how it works (Start to first movement < 300ms) -> Esc skips.
 *   5. "?" -> Try it myself: Back works, Esc skips, skip saved.
 *   6. Quick guide: one screen, a Show me per step that plays that one step.
 * Plus, once: Later hides it until the next sign-in and goes quiet after 3;
 * the lit element gets focus on your turn; the step line is announced.
 * Screenshots in var/tour-shots/ (gitignored).
 *
 *   npm run test:tour                      # starts proxy + next dev if nothing answers
 *   node scripts/tour-check.mjs --base http://localhost:3587 --roles va --viewports phone
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
const ENV = envLocal();
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
  { name: "laptop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" },
];
const VIEWPORTS = ALL_VIEWPORTS.filter((v) => String(args.viewports || "laptop,phone").split(",").includes(v.name));
const LIMITS = { firstMove: 300, demo: 4000, watchMin: 30000, watchMax: 45000 };
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
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 }), page.click('button[type="submit"]')]);
  await page.waitForLoadState("domcontentloaded");
}

/** The sheet, the lit element and the page, measured in one go. */
async function measure(page) {
  return page.evaluate(() => {
    const sheet = document.querySelector("[data-tour-sheet]");
    const lit = document.querySelector("[data-tour-lit]");
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const d = sheet?.dataset ?? {};
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      mode: d.mode ?? "",
      phase: d.phase ?? "",
      step: Number(d.step ?? -1),
      steps: Number(d.steps ?? 0),
      act: d.act ?? "",
      firstMove: d.firstMoveMs == null ? null : Number(d.firstMoveMs),
      demoMs: d.demoMs == null ? null : Number(d.demoMs),
      netMs: d.netMs == null ? 0 : Number(d.netMs),
      demoStep: d.demoStep == null ? -1 : Number(d.demoStep),
      watchMs: d.watchMs == null ? null : Number(d.watchMs),
      line: sheet?.querySelector("p")?.textContent?.trim() ?? "",
      lines: (() => {
        const p = sheet?.querySelector("p");
        if (!p) return 0;
        return Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight));
      })(),
      sheet: box(sheet),
      lit: box(lit),
      litTag: lit ? lit.getAttribute("data-tour") || lit.tagName.toLowerCase() : "",
      litFocused: !!lit && (document.activeElement === lit || lit.contains(document.activeElement)),
      announce: document.querySelector("[data-tour-root] [aria-live]")?.textContent ?? "",
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small: sheet ? [...sheet.querySelectorAll("button, a[href]")].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim()) : [],
      path: location.pathname + location.search,
    };
  });
}
const overlaps = (a, b) => a && b && !(a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1);
const inside = (r, m) => r && r.left >= -1 && r.top >= -1 && r.right <= m.vw + 1 && r.bottom <= m.vh + 1;
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
  // A loaded machine can stall one capture; try again before calling it a failure.
  for (let i = 0; ; i++) {
    try {
      await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 45000 });
      return;
    } catch (error) {
      if (i >= 1) throw error;
    }
  }
}

function assertPlacement(label, m, phone) {
  check(`${label}: sheet on screen`, inside(m.sheet, m), JSON.stringify(m.sheet));
  if (m.lit) {
    check(`${label}: lit element on screen`, inside(m.lit, m), `${m.litTag} ${JSON.stringify(m.lit)}`);
    check(`${label}: sheet never on the lit element`, !overlaps(m.sheet, m.lit), `${m.litTag} sheet ${JSON.stringify(m.sheet)} lit ${JSON.stringify(m.lit)}`);
  }
  check(`${label}: no sideways overflow`, m.overflow <= 1, `${m.overflow}px`);
  if (phone) check(`${label}: tap targets >= 44px`, m.small.length === 0, m.small.join(", "));
  check(`${label}: two short sentences, 12 to 22 words`, sentences(m.line) === 2 && words(m.line) >= 12 && words(m.line) <= 22 && !m.line.includes("—"), m.line);
  check(`${label}: copy wraps to two lines at most`, m.lines >= 1 && m.lines <= 2, `${m.lines} lines`);
}

/**
 * Plays the running tour to its end card. In "try" mode the check does
 * each step itself when the sheet says "Your turn".
 */
async function playThrough(page, tag, mode, phone, u, { perform = true } = {}) {
  const seen = new Set();
  const demos = new Map();
  let firstMove = null;
  const t0 = Date.now();
  let lastKey = "";
  while (Date.now() - t0 < 120000) {
    const m = await measure(page);
    if (m.demoStep >= 0 && m.demoMs != null && !demos.has(m.demoStep)) demos.set(m.demoStep, { ms: m.demoMs, net: m.netMs });
    if (firstMove === null && m.firstMove != null) firstMove = m.firstMove;
    if (m.mode !== mode) break;
    const key = `${m.step}|${m.phase}`;
    if (mode === "watch" && m.demoStep === m.step && !seen.has(m.step)) {
      seen.add(m.step);
      await page.waitForTimeout(350);
      const mm = await measure(page);
      assertPlacement(`${tag} watch step ${m.step + 1}`, mm, phone);
      await shot(page, `${tag}-watch-${String(m.step + 1).padStart(2, "0")}`);
    }
    if (mode === "try" && m.phase === "turn" && key !== lastKey) {
      await page.waitForTimeout(300);
      const mm = await measure(page);
      seen.add(m.step);
      check(`${tag} try step ${m.step + 1}: "Your turn" shown`, (await page.locator("[data-tour-your-turn]").count()) === 1);
      check(`${tag} try step ${m.step + 1}: element lit`, !!mm.lit, mm.litTag);
      check(`${tag} try step ${m.step + 1}: announced`, mm.announce.includes(mm.line), mm.announce);
      assertPlacement(`${tag} try step ${m.step + 1}`, mm, phone);
      await shot(page, `${tag}-try-${String(m.step + 1).padStart(2, "0")}`);
      if (perform) {
        const lit = page.locator("[data-tour-lit]");
        if (mm.act === "search") {
          check(`${tag} try step ${m.step + 1}: search box focused`, mm.litFocused);
          await lit.fill("Gwen");
          await lit.press("Enter");
        } else if (mm.act === "drop") {
          const chooser = page.waitForEvent("filechooser", { timeout: 1500 }).then(() => true, () => false);
          await lit.click();
          check(`${tag} try step ${m.step + 1}: no real upload (no file picker)`, !(await chooser));
        } else {
          await lit.click();
          // Phone menu: More opens the menu, then the item itself.
          await page.waitForTimeout(250);
          const again = await measure(page);
          if (again.phase === "turn" && again.step === m.step && again.litTag !== mm.litTag) await page.locator("[data-tour-lit]").click();
        }
        const done = await page
          .waitForFunction((s) => {
            const d = document.querySelector("[data-tour-sheet]")?.dataset;
            return !d || d.phase === "ok" || Number(d.step) !== s || d.mode !== "try";
          }, m.step, { timeout: 10000 })
          .then(() => true, () => false);
        check(`${tag} try step ${m.step + 1}: completes on the real action (no Next button)`, done);
      } else break;
    }
    lastKey = key;
    await page.waitForTimeout(60);
  }
  const elapsed = Date.now() - t0;
  const own = [...demos.values()].map((d) => d.ms - d.net);
  const maxDemo = Math.max(0, ...own);
  // Watch: the runtime stamps every step it demonstrates, even one the poll was too busy to photograph.
  const played = mode === "watch" ? Math.max(seen.size, demos.size) : seen.size;
  check(`${tag} ${mode}: every step played`, played === u.steps || !perform, `${played}/${u.steps}`);
  check(`${tag} ${mode}: Start to first movement < ${LIMITS.firstMove}ms`, firstMove !== null && firstMove < LIMITS.firstMove, `${firstMove}ms`);
  // The demonstration itself (pointer, press, the page responding) must be
  // under 4s; time the dev server spends rendering a page is reported apart.
  for (const [i, d] of demos) {
    check(`${tag} ${mode} step ${i + 1}: demonstration < ${LIMITS.demo}ms`, d.ms - d.net < LIMITS.demo, `${d.ms - d.net}ms + ${d.net}ms server`);
  }
  const sorted = [...demos.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  timings.push({ tag, mode, firstMove, maxDemo, demos: sorted.map((d) => d.ms - d.net), server: sorted.map((d) => d.net), elapsed });
  return { elapsed, firstMove, demos };
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
  const context = await browser.newContext({ viewport: vp.viewport, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1, reducedMotion: vp.reducedMotion || "no-preference" });
  const page = await context.newPage();
  // A busy dev server can be slow to render; the tour timings are measured apart.
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  if (args.debug) page.on("console", (msg) => /TOURDBG|hydrat/i.test(msg.text()) && console.log("  console:", page.url(), msg.text().slice(-1500)));
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
  // Page errors count from here: the warm-up above (full page loads) is not the tour.
  errors.length = 0;
  await signIn(page, u.email);
  if (!page.url().includes("/dashboard")) await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });

  // 1. Welcome -> Watch.
  const welcome = page.locator('[data-tour-sheet][data-mode="welcome"]');
  await welcome.waitFor({ state: "visible", timeout: 60000 });
  const welcomeText = await welcome.innerText();
  check(`${tag}: welcome greets by first name`, welcomeText.includes(`Welcome, ${u.first}.`), welcomeText.split("\n")[0]);
  await checkCardCopy(`${tag} welcome`, welcome);
  check(`${tag}: welcome is a small card`, await welcome.evaluate((el) => el.getBoundingClientRect().height < window.innerHeight * 0.45));
  check(`${tag}: welcome offers Watch and Try`, (await welcome.getByRole("button", { name: "Watch how it works" }).count()) === 1 && (await welcome.getByRole("button", { name: "Try it myself" }).count()) === 1);
  await page.waitForTimeout(300);
  await shot(page, `${tag}-00-welcome`);
  await welcome.getByRole("button", { name: "Watch how it works" }).click();
  const watch = await playThrough(page, tag, "watch", phone, u);
  // Its own length: wall clock minus time the (dev) server spent rendering pages.
  const server = [...watch.demos.values()].reduce((n, d) => n + d.net, 0);
  const own = watch.elapsed - server;
  check(`${tag}: watch lasts 30 to 45s`, own >= LIMITS.watchMin && own <= LIMITS.watchMax, `${(own / 1000).toFixed(1)}s + ${(server / 1000).toFixed(1)}s server`);
  timings[timings.length - 1].watchMs = own;
  const end = page.locator('[data-tour-sheet][data-mode="watch-end"]');
  await end.waitFor({ state: "visible", timeout: 30000 });
  check(`${tag}: watch ends with Now you try + Got it`, (await end.getByRole("button", { name: "Now you try" }).count()) === 1 && (await end.getByRole("button", { name: "Got it" }).count()) === 1);
  await checkCardCopy(`${tag} watch end`, end);
  await shot(page, `${tag}-watch-end`);

  // 2. Now you try: every step by doing it.
  await end.getByRole("button", { name: "Now you try" }).click();
  await playThrough(page, tag, "try", phone, u);

  // 3. Done, saved, quiet.
  const done = page.locator('[data-tour-sheet][data-mode="done"]');
  await done.waitFor({ state: "visible", timeout: 30000 });
  await checkCardCopy(`${tag} done`, done);
  await shot(page, `${tag}-99-done`);
  await done.getByRole("button", { name: "Done", exact: true }).click();
  check(`${tag}: nothing left on screen after Done`, (await page.locator("[data-tour-sheet], [data-tour-lit], [data-tour-ghost]").count()) === 0);
  const state = await waitForState(u.email, (s) => !!s?.completedAt);
  check(`${tag}: completion saved`, !!state?.completedAt && state.version === 1, JSON.stringify(state));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  check(`${tag}: never shows again after completing`, (await page.locator("[data-tour-sheet]").count()) === 0);

  // 4. "?" -> Watch how it works, timed from the menu press; Esc skips.
  // A person rests on the "?" before pressing it; that is when the tour loads.
  await page.getByRole("button", { name: "Help", exact: true }).hover();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Help", exact: true }).click();
  // Timed in the page: from the press on the menu item to the watch sheet.
  await page.evaluate(() => {
    const w = window;
    w.__tourPress = null;
    w.__tourSheet = null;
    document.addEventListener("click", () => (w.__tourPress ??= performance.now()), { capture: true, once: true });
    const mo = new MutationObserver(() => {
      if (document.querySelector('[data-tour-sheet][data-mode="watch"]')) {
        w.__tourSheet = performance.now();
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
  await page.getByRole("menuitem", { name: "Watch how it works" }).click();
  // It must open as a watch (not the step-by-step tour), even when the tour
  // code was not loaded yet (a finished tour loads it on this press).
  await page.locator('[data-tour-sheet][data-mode="watch"]').waitFor({ state: "visible", timeout: 30000 });
  const sheetMs = Math.round(await page.evaluate(() => window.__tourSheet - window.__tourPress));
  check(`${tag}: "?" Watch opens the watch within ${LIMITS.firstMove}ms of the press`, sheetMs >= 0 && sheetMs < LIMITS.firstMove, `${sheetMs}ms`);
  const fm = await page.waitForFunction(() => document.querySelector("[data-tour-sheet]")?.dataset.firstMoveMs, null, { timeout: 30000 }).then((h) => h.jsonValue(), () => null);
  check(`${tag}: "?" Watch, first movement < ${LIMITS.firstMove}ms`, fm !== null && Number(fm) < LIMITS.firstMove, `${fm}ms`);
  timings.push({ tag, mode: "menu-watch", firstMove: Number(fm), sheetMs });
  await page.getByRole("button", { name: "Pause" }).click();
  check(`${tag}: watch pauses`, (await page.getByRole("button", { name: "Play" }).count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check(`${tag}: Esc stops the watch`, (await page.locator("[data-tour-sheet]").count()) === 0);

  // 5. "?" -> Try it myself: Back, then Esc skips (saved).
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("menuitem", { name: "Try it myself" }).click();
  await page.locator('[data-tour-sheet][data-mode="try"][data-phase="turn"][data-step="0"]').waitFor({ timeout: 30000 });
  check(`${tag}: Show me around starts at step 1`, true);
  await page.locator("[data-tour-lit]").click();
  await page.locator('[data-tour-sheet][data-step="1"]').waitFor({ timeout: 30000 });
  await page.locator("[data-tour-sheet]").getByRole("button", { name: "Back", exact: true }).click();
  const backOk = await page.locator('[data-tour-sheet][data-step="0"]').waitFor({ timeout: 30000 }).then(() => true, () => false);
  check(`${tag}: Back goes to the previous step`, backOk);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check(`${tag}: Esc skips the tour`, (await page.locator("[data-tour-sheet]").count()) === 0);
  check(`${tag}: skip saved`, !!(await waitForState(u.email, (s) => !!s?.dismissedAt))?.dismissedAt);

  // 6. Quick guide: one screen, a Show me per step.
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("menuitem", { name: "Quick guide" }).click();
  await page.waitForURL("**/help", { timeout: 60000 });
  await page.getByRole("heading", { name: "Quick guide" }).waitFor({ timeout: 60000 });
  const guide = await page.evaluate(() => {
    const ol = document.querySelector("[data-tour-guide]");
    return {
      steps: ol?.querySelectorAll(":scope > li").length ?? 0,
      showMe: document.querySelectorAll('button[aria-label^="Show me:"]').length,
      listBottom: ol?.getBoundingClientRect().bottom ?? 9999,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check(`${tag}: guide lists the tour steps`, guide.steps === u.steps, `${guide.steps}`);
  check(`${tag}: a Show me per step`, guide.showMe === u.steps, `${guide.showMe}`);
  check(`${tag}: guide steps fit one screen`, guide.listBottom <= vp.viewport.height - (phone ? 64 : 0), `${Math.round(guide.listBottom)}`);
  check(`${tag}: guide has no sideways overflow`, guide.overflow <= 1, `${guide.overflow}px`);
  await shot(page, `${tag}-help`);
  const pick = Math.min(1, u.steps - 1);
  await page.locator('button[aria-label^="Show me:"]').nth(pick).click();
  await page.locator(`[data-tour-sheet][data-mode="one"][data-phase="turn"][data-step="${pick}"]`).waitFor({ timeout: 30000 });
  check(`${tag}: Show me plays that one step`, true);
  const one = await measure(page);
  if (one.act === "search") {
    await page.locator("[data-tour-lit]").fill("Gwen");
    await page.locator("[data-tour-lit]").press("Enter");
  } else await page.locator("[data-tour-lit]").click();
  const closed = await page.waitForFunction(() => !document.querySelector("[data-tour-sheet]"), null, { timeout: 30000 }).then(() => true, () => false);
  check(`${tag}: Show me closes after the person does it`, closed);

  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

/** Later: hidden until the next sign-in, quiet after three. */
async function later(browser) {
  const u = USERS.va;
  resetOnboarding(u.email);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
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
    const bits = [`first move ${t.firstMove}`];
    if (t.sheetMs != null) bits.push(`press to sheet ${t.sheetMs}`);
    if (t.demos) bits.push(`demos ${t.demos.join("/")}`, `max ${t.maxDemo}`, `server ${t.server.map(Math.round).join("/")}`);
    if (t.watchMs) bits.push(`watch ${(t.watchMs / 1000).toFixed(1)}s`);
    console.log(`  ${t.tag} ${t.mode}: ${bits.join(", ")}`);
  }
  fs.writeFileSync(path.join(OUT, "timings.json"), JSON.stringify(timings, null, 2));
  console.log(`\n${passes} passed, ${failures} failed. Screenshots: ${path.relative(ROOT, OUT)}/`);
  code = failures ? 1 : 0;
} finally {
  stopChildren();
}
process.exit(code);
