#!/usr/bin/env node
// VA rework gauntlet harness (debug + test measurements, full-page shots).
//   node scripts/qa/va-gauntlet.mjs <baseUrl> <loopN>
// Results: /tmp/alphaos-va-gauntlet/results-loopN.json, shots: /tmp/alphaos-va-gauntlet/loopN/
// Logins come from the demo env file (fictional data only).
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(os.homedir() + "/Documents/ai-employee-agent/package.json");
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "https://alphaos-demo.vercel.app").replace(/\/$/, "");
const LOOP = process.argv[3] || "1";
const OUT = `/tmp/alphaos-va-gauntlet`;
const SHOTS = `${OUT}/loop${LOOP}`;
fs.mkdirSync(SHOTS, { recursive: true });
const env = Object.fromEntries(fs.readFileSync(os.homedir() + "/Documents/ai-employee-agent/.local/alphaos-demo.env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }));
const PASSWORD = env.DEMO_PASSWORD;
const USERS = { va: env.DEMO_VA_EMAIL, designer: env.DEMO_DESIGNER_EMAIL, admin: env.DEMO_ADMIN_EMAIL };
const CTXS = {
  "desk1440": { viewport: { width: 1440, height: 900 } },
  "desk1280": { viewport: { width: 1280, height: 800 } },
  "phone390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  "phone360": { viewport: { width: 360, height: 740 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const VA_PAGES = ["/dashboard", "/qc", "QC", "/board", "/emails", "/orders", "/queue/print", "/designers", "/styles", "/customers"];
const results = { base: BASE, loop: LOOP, startedAt: new Date().toISOString(), contexts: {}, tests: [] };
const note = (ctx, name, ok, detail) => { results.tests.push({ ctx, name, ok, detail }); console.log(ok ? "PASS" : "FAIL", ctx, name, detail ?? ""); };

// ---------------- in-page audit ----------------
const AUDIT = () => {
  const isPhone = window.matchMedia("(pointer:coarse)").matches && innerWidth < 600;
  const out = { overflow: [], clipped: [], smallTargets: [], tinyText: [], phoneBody: [], lowContrast: [], overlap: [] };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "") + " \"" + (el.textContent || "").trim().slice(0, 30) + "\"";
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p.scrollWidth <= p.clientWidth + 1 || /(auto|scroll)/.test(s.overflowX)) return true; if (s.overflowX === "hidden" || s.overflowX === "clip") return true; } return false; };
  const de = document.documentElement;
  const docOver = de.scrollWidth > de.clientWidth;
  if (docOver) {
    for (const el of document.body.querySelectorAll("*")) {
      if (!vis(el) || inScroller(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > de.clientWidth + 1 || r.left < -1) { const pos = getComputedStyle(el).position; if (pos === "fixed") continue; out.overflow.push({ el: sel(el), right: Math.round(r.right), left: Math.round(r.left) }); if (out.overflow.length > 8) break; }
    }
  }
  out.docOverflow = docOver ? { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth } : null;
  // clipped text
  for (const el of document.body.querySelectorAll("*")) {
    if (!vis(el) || el.closest(".sr-only")) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    const hasEllipsis = s.textOverflow === "ellipsis" || /-webkit-box/.test(s.display) || (s.webkitLineClamp && s.webkitLineClamp !== "none") || (s.lineClamp && s.lineClamp !== "none");
    if (hasEllipsis) continue; // intentional truncation
    if ((s.overflowX === "hidden" || s.overflowX === "clip") && el.scrollWidth > el.clientWidth + 1) out.clipped.push({ el: sel(el), sw: el.scrollWidth, cw: el.clientWidth });
    if ((s.overflowY === "hidden" || s.overflowY === "clip") && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) out.clipped.push({ el: sel(el), sh: el.scrollHeight, ch: el.clientHeight });
  }
  // tap targets
  if (isPhone) {
    for (const el of document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=menuitem]")) {
      if (!vis(el) || el.closest(".sr-only") || el.disabled) continue;
      let r = el.getBoundingClientRect();
      // a link wrapping inline text in a paragraph is exempt (WCAG inline exception)
      if (el.tagName === "A" && getComputedStyle(el).display === "inline" && el.closest("p,li,span")) continue;
      let w = r.width, h = r.height;
      for (const pe of ["::before", "::after"]) { const ps = getComputedStyle(el, pe); if (ps.content !== "none" && ps.position === "absolute") { w = Math.max(w, parseFloat(ps.width) || 0); h = Math.max(h, parseFloat(ps.height) || 0); } }
      if (el.type === "checkbox" || el.type === "radio") { const l = el.closest("label"); if (l) { const lr = l.getBoundingClientRect(); w = Math.max(w, lr.width); h = Math.max(h, lr.height); } }
      if (w < 43.5 || h < 43.5) out.smallTargets.push({ el: sel(el), w: Math.round(w), h: Math.round(h) });
    }
  }
  // text size + contrast
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true }); cv.canvas.width = cv.canvas.height = 1;
  const parse = (c) => { if (!c || c === "transparent") return null; cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; /* fillStyle with alpha: premultiplied back */ return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
  const blend = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => { const stack = []; for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.backgroundImage !== "none") return null; const c = parse(s.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = stack.length - 1; i >= 0; i--) base = blend(stack[i], base); return base; };
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim(); if (!t) continue;
    const el = n.parentElement; if (!el || seen.has(el) || !vis(el) || el.closest(".sr-only,script,style,noscript")) continue;
    seen.add(el);
    const s = getComputedStyle(el); const fs = parseFloat(s.fontSize);
    if (fs < 12) out.tinyText.push({ el: sel(el), fs });
    if (isPhone && fs < 16 && /^(P|LI|BODY)$/.test(el.tagName)) out.phoneBody.push({ el: sel(el), fs });
    const fg = parse(s.color); const bg = bgOf(el);
    if (fg && bg) {
      const f2 = blend({ ...fg, a: fg.a * (parseFloat(s.opacity) || 1) }, bg);
      const l1 = lum(f2), l2 = lum(bg); const cr = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const large = fs >= 24 || (fs >= 18.66 && +s.fontWeight >= 700);
      if (cr < (large ? 3 : 4.5)) out.lowContrast.push({ el: sel(el), cr: +cr.toFixed(2), fs });
    }
  }
  // fixed bars overlapping the last content
  const bars = [...document.querySelectorAll("nav,header,div")].filter((e) => { const s = getComputedStyle(e); return s.position === "fixed" && vis(e) && e.getBoundingClientRect().height < 120 && e.getBoundingClientRect().width > innerWidth * 0.8; });
  const main = document.querySelector("main");
  if (main) {
    const scroller = [...document.querySelectorAll("*")].find((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 5 && e.clientHeight > innerHeight * 0.4) || document.scrollingElement;
    const prev = scroller.scrollTop; scroller.scrollTop = scroller.scrollHeight;
    const last = [...main.querySelectorAll("a,button,p,li,h2,h3,td")].filter(vis).sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    if (last) { const lb = last.getBoundingClientRect().bottom; for (const b of bars) { const br = b.getBoundingClientRect(); if (br.top < innerHeight / 2) continue; if (lb > br.top + 1) out.overlap.push({ bar: sel(b), contentBottom: Math.round(lb), barTop: Math.round(br.top), last: sel(last) }); } }
    scroller.scrollTop = prev;
  }
  return out;
};


