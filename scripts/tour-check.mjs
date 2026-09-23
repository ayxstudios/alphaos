#!/usr/bin/env node
/**
 * First-run tour check (headless Playwright). For each role (admin, va,
 * designer) on a laptop (1280x800) and a phone (390x844, touch, reduced
 * motion): fresh onboarding -> welcome card -> Start -> every step, each one
 * before and after "Try it", asserting the spotlit target exists, is visible
 * and on screen, the card is fully on screen and never covers the target,
 * nothing overflows sideways, and phone buttons are at least 44px. Then the
 * done card, no re-show on reload, "?" -> Show me around -> Esc skips, and the
 * Quick guide page. One screenshot per step in var/tour-shots/ (gitignored).
 * Also, once: Later hides it until the next sign-in and goes quiet after 3,
 * and Tab stays inside the tour card.
 *
 *   npm run test:tour                      # starts proxy + next dev if nothing answers
 *   node scripts/tour-check.mjs --base http://localhost:3461 --roles va
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
const DIRECT_URL = ENV.DIRECT_URL || "";
const dbUrl = (() => {
  try {
    return new URL(DIRECT_URL);
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
  admin: { email: "tour-admin@alphaos.test", first: "Amira", steps: 8 },
  va: { email: "tour-va@alphaos.test", first: "Vera", steps: 7 },
  designer: { email: "tour-designer@alphaos.test", first: "Dina", steps: 5 },
};
const ROLES = String(args.roles || "admin,va,designer").split(",");
const VIEWPORTS = [
  { name: "laptop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" },
];

function psql(sql) {
  return execFileSync("psql", ["-h", dbUrl.hostname, "-p", dbUrl.port || "5432", "-U", dbUrl.username || "neondb_owner", "-d", DB, "-Atc", sql], { encoding: "utf8" }).trim();
}
const onboardingOf = (email) => {
  const raw = psql(`select coalesce(onboarding::text, 'null') from "user" where email = '${email}'`);
  return JSON.parse(raw || "null");
};
async function waitForState(email, ok, ms = 15000) {
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
function stopChildren() {
  for (const c of children) c.kill("SIGTERM");
}

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
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.waitForLoadState("domcontentloaded");
}
async function signOut(page) {
  await page.context().clearCookies();
}

/** Geometry + a11y facts for the open tour card and its spotlit target. */
async function measure(page) {
  return page.evaluate(() => {
    const card = document.querySelector("[data-tour-card]");
    const lit = document.querySelector("[data-tour-lit]");
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const buttons = card ? [...card.querySelectorAll("button, a[href]")].map((b) => ({ text: b.textContent.trim(), h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width })) : [];
    const litStyle = lit ? getComputedStyle(lit) : null;
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      step: card ? Number(card.getAttribute("data-step")) : -1,
      steps: card ? Number(card.getAttribute("data-steps")) : 0,
      target: card?.getAttribute("data-target") || "",
      via: card?.getAttribute("data-via") || "",
      hasPage: card?.getAttribute("data-has-page") === "true",
      title: card?.querySelector("h2")?.textContent || "",
      card: box(card),
      lit: box(lit),
      litVisible: !!lit && litStyle.visibility !== "hidden" && litStyle.display !== "none",
      litMatchesTarget: !!lit && lit.getAttribute("data-tour") === card?.getAttribute("data-target"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      buttons,
      modal: card?.getAttribute("aria-modal") === "true" && !!card.getAttribute("aria-labelledby"),
    };
  });
}
const overlaps = (a, b) => a && b && !(a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1);
const inside = (r, m) => r && r.left >= -1 && r.top >= -1 && r.right <= m.vw + 1 && r.bottom <= m.vh + 1;

async function settle(page, ms = 700) {
  await page.waitForTimeout(ms);
}

