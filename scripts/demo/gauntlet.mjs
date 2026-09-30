// Gauntlet harness for the demo bugfix surfaces. Usage: node scripts/demo/gauntlet.mjs <baseUrl> <loop>
import { createRequire } from "node:module";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(os.homedir() + "/Documents/ai-employee-agent/package.json");
const { chromium, devices } = require("playwright");

const BASE = process.argv[2] || "http://localhost:3155";
const LOOP = process.argv[3] || "1";
const OUT = path.resolve("var/gauntlet");
const SHOTS = `${OUT}/shots/loop${LOOP}`;
fs.mkdirSync(SHOTS, { recursive: true });

const CONTEXTS = [
  { name: "laptop1440", kind: "laptop", viewport: { width: 1440, height: 900 } },
  { name: "laptop1280", kind: "laptop", viewport: { width: 1280, height: 800 } },
  { name: "phone390", kind: "phone", ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
  { name: "phone360", kind: "phone", ...devices["iPhone 13"], viewport: { width: 360, height: 740 }, deviceScaleFactor: 3 },
];

// In-page audit: returns every measurable defect class as data.
const AUDIT = (isPhone) => {
  const out = { overflow: [], clipped: [], small: [], smallText: [], bodyText: [], fixed: [] };
  const de = document.documentElement;
  out.scrollWidth = de.scrollWidth; out.clientWidth = de.clientWidth;
  const sel = (el) => (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : "") + " '" + (el.innerText || el.getAttribute("aria-label") || el.value || "").trim().replace(/\s+/g, " ").slice(0, 40) + "'");
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  const scrollAncestor = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p !== document.body && p !== de) return p; } return null; };
  for (const el of document.body.querySelectorAll("*")) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > de.clientWidth + 1 && !scrollAncestor(el) && getComputedStyle(el).position !== "fixed") out.overflow.push(sel(el) + " right=" + Math.round(r.right));
    // text clipping: content wider/taller than box while overflow hidden/ellipsis
    const s = getComputedStyle(el);
    if (el.children.length === 0 && el.textContent.trim() && (/(hidden|clip)/.test(s.overflowX) || s.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 1) out.clipped.push(sel(el) + ` sw=${el.scrollWidth} cw=${el.clientWidth}`);
    if (el.children.length === 0 && el.textContent.trim() && /(hidden|clip)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1 && !/(auto|scroll)/.test(s.overflowY)) out.clipped.push(sel(el) + ` sh=${el.scrollHeight} ch=${el.clientHeight}`);
    // text sizes on own text nodes
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) {
      const fs = parseFloat(s.fontSize);
      if (fs < 12) out.smallText.push(sel(el) + " " + fs + "px");
      if (isPhone && fs < 16 && /^(P|LABEL|DD|DT|LI|INPUT|TEXTAREA|SELECT|TD)$/.test(el.tagName)) out.bodyText.push(sel(el) + " " + fs + "px");
    }
    if (isPhone && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && parseFloat(s.fontSize) < 16) out.bodyText.push("FIELD " + sel(el) + " " + s.fontSize + " (iOS zoom)");
    // tap targets
    if (isPhone && el.matches("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=checkbox],[tabindex]:not([tabindex='-1'])")) {
      if (r.width < 44 - 0.5 || r.height < 44 - 0.5) {
        // label-wrapped or extended targets count if parent label is big enough
        const lab = el.closest("label"); const lr = lab ? lab.getBoundingClientRect() : null;
        if (!(lr && lr.width >= 44 && lr.height >= 44)) out.small.push(sel(el) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    if ((s.position === "fixed" || s.position === "sticky") && r.width > 0) {
      const covers = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).length;
      out.fixed.push(sel(el) + ` ${s.position} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} h/vh=${(r.height / innerHeight).toFixed(2)}`);
    }
  }
  return out;
};

const browser = await chromium.launch();
const results = { loop: LOOP, base: BASE, at: new Date().toISOString(), pages: {}, flows: [] };
const note = (ctx, page, kind, msg) => { (results.pages[`${ctx}|${page}`] ||= { errors: [], failed: [] })[kind].push(msg); };

async function login(page) {
  await page.goto(BASE + "/login", { waitUntil: "load" });
  await page.fill('input[name=email]', "owner@alphaos-demo.test");
  await page.fill('input[name=password]', "demoqc2026");
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 240000 }), page.locator('button[type=submit]').first().click()]);
}