// Full-content shot: the app shell scrolls <main>, not the document, so grow the viewport to the scroller's content height.
async function fullShot(page, file) {
  const vp = page.viewportSize();
  const extra = await page.evaluate(() => {
    const sc = [...document.querySelectorAll("main, *")].find((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 5 && e.clientHeight > innerHeight * 0.3);
    return sc ? sc.scrollHeight - sc.clientHeight : 0;
  }).catch(() => 0);
  if (extra > 4) { await page.setViewportSize({ width: vp.width, height: Math.min(vp.height + extra, 5000) }); await page.waitForTimeout(500); }
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  if (extra > 4) await page.setViewportSize(vp);
}

async function login(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 }), page.click('button[type="submit"]')]);
  await page.waitForTimeout(1200);
}

function track(page, bucket) {
  page.on("console", (m) => { if (m.type() === "error") bucket.console.push(m.text().slice(0, 240)); });
  page.on("pageerror", (e) => bucket.console.push("pageerror: " + String(e.message).slice(0, 240)));
  page.on("requestfailed", (r) => { if (!/_rsc=|prefetch/i.test(r.url()) && r.failure()?.errorText !== "net::ERR_ABORTED") bucket.failed.push(r.url().slice(0, 160) + " " + r.failure()?.errorText); });
  page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) bucket.failed.push(`${r.status()} ${r.url().slice(0, 160)}`); });
}