async function assertStep(page, label, m, phone) {
  check(`${label}: target resolved`, !!m.target, `target=${m.target || "none"}`);
  check(`${label}: target visible`, m.litVisible && m.litMatchesTarget && m.lit && m.lit.width > 0 && m.lit.height > 0);
  check(`${label}: target on screen`, inside(m.lit, m), JSON.stringify(m.lit));
  check(`${label}: card on screen`, inside(m.card, m), JSON.stringify(m.card));
  check(`${label}: card does not cover target`, !overlaps(m.card, m.lit), `card ${JSON.stringify(m.card)} lit ${JSON.stringify(m.lit)}`);
  check(`${label}: no sideways overflow`, m.overflow <= 1, `overflow ${m.overflow}px`);
  check(`${label}: dialog labelled + modal`, m.modal);
  if (phone) {
    const small = m.buttons.filter((b) => b.h < 44);
    check(`${label}: tap targets >= 44px`, small.length === 0, small.map((b) => `${b.text}:${Math.round(b.h)}`).join(", "));
  }
}

async function shot(page, name) {
  // The dev-only Next.js badge is not part of the app.
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

// ---- the walk -----------------------------------------------------------------
async function walkRole(browser, role, vp) {
  const u = USERS[role];
  const phone = vp.name === "phone";
  const tag = `${role}-${vp.name}`;
  resetOnboarding(u.email);
  const context = await browser.newContext({ viewport: vp.viewport, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1, reducedMotion: vp.reducedMotion || "no-preference" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/Failed to load resource|favicon|Download the React DevTools/.test(msg.text())) errors.push(msg.text().slice(0, 200));
  });
  await signIn(page, u.email);
  if (!page.url().includes("/dashboard")) await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });

  // Welcome card.
  const welcome = page.locator("[data-tour-welcome]");
  await welcome.waitFor({ state: "visible", timeout: 60000 });
  const welcomeText = await welcome.innerText();
  check(`${tag}: welcome greets by first name`, welcomeText.includes(`Welcome, ${u.first}.`), welcomeText.split("\n")[0]);
  check(`${tag}: welcome is a small card, not a takeover`, await welcome.evaluate((el) => el.getBoundingClientRect().height < window.innerHeight * 0.45));
  await settle(page, 300);
  await shot(page, `${tag}-00-welcome`);
  await page.getByRole("button", { name: "Start", exact: true }).click();

  // Every step.
  const card = page.locator("[data-tour-card]");
  for (let i = 0; i < u.steps; i++) {
    await page.locator(`[data-tour-card][data-step="${i}"]`).waitFor({ state: "visible", timeout: 30000 });
    await settle(page);
    let m = await measure(page);
    check(`${tag} step ${i + 1}: step count`, m.steps === u.steps, `${m.steps}`);
    await assertStep(page, `${tag} step ${i + 1} (${m.title})`, m, phone);

    // Try it: go to the page; the spotlight should move onto the page itself.
    const tryIt = card.getByRole("button", { name: /^Try it/ });
    if (await tryIt.count()) {
      const before = new URL(page.url()).pathname;
      await tryIt.click();
      // First visit to a route compiles it in dev, which can take a while.
      await page.waitForURL((url) => url.pathname !== before, { timeout: 120000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded");
      await page
        .waitForFunction(() => {
          const c = document.querySelector("[data-tour-card]");
          return c?.getAttribute("data-has-page") !== "true" || c?.getAttribute("data-via") === "page";
        }, null, { timeout: 45000 })
        .catch(() => {});
      await settle(page);
      m = await measure(page);
      if (m.hasPage) check(`${tag} step ${i + 1}: Try it lands on the page element`, m.via === "page", `via=${m.via} target=${m.target} url=${page.url()}`);
      await assertStep(page, `${tag} step ${i + 1} on page`, m, phone);
    }
    await shot(page, `${tag}-${String(i + 1).padStart(2, "0")}-${m.title.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "")}`);

    if (i === 1) {
      // Back returns to the previous step, then forward again.
      await card.getByRole("button", { name: "Back", exact: true }).click();
      await page.locator(`[data-tour-card][data-step="0"]`).waitFor({ state: "visible" });
      check(`${tag}: Back goes to the previous step`, true);
      await card.getByRole("button", { name: "Next", exact: true }).click();
      await page.locator(`[data-tour-card][data-step="1"]`).waitFor({ state: "visible" });
    }
    const last = i === u.steps - 1;
    await card.getByRole("button", { name: last ? "Done" : "Next", exact: true }).click();
  }

  // Done card, then quiet.
  const done = page.locator("[data-tour-done]");
  await done.waitFor({ state: "visible", timeout: 10000 });
  await shot(page, `${tag}-99-done`);
  await done.getByRole("button", { name: "Done", exact: true }).click();
  check(`${tag}: nothing left on screen after Done`, (await page.locator("[data-tour-card], [data-tour-done], [data-tour-welcome], [data-tour-lit]").count()) === 0);
  const state = await waitForState(u.email, (s) => !!s?.completedAt);
  check(`${tag}: completion saved`, !!state?.completedAt && state.version === 1, JSON.stringify(state));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  check(`${tag}: never shows again after completing`, (await page.locator("[data-tour-welcome], [data-tour-card]").count()) === 0);

  // Relaunch from "?" -> Show me around; Esc = Skip tour.
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show me around" }).click();
  await page.locator(`[data-tour-card][data-step="0"]`).waitFor({ state: "visible", timeout: 10000 });
  check(`${tag}: Show me around restarts at step 1`, true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check(`${tag}: Esc skips the tour`, (await card.count()) === 0);
  check(`${tag}: skip saved`, !!(await waitForState(u.email, (s) => !!s?.dismissedAt))?.dismissedAt);

  // Quick guide.
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("menuitem", { name: "Quick guide" }).click();
  await page.waitForURL("**/help", { timeout: 60000 });
  await page.getByRole("heading", { name: "Quick guide" }).waitFor({ timeout: 60000 });
  const guide = await page.evaluate(() => ({
    steps: document.querySelectorAll("ol > li").length,
    faqs: document.querySelectorAll("details").length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  check(`${tag}: guide lists the tour steps`, guide.steps === u.steps, `${guide.steps}`);
  check(`${tag}: guide has 5 to 8 answers`, guide.faqs >= 5 && guide.faqs <= 8, `${guide.faqs}`);
  check(`${tag}: guide has no sideways overflow`, guide.overflow <= 1, `${guide.overflow}px`);
  await page.locator("details").first().locator("summary").click();
  await shot(page, `${tag}-help`);

  check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

/** Later: hidden until the next sign-in, quiet after three. Plus the focus trap. */
async function laterAndFocus(browser) {
  const u = USERS.va;
  resetOnboarding(u.email);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  for (let n = 1; n <= 3; n++) {
    await signIn(page, u.email);
    const welcome = page.locator("[data-tour-welcome]");
    await welcome.waitFor({ state: "visible", timeout: 60000 });
    check(`later: welcome shows on sign-in ${n}`, true);
    await welcome.getByRole("button", { name: "Later", exact: true }).click();
    await waitForState(u.email, (st) => st?.laterCount === n);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    check(`later: hidden for the rest of sign-in ${n}`, (await page.locator("[data-tour-welcome]").count()) === 0);
    await signOut(page);
  }
  check("later: counted 3 times", onboardingOf(u.email)?.laterCount === 3, JSON.stringify(onboardingOf(u.email)));
  await signIn(page, u.email);
  await page.waitForTimeout(2500);
  check("later: quiet after the third Later", (await page.locator("[data-tour-welcome]").count()) === 0);

  // Focus stays in the card; Tab from the last control wraps to the first.
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show me around" }).click();
  await page.locator("[data-tour-card]").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  let allInside = true;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    allInside &&= await page.evaluate(() => !!document.activeElement?.closest("[data-tour-card]"));
  }
  check("focus: Tab stays inside the tour card", allInside);
  await page.keyboard.press("Escape");
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
        await laterAndFocus(browser);
        console.log("ok    later + focus");
      } catch (error) {
        check("later + focus finished", false, String(error?.message || error).split("\n")[0]);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${passes} passed, ${failures} failed. Screenshots: ${path.relative(ROOT, OUT)}/`);
  code = failures ? 1 : 0;
} finally {
  stopChildren();
}
process.exit(code);