const ids = {};
const boot = await browser.newContext(CONTEXTS[0]);
const bp = await boot.newPage(); bp.setDefaultTimeout(240000);
await login(bp);
if (bp.url().includes("/login")) throw new Error("login failed");
const STATE = await boot.storageState(); await boot.close();
for (const c of CONTEXTS) {
  const { name, kind, ...opts } = c;
  const ctx = await browser.newContext({ ...opts, storageState: STATE });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  let cur = "login";
  page.on("console", (m) => { if (m.type() === "error") note(name, cur, "errors", m.text().slice(0, 200)); });
  page.on("pageerror", (e) => note(name, cur, "errors", "pageerror " + e.message.slice(0, 200)));
  page.on("requestfailed", (r) => note(name, cur, "failed", r.url().slice(0, 120) + " " + r.failure()?.errorText));
  page.on("response", (r) => { if (r.status() >= 400) note(name, cur, "failed", r.status() + " " + r.url().slice(0, 120)); });
  const isPhone = kind === "phone";

  // discover ids from the orders list (search the whole list for the ORD numbers)
  if (!ids.ORD1003) {
    await page.goto(BASE + "/orders?q=ORD-10", { waitUntil: "load" });
    const links = await page.$$eval('a[href^="/orders/"]', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute("href")]));
    for (const n of ["1002", "1003", "1004"]) {
      const f = links.find(([t]) => t.includes("ORD-" + n));
      if (f) ids["ORD" + n] = f[1].split("/orders/")[1];
    }
    results.ids = ids;
  }
  const pages = [
    ["orders-new", "/orders/new"],
    ["qc-1003", `/qc/${ids.ORD1003}`],
    ["qc-1002", `/qc/${ids.ORD1002}`],
    ["order-1004", `/orders/${ids.ORD1004}`],
    ["order-1003", `/orders/${ids.ORD1003}`],
    ["designers", "/designers"],
    ["orders-list", "/orders"],
    ["home", "/dashboard"],
  ];
  for (const [pn, url] of pages) {
    cur = pn;
    await page.goto(BASE + url, { waitUntil: "load" });
    await page.waitForTimeout(600);
    const a = await page.evaluate(AUDIT, isPhone);
    const extra = await page.evaluate(() => ({
      imgs: [...document.images].map((i) => ({ src: i.currentSrc.slice(-50), nw: i.naturalWidth, w: Math.round(i.getBoundingClientRect().width), h: Math.round(i.getBoundingClientRect().height), ratioOk: i.naturalWidth ? Math.abs(i.getBoundingClientRect().width / i.getBoundingClientRect().height - i.naturalWidth / i.naturalHeight) < 0.08 || getComputedStyle(i).objectFit !== "fill" : null })),
      h1: document.querySelector("h1")?.innerText,
      text: document.body.innerText.slice(0, 3000),
    }));
    fs.writeFileSync(`${SHOTS}/${name}-${pn}.txt`, extra.text);
    results.pages[`${name}|${pn}`] = { ...(results.pages[`${name}|${pn}`] || { errors: [], failed: [] }), audit: a, imgs: extra.imgs, h1: extra.h1, hasHScroll: a.scrollWidth > a.clientWidth };
    await page.screenshot({ path: `${SHOTS}/${name}-${pn}.png`, fullPage: true });
  }

  // ---- Flows with real trusted input ----
  const flow = async (label, fn) => {
    try { const r = await fn(); results.flows.push({ ctx: name, label, ok: r?.ok !== false, ...r }); }
    catch (e) { results.flows.push({ ctx: name, label, ok: false, err: String(e.message).slice(0, 300) }); }
  };
  const tap = async (loc) => (isPhone ? loc.tap() : loc.click());

  cur = "flow-qc";
  await flow("qc: Order says panel + ORD link + Next/Prev", async () => {
    await page.goto(BASE + `/qc/${ids.ORD1003}`, { waitUntil: "load" });
    const panel = page.getByTestId("order-says");
    await panel.waitFor();
    const txt = await panel.innerText();
    const hasAll = ["Order says", "Listing", "Product and size", "Personalization"].every((t) => txt.includes(t));
    const link = page.locator("h1 a").first();
    const box = await link.boundingBox();
    const [popup] = await Promise.all([ctx.waitForEvent("page"), tap(link)]);
    await popup.waitForLoadState("domcontentloaded");
    const popUrl = popup.url(); await popup.close();
    const next = page.getByRole("button", { name: /Next/ });
    const before = page.url();
    if (await next.isEnabled()) { await tap(next); await page.waitForTimeout(1200); }
    const afterNext = page.url();
    const prev = page.getByRole("button", { name: /Prev/ });
    if (await prev.isEnabled()) { await tap(prev); await page.waitForTimeout(1200); }
    // panel geometry vs images and checklist
    const geo = await page.evaluate(() => {
      const p = document.querySelector('[data-testid=order-says]').getBoundingClientRect();
      const imgs = [...document.querySelectorAll("main img")].map((i) => { const r = i.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
      return { panel: { l: Math.round(p.left), t: Math.round(p.top), w: Math.round(p.width), h: Math.round(p.height) }, imgs, vh: innerHeight };
    });
    return { ok: hasAll && popUrl.includes(`/orders/${ids.ORD1003}`), hasAll, linkBox: box && { w: Math.round(box.width), h: Math.round(box.height) }, popUrl: popUrl.replace(BASE, ""), navMoved: before !== afterNext, geo, panelText: txt.slice(0, 500) };
  });
  await flow("qc: guessed style flag on ORD-1002", async () => {
    await page.goto(BASE + `/qc/${ids.ORD1002}`, { waitUntil: "load" });
    const t = await page.locator("main").first().innerText();
    return { ok: /Style \(guessed\)/.test(t), header: t.replace(/\s+/g, " ").slice(0, 300) };
  });
  await flow("order 1004 photo renders", async () => {
    await page.goto(BASE + `/orders/${ids.ORD1004}`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    const imgs = await page.$$eval("img", (is) => is.map((i) => ({ src: i.currentSrc, nw: i.naturalWidth, w: Math.round(i.getBoundingClientRect().width), h: Math.round(i.getBoundingClientRect().height), fit: getComputedStyle(i).objectFit, alt: i.alt })));
    const real = imgs.filter((i) => i.w > 60);
    return { ok: real.length > 0 && real.every((i) => i.nw > 0), imgs: real };
  });
  await flow("orders/new: Size field usable, not submitted", async () => {
    await page.goto(BASE + "/orders/new", { waitUntil: "load" });
    const f = page.getByLabel(/Size \/ canvas/i);
    await f.scrollIntoViewIfNeeded();
    await tap(f);
    await page.keyboard.type("16x20 canvas");
    const v = await f.inputValue();
    const attrs = await f.evaluate((e) => ({ type: e.type, inputmode: e.inputMode, list: e.getAttribute("list"), fs: getComputedStyle(e).fontSize, h: Math.round(e.getBoundingClientRect().height), inView: e.getBoundingClientRect().bottom <= innerHeight + 1 }));
    const inputs = await page.$$eval("input,textarea,select", (es) => es.filter((e) => e.type !== "hidden" && e.offsetParent).map((e) => `${e.tagName.toLowerCase()}:${e.type}:${e.name || e.id}:${e.inputMode || "-"}:${e.autocomplete || "-"}`));
    return { ok: v === "16x20 canvas", attrs, inputs };
  });
  await flow("designers: no duplicate AI Studio", async () => {
    await page.goto(BASE + "/designers", { waitUntil: "load" });
    const body = await page.innerText("main");
    // one AI Studio per business is the intended state; a defect is the same label twice
    const labels = (body.match(/AI Studio[^\n]*/g) || []).map((s) => s.trim());
    const dup = labels.filter((l, i) => labels.indexOf(l) !== i);
    return { ok: dup.length === 0, aiStudioLabels: labels, duplicates: dup };
  });
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`${OUT}/results-loop${LOOP}.json`, JSON.stringify(results, null, 1));
// concise digest
let bad = 0;
for (const [k, v] of Object.entries(results.pages)) {
  const a = v.audit; if (!a) continue;
  const parts = [];
  if (a.scrollWidth > a.clientWidth) parts.push(`HSCROLL ${a.scrollWidth}>${a.clientWidth}`);
  for (const key of ["overflow", "clipped", "small", "smallText", "bodyText"]) if (a[key].length) parts.push(`${key}:${a[key].length}`);
  if (v.errors.length) parts.push(`console:${v.errors.length}`);
  if (v.failed.length) parts.push(`failed:${v.failed.length}`);
  if (parts.length) { bad++; console.log(k, parts.join(" ")); }
}
for (const f of results.flows) if (!f.ok) console.log("FLOW FAIL", f.ctx, f.label, f.err || "");
console.log("done; pages with findings:", bad);