const browser = await chromium.launch({ headless: true, channel: "chrome" }).catch(() => chromium.launch({ headless: true }));
for (const [cname, copts] of Object.entries(CTXS)) {
  const phone = !!copts.isMobile;
  const ctx = await browser.newContext(copts);
  const page = await ctx.newPage();
  const bucket = { console: [], failed: [] };
  track(page, bucket);
  const res = (results.contexts[cname] = { pages: {} });
  try {
    await login(page, USERS.va);
    note(cname, "login as VA lands on dashboard", /\/dashboard/.test(page.url()), page.url());

    // find multi-photo order ids from /qc list
    await page.goto(`${BASE}/qc`, { waitUntil: "load" }).catch(() => {});
    const qcLinks = await page.$$eval('a[href^="/qc/"]', (as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
    let multiId = null;
    for (const h of qcLinks) { /* the multi-photo ones carry a "N photos" badge in the same row */ }
    const rows = await page.$$eval("li", (lis) => lis.map((li) => ({ href: li.querySelector('a[href^="/qc/"]')?.getAttribute("href"), txt: li.textContent })).filter((r) => r.href));
    const multi = rows.filter((r) => /\d+ photos/.test(r.txt));
    multiId = multi[0]?.href || qcLinks[0];
    res.qcRows = rows.length; res.multiRows = multi.length;

    for (let pg of VA_PAGES) {
      const label = pg === "QC" ? "/qc/<multi>" : pg;
      const path = pg === "QC" ? multiId : pg;
      if (!path) { note(cname, `page ${label}`, false, "no QC order to open"); continue; }
      bucket.console.length = 0; bucket.failed.length = 0;
      const t0 = Date.now();
      await page.goto(BASE + path, { waitUntil: "load", timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(700);
      const a = await page.evaluate(AUDIT).catch((e) => ({ error: String(e) }));
      const slug = label.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "");
      await fullShot(page, `${SHOTS}/${cname}__${slug}.png`);
      res.pages[label] = { ms: Date.now() - t0, console: [...bucket.console], failed: [...bucket.failed], ...a };
    }

    // ---------- TEST: tiles ----------
    await page.goto(BASE + "/dashboard", { waitUntil: "load" }).catch(() => {});
    for (const [txt, want] of [["Awaiting QC", "/qc"], ["Need a VA reply", "/emails"], ["Awaiting print approval", "/queue/print"]]) {
      await page.goto(BASE + "/dashboard", { waitUntil: "load" }).catch(() => {});
      const tile = page.locator(`main a[href="${want}"]`).filter({ hasText: txt }).first();
      const count = await tile.count();
      if (!count) { note(cname, `tile ${txt}`, false, "tile not found"); continue; }
      const tileText = (await tile.innerText()).replace(/\s+/g, " ");
      phone ? await tile.tap() : await tile.click();
      await page.waitForURL((u) => u.pathname === want, { timeout: 20000 }).catch(() => {});
      note(cname, `tile "${txt}" -> ${want}`, new URL(page.url()).pathname === want, tileText.slice(0, 60));
    }

    // ---------- TEST: nav walk ----------
    const navItems = [["Home", "/dashboard"], ["Awaiting QC", "/qc"], ["Messages", "/emails"], ["Boards", "/board"], ["Print", "/queue/print"], ["All Orders Overview", "/orders"]];
    await page.goto(BASE + "/dashboard", { waitUntil: "load" }).catch(() => {});
    if (!phone) {
      const navTxt = (await page.locator("aside, nav").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      for (const [l, h] of navItems) {
        const link = page.locator(`aside nav a[href="${h}"]`).first();
        if (!(await link.count())) { note(cname, `nav ${l}`, false, "link missing"); continue; }
        const labelOk = (await link.innerText()).includes(l);
        await link.click(); await page.waitForURL((u) => u.pathname === h || u.pathname.startsWith(h + "/"), { timeout: 20000 }).catch(() => {});
        note(cname, `nav ${l} -> ${h}`, labelOk && new URL(page.url()).pathname.startsWith(h), labelOk ? "" : "label differs");
      }
      for (const [l, h] of [["Designers", "/designers"], ["Portrait Styles", "/styles"], ["Customers", "/customers"]]) {
        const link = page.locator(`aside a[href="${h}"]`).first();
        note(cname, `nav More ${l} present`, (await link.count()) > 0 && (await link.isVisible().catch(() => false)));
      }
    } else {
      for (const [l, h] of navItems.filter((n) => n[0] !== "Print" && n[0] !== "All Orders Overview")) {
        const tab = page.locator(`nav[aria-label="Primary"] a[href="${h}"]`).first();
        if (!(await tab.count())) { note(cname, `tab ${l}`, false, "missing"); continue; }
        const labelOk = (await tab.innerText()).includes(l);
        await tab.tap(); await page.waitForURL((u) => u.pathname === h || u.pathname.startsWith(h + "/"), { timeout: 20000 }).catch(() => {});
        note(cname, `tab ${l} -> ${h}`, labelOk && new URL(page.url()).pathname.startsWith(h), labelOk ? "" : "label differs");
      }
      // More drawer
      await page.goto(BASE + "/dashboard", { waitUntil: "load" }).catch(() => {});
      await page.locator('nav[aria-label="Primary"] button', { hasText: "More" }).tap();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/${cname}__more_drawer.png`, fullPage: false });
      const drawerAudit = await page.evaluate(AUDIT).catch(() => ({}));
      res.moreDrawer = { smallTargets: drawerAudit.smallTargets, lowContrast: drawerAudit.lowContrast, tinyText: drawerAudit.tinyText };
      for (const [l, h] of [...navItems.filter((n) => n[0] === "Print" || n[0] === "All Orders Overview"), ["Designers", "/designers"], ["Portrait Styles", "/styles"], ["Customers", "/customers"]]) {
        const open = await page.locator(`aside a[href="${h}"]:visible`).first().isVisible().catch(() => false);
        note(cname, `More drawer shows ${l}`, open);
      }
      // follow one through the drawer
      const link = page.locator(`aside a[href="/queue/print"]:visible`).first();
      if (await link.count()) { await link.tap(); await page.waitForURL((u) => u.pathname === "/queue/print", { timeout: 20000 }).catch(() => {}); note(cname, "More drawer Print navigates", new URL(page.url()).pathname === "/queue/print"); }
    }

    // ---------- TEST: multi-photo QC ----------
    if (multiId) {
      await page.goto(BASE + multiId, { waitUntil: "load" }).catch(() => {});
      const strip = page.locator('[data-testid="customer-photo-strip"]');
      note(cname, "QC multi-photo banner shown", (await strip.count()) > 0, (await strip.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80));
      const thumbs = strip.locator("button");
      const n = await thumbs.count();
      note(cname, "QC 3 numbered thumbnails", n === 3, `n=${n}`);
      const activeIdx = async () => page.evaluate(() => [...document.querySelectorAll('[data-testid="customer-photo-strip"] button')].findIndex((b) => b.getAttribute("aria-pressed") === "true"));
      const shownSrc = async () => page.evaluate(() => { const imgs = [...document.querySelectorAll("main img")].filter((i) => i.getBoundingClientRect().width > 120); return imgs.map((i) => i.currentSrc.slice(-40)).join("|"); });
      const seen = new Set();
      for (let i = 0; i < n; i++) {
        phone ? await thumbs.nth(i).tap() : await thumbs.nth(i).click();
        await page.waitForTimeout(350);
        const ai = await activeIdx(); seen.add(await shownSrc());
        note(cname, `QC thumbnail ${i + 1} becomes active`, ai === i, `active=${ai}`);
      }
      note(cname, "QC thumbnails show different images", seen.size >= n, `distinct=${seen.size}`);
      if (!phone) {
        await thumbs.nth(0).click(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(250);
        note(cname, "QC arrow-right goes to photo 2", (await activeIdx()) === 1);
      }
      await fullShot(page, `${SHOTS}/${cname}__qc_after_switch.png`);
    }

    // ---------- TEST: boards business scoping ----------
    await page.goto(BASE + "/board", { waitUntil: "load" }).catch(() => {});
    const railNames = async () => page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/board?designer="]')].map((a) => (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)))]);
    const railIds = async () => page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="/board?designer="]')].map((a) => a.getAttribute("href").split("designer=")[1]))]);
    const bizBtn = page.locator('button[aria-label="Switch workspace"], [aria-label="Switch workspace"]').first();
    const bizName = async () => (await page.evaluate(() => document.querySelector('header')?.textContent || "")).replace(/\s+/g, " ").slice(0, 120);
    const idsA = await railIds(); const namesA = await railNames();
    res.boardsA = { namesA, header: await bizName() };
    if (await bizBtn.count()) {
      phone ? await bizBtn.tap() : await bizBtn.click();
      await page.waitForTimeout(400);
      const items = page.locator('[role=menuitem]');
      const cnt = await items.count();
      const labels = await items.allInnerTexts();
      res.businesses = labels;
      // pick the one not currently checked
      let other = -1; for (let i = 0; i < cnt; i++) { const hasCheck = await items.nth(i).locator("svg").count(); if (!hasCheck) { other = i; break; } }
      if (other >= 0) {
        phone ? await items.nth(other).tap() : await items.nth(other).click();
        await page.waitForTimeout(2500); await page.waitForTimeout(1200);
        await page.goto(BASE + "/board", { waitUntil: "load" }).catch(() => {});
        const idsB = await railIds(); const namesB = await railNames();
        res.boardsB = { namesB, header: await bizName() };
        const overlap = idsA.filter((x) => idsB.includes(x));
        note(cname, "Boards rail changes with business", idsB.length > 0 && JSON.stringify(idsA) !== JSON.stringify(idsB) && overlap.length < Math.max(idsA.length, idsB.length), `A=${namesA.join(",")} | B=${namesB.join(",")}`);
        await fullShot(page, `${SHOTS}/${cname}__board_businessB.png`);
        // designer id from A falls back in B
        const foreign = idsA.find((x) => !idsB.includes(x));
        if (foreign) {
          await page.goto(`${BASE}/board?designer=${foreign}`, { waitUntil: "load" }).catch(() => {});
          const activeNames = await page.evaluate(() => (document.querySelector('main h1, main h2')?.textContent || "").trim());
          const pageText = await page.evaluate(() => document.body.innerText);
          const leaked = namesA.filter((nm) => !namesB.includes(nm)).map((nm) => nm.split(" ")[0]).filter((first) => new RegExp(`\\b${first}\\b`).test(pageText) && first.length > 2);
          note(cname, "?designer= from other business falls back", leaked.length === 0, `leaked=${leaked.join(",")} h=${activeNames}`);
        }
        // switch back
        await bizBtn.click().catch(() => {}); 
        const items2 = page.locator('[role=menuitem]');
        for (let i = 0; i < (await items2.count()); i++) { if (!(await items2.nth(i).locator("svg").count())) { phone ? await items2.nth(i).tap() : await items2.nth(i).click(); break; } }
        await page.waitForTimeout(2000);
      } else note(cname, "Boards business switch", false, "no second business");
    } else note(cname, "business switcher present", false, "not found");

    // ---------- TEST: second-visit tab switch timing ----------
    await page.goto(BASE + "/dashboard", { waitUntil: "load" }).catch(() => {});
    await page.waitForTimeout(4000); // let idle prefetch run
    const timings = [];
    for (const h of ["/qc", "/emails", "/board", "/queue/print", "/dashboard"]) {
      const sel = phone ? `nav[aria-label="Primary"] a[href="${h}"]` : `aside nav a[href="${h}"]`;
      const link = page.locator(sel).first();
      if (!(await link.count())) continue;
      const t0 = Date.now();
      phone ? await link.tap() : await link.click();
      await page.waitForFunction((hh) => location.pathname === hh && !!document.querySelector("main h1, main h2, main"), h, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1200);
      timings.push({ h, ms: Date.now() - t0 });
    }
    res.tabSwitchMs = timings;
  } catch (e) { note(cname, "context run", false, String(e).slice(0, 200)); }
  await ctx.close();
}

// ---------- other roles: designer + admin smoke, desktop + phone ----------
for (const [role, pages] of [["designer", ["/dashboard", "/board", "/me"]], ["admin", ["/dashboard", "/board", "/qc", "/orders"]]]) {
  if (!USERS[role]) continue;
  for (const cname of ["desk1440", "phone390"]) {
    const ctx = await browser.newContext(CTXS[cname]); const page = await ctx.newPage();
    const bucket = { console: [], failed: [] }; track(page, bucket);
    try {
      await login(page, USERS[role]);
      for (const p of pages) {
        bucket.console.length = 0; bucket.failed.length = 0;
        await page.goto(BASE + p, { waitUntil: "load", timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(500);
        const a = await page.evaluate(AUDIT).catch((e) => ({ error: String(e) }));
        await fullShot(page, `${SHOTS}/${role}_${cname}__${p.replace(/\W+/g, "_")}.png`);
        const h1 = await page.locator("main h1").first().innerText().catch(() => "");
        (results.contexts[`${role}_${cname}`] ??= { pages: {} }).pages[p] = { url: new URL(page.url()).pathname, h1, console: [...bucket.console], failed: [...bucket.failed], ...a };
      }
      if (role === "designer") {
        const links = await page.evaluate(() => [...document.querySelectorAll('aside a, nav a')].map((a) => a.textContent.trim()).filter(Boolean));
        results.contexts[`${role}_${cname}`].navLabels = [...new Set(links)];
      }
    } catch (e) { note(`${role}_${cname}`, "role run", false, String(e).slice(0, 200)); }
    await ctx.close();
  }
}
await browser.close();

// ---------- summary ----------
const sum = { fail: results.tests.filter((t) => !t.ok).length, pass: results.tests.filter((t) => t.ok).length, counts: {} };
for (const [c, r] of Object.entries(results.contexts)) for (const [p, d] of Object.entries(r.pages || {})) {
  for (const k of ["console", "failed", "overflow", "clipped", "smallTargets", "tinyText", "phoneBody", "lowContrast", "overlap"]) { const n = (d[k] || []).length; if (n) (sum.counts[k] ??= []).push(`${c} ${p}: ${n}`); }
  if (d.docOverflow) (sum.counts.docOverflow ??= []).push(`${c} ${p}`);
}
results.summary = sum;
fs.writeFileSync(`${OUT}/results-loop${LOOP}.json`, JSON.stringify(results, null, 1));
console.log(JSON.stringify(sum, null, 1));
