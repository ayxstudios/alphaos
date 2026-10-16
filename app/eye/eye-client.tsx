"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EyeData, EyeOrder } from "@/lib/eye/data";

import { createEngine, type Engine, type LayoutInfo } from "./eye-engine";
import { HEALTH_COLOR, ageText, healthOf, sentimentWords, type EyeFilter } from "./eye-math";
import { makeSyntheticData } from "./eye-synthetic";

const POLL_MS = 45_000;

const EMPTY_DATA: EyeData = {
  generatedAt: new Date(0).toISOString(),
  businesses: [],
  totals: { open: 0, delayed: 0, urgent: 0, waitingOnBuyer: 0, unhappy: 0, printing: 0, completedToday: 0 },
  orders: [],
  events: [],
};

const CHIPS: { key: EyeFilter; label: string; color: string; count: (d: EyeData) => number }[] = [
  { key: "delayed", label: "Delayed", color: HEALTH_COLOR.amber, count: (d) => d.totals.delayed },
  { key: "unhappy", label: "Unhappy", color: HEALTH_COLOR.unhappy, count: (d) => d.totals.unhappy },
  { key: "waiting", label: "Waiting on buyer", color: HEALTH_COLOR.violet, count: (d) => d.totals.waitingOnBuyer },
  { key: "printing", label: "Delivery", color: HEALTH_COLOR.ok, count: (d) => d.totals.printing },
  { key: "done", label: "Done today", color: HEALTH_COLOR.done, count: (d) => d.totals.completedToday },
];

const CSS = `
.eye-root{position:fixed;inset:0;background:#05070f;color:#cfe3ff;overflow:hidden;font-family:var(--font-inter),Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.eye-root *{box-sizing:border-box}
.eye-canvas{position:absolute;left:0;top:0;display:block;touch-action:manipulation}
.eye-top{position:absolute;left:0;right:0;top:0;z-index:5;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 24px 10px;pointer-events:none;background:linear-gradient(#05070f 0%,rgba(5,7,15,.75) 60%,rgba(5,7,15,0))}
.eye-top>*{pointer-events:auto}
.eye-title{font-family:var(--font-instrument-sans),'Instrument Sans',Inter,sans-serif;font-size:12px;font-weight:600;letter-spacing:.34em;color:#e4efff;white-space:nowrap}
.eye-sub{margin-top:7px;font-size:12px;color:rgba(170,195,235,.7);display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.eye-clock{font-variant-numeric:tabular-nums;color:rgba(200,220,255,.85)}
.eye-stale{color:#ffb347}
.eye-demo{display:inline-block;margin-left:12px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,179,71,.6);color:#ffb347;font-size:10px;font-weight:600;letter-spacing:.2em;vertical-align:1px}
.eye-down{position:absolute;z-index:3;left:50%;transform:translateX(-50%);text-align:center;max-width:min(420px,86vw);font-size:12px;line-height:1.5;color:rgba(190,210,245,.8);pointer-events:none}
.eye-down em{display:block;font-style:normal;color:rgba(150,175,220,.6);margin-top:2px}
.eye-chips{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.eye-chip{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 14px;border-radius:999px;border:1px solid rgba(130,170,255,.2);background:rgba(10,16,34,.72);color:#cfe3ff;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;backdrop-filter:blur(6px);transition:border-color .2s,background .2s,opacity .2s}
.eye-chip:hover{border-color:rgba(160,200,255,.5)}
.eye-chip[aria-pressed=true]{background:rgba(30,50,100,.75);border-color:rgba(190,225,255,.85)}
.eye-chip i{width:8px;height:8px;border-radius:50%;box-shadow:0 0 8px currentColor;background:currentColor}
.eye-chip b{font-variant-numeric:tabular-nums;font-weight:600}
.eye-core{position:absolute;z-index:2;transform:translate(-50%,-50%);text-align:center;pointer-events:none;display:flex;flex-direction:column;align-items:center}
.eye-core b{font-family:var(--font-instrument-sans),'Instrument Sans',Inter,sans-serif;font-weight:500;line-height:1;color:#f2f8ff;text-shadow:0 0 18px rgba(159,216,255,.8)}
.eye-core span{margin-top:5px;font-size:9px;letter-spacing:.3em;text-indent:.3em;color:rgba(180,210,255,.7)}
.eye-tip{position:absolute;z-index:6;pointer-events:none;transform:translate(-50%,calc(-100% - 14px));padding:6px 10px;border-radius:8px;background:rgba(8,12,26,.94);border:1px solid rgba(130,170,255,.3);font-size:12px;white-space:nowrap;color:#e4efff}
.eye-tip em{font-style:normal;color:rgba(170,195,235,.75)}
.eye-ticker{position:absolute;z-index:5;left:0;right:0;bottom:0;height:36px;display:flex;align-items:center;justify-content:center;padding:0 16px env(safe-area-inset-bottom);font-size:12px;color:rgba(170,195,235,.8);background:linear-gradient(rgba(5,7,15,0),rgba(5,7,15,.9));overflow:hidden}
.eye-ticker span{animation:eyefade 4.2s ease both;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.eye-ticker.paused span{animation-play-state:paused}
@keyframes eyedrift{to{transform:translateX(var(--eye-w,-100px))}}
@keyframes eyefade{0%{opacity:0;transform:translateY(5px)}12%{opacity:1;transform:none}88%{opacity:1}100%{opacity:0}}
.eye-panel{position:absolute;z-index:8;right:0;bottom:0;width:380px;max-width:100%;background:rgba(7,11,24,.94);backdrop-filter:blur(14px);border-left:1px solid rgba(130,170,255,.2);transform:translateX(104%);transition:transform .35s cubic-bezier(.2,.8,.2,1),visibility 0s .35s;visibility:hidden;display:flex;flex-direction:column}
.eye-panel.open{transform:none;visibility:visible;transition:transform .35s cubic-bezier(.2,.8,.2,1)}
.eye-ph{display:flex;justify-content:space-between;gap:12px;padding:20px 20px 12px}
.eye-shop{font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:rgba(170,195,235,.75)}
.eye-no{font-family:var(--font-instrument-sans),'Instrument Sans',Inter,sans-serif;font-size:24px;font-weight:500;color:#f2f8ff;margin-top:4px}
.eye-ttl{font-size:13px;color:rgba(200,220,255,.8);margin-top:2px}
.eye-x{flex:none;width:44px;height:44px;margin:-8px -10px 0 0;border:0;border-radius:50%;background:transparent;color:#cfe3ff;font-size:22px;cursor:pointer}
.eye-x:hover{background:rgba(130,170,255,.12)}
.eye-pb{padding:0 20px 24px;overflow:auto;flex:1;-webkit-overflow-scrolling:touch}
.eye-sent{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;border:1px solid;font-size:12px;margin-bottom:14px}
.eye-sent i{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}
.eye-rows{display:grid;grid-template-columns:96px 1fr;gap:9px 12px;font-size:13px;margin:0}
.eye-rows dt{color:rgba(150,175,220,.7)}
.eye-rows dd{margin:0;color:#e4efff;min-width:0;overflow-wrap:anywhere}
.eye-late{color:#ff6b86;font-weight:600}
.eye-tag{display:inline-block;margin:0 6px 4px 0;padding:2px 8px;border-radius:999px;background:rgba(255,179,71,.12);color:#ffcf8a;font-size:11px}
.eye-quote{margin:16px 0 0;padding:12px 14px;border-left:2px solid rgba(139,124,246,.7);background:rgba(139,124,246,.07);border-radius:0 8px 8px 0;font-size:13px;line-height:1.5;color:#dbe7ff}
.eye-quote small{display:block;margin-top:6px;color:rgba(150,175,220,.7);font-size:11px}
.eye-open{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:18px;padding:0 18px;border-radius:10px;border:1px solid rgba(159,216,255,.5);color:#e8f6ff;text-decoration:none;font-size:13px}
.eye-open:hover{background:rgba(159,216,255,.1)}
@media (max-width:639px){
.eye-top{flex-direction:column;gap:10px;padding:14px 14px 8px}
.eye-chips{flex-wrap:nowrap;overflow-x:auto;justify-content:flex-start;width:calc(100% + 28px);margin:0 -14px;padding:0 0 2px 14px;scroll-padding:0 40px 0 14px;scrollbar-width:none;-webkit-overflow-scrolling:touch;-webkit-mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 34px),transparent);mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 34px),transparent)}
.eye-chips::after{content:"";flex:none;width:44px}
.eye-chips::-webkit-scrollbar{display:none}
.eye-chip{min-height:40px;flex:none}
.eye-panel{left:0;right:0;top:auto!important;bottom:0;width:100%;height:55dvh;max-height:55dvh;border-left:0;border-top:1px solid rgba(130,170,255,.25);border-radius:18px 18px 0 0;transform:translateY(104%);box-shadow:0 -18px 50px rgba(0,0,0,.5)}
.eye-panel.open{transform:none}
.eye-ph{padding-top:16px}
}
@media (prefers-reduced-motion:reduce){.eye-panel,.eye-panel.open{transition:none}.eye-ticker span{animation:none}}
`;

function fmtTime(d: Date) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
}
function fmtClock(d: Date) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }).toLowerCase();
}

function Panel({ o, open, top, onClose }: { o: EyeOrder | null; open: boolean; top: number | undefined; onClose: () => void }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const health = o ? healthOf(o) : "ok";
  const sentColor = !o ? "#9fd8ff" : o.sentiment === "unhappy" ? HEALTH_COLOR.unhappy : o.sentiment === "attention" ? HEALTH_COLOR.amber : o.sentiment === "happy" ? HEALTH_COLOR.done : "#9fb4d8";
  return (
    <aside className={`eye-panel${open ? " open" : ""}`} style={{ top }} role="dialog" aria-label="Order detail" aria-hidden={!open}>
      {o && (
        <>
          <div className="eye-ph">
            <div style={{ minWidth: 0 }}>
              <div className="eye-shop">{o.business}</div>
              <div className="eye-no">{o.orderNumber}</div>
              {o.title && <div className="eye-ttl">{o.title}</div>}
            </div>
            <button className="eye-x" onClick={onClose} aria-label="Close">
              {"×"}
            </button>
          </div>
          <div className="eye-pb">
            <div className="eye-sent" style={{ color: sentColor, borderColor: sentColor + "66" }}>
              <i />
              {sentimentWords(o.sentiment)}
            </div>
            <dl className="eye-rows">
              <dt>Buyer</dt>
              <dd>{o.buyerFirstName ?? "Unknown"}</dd>
              <dt>Stage</dt>
              <dd>
                {o.stage.label}
                {now > 0 && <span style={{ color: "rgba(150,175,220,.75)" }}> {"·"} {ageText(now - new Date(o.stageSince).getTime())} in stage</span>}
                {o.held && <span className="eye-tag" style={{ marginLeft: 8, background: "rgba(160,168,184,.15)", color: "#c4cbd8" }}>on hold</span>}
              </dd>
              <dt>Due</dt>
              <dd>
                {o.dueAt ? new Date(o.dueAt).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "No due date"}
                {o.delayed && <span className="eye-late"> {"·"} {o.overdueHours}h overdue</span>}
                {o.urgent && !o.delayed && <span style={{ color: HEALTH_COLOR.amber }}> {"·"} urgent</span>}
              </dd>
              <dt>Designer</dt>
              <dd>{o.designer ?? "Not assigned"}</dd>
              <dt>Revisions</dt>
              <dd>{o.revisionCount}</dd>
              {o.print && (
                <>
                  <dt>Print</dt>
                  <dd>
                    {o.print.provider}
                    {o.print.status ? ` · ${o.print.status}` : ""}
                    {o.print.tracking ? ` · ${o.print.tracking}` : ""}
                  </dd>
                </>
              )}
              {o.exceptions.length > 0 && (
                <>
                  <dt>Flags</dt>
                  <dd>
                    {o.exceptions.map((x) => (
                      <span className="eye-tag" key={x}>
                        {x.replace(/_/g, " ")}
                      </span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
            {o.lastBuyerMessage && (
              <blockquote className="eye-quote">
                {"“"}
                {o.lastBuyerMessage.snippet}
                {"”"}
                <small>
                  {o.buyerFirstName ?? "Buyer"} {"·"} {now > 0 ? `${ageText(now - new Date(o.lastBuyerMessage.at).getTime())} ago` : ""}
                </small>
              </blockquote>
            )}
            <a className="eye-open" href={o.href} target="_blank" rel="noopener noreferrer" style={{ borderColor: HEALTH_COLOR[health] + "99" }}>
              Open order
            </a>
          </div>
        </>
      )}
    </aside>
  );
}

export function EyeClient({ initial }: { initial: EyeData | null }) {
  const [data, setData] = useState<EyeData>(initial ?? EMPTY_DATA);
  const [everOk, setEverOk] = useState(initial !== null);
  const [demo, setDemo] = useState(false);
  const [lastOk, setLastOk] = useState<number>(0);
  const [lastTried, setLastTried] = useState<number>(0);
  const [failed, setFailed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<EyeFilter | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shown, setShown] = useState<EyeOrder | null>(null);
  const [tip, setTip] = useState<{ o: EyeOrder; x: number; y: number } | null>(null);
  const [lay, setLay] = useState<LayoutInfo | null>(null);
  const [topH, setTopH] = useState(72);
  const [evIdx, setEvIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const dataRef = useRef(data);
  const synthetic = useRef(false);
  const pushed = useRef<EyeData | null>(null);
  const nextInitial = useRef(false);
  const lastOkRef = useRef(0);

  // clock + staleness tick
  useEffect(() => {
    setMounted(true);
    setLastOk(Date.now());
    setLastTried(Date.now());
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // engine lifecycle, sizing, visibility
  useEffect(() => {
    const canvas = canvasRef.current!;
    const root = rootRef.current!;
    const eng = createEngine({
      canvas,
      onHover: (o, x, y) => setTip(o ? { o, x, y } : null),
      onSelect: (id) => setSelectedId(id),
      onLayout: (l) => setLay(l),
    });
    engineRef.current = eng;
    const fit = () => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      const compact = w < 640;
      const th = topRef.current?.offsetHeight ?? (compact ? 120 : 72);
      setTopH(th);
      eng.resize(w, h, { top: th, bottom: 36, reserveRight: 0, compact });
    };
    fit();
    eng.setData(dataRef.current, true);
    pushed.current = dataRef.current;
    eng.setActive(!document.hidden);
    const ro = new ResizeObserver(fit);
    ro.observe(root);
    if (topRef.current) ro.observe(topRef.current);
    const vis = () => eng.setActive(!document.hidden);
    document.addEventListener("visibilitychange", vis);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      ro.disconnect();
      eng.destroy();
      engineRef.current = null;
    };
  }, []);

  // synthetic demo feed: /eye?synthetic=500 (admin-only page, so allowed in production too)
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("synthetic");
    if (raw === null) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    synthetic.current = true;
    nextInitial.current = true;
    setDemo(true);
    setEverOk(true);
    setData(makeSyntheticData(Math.min(n, 600)));
  }, []);

  // push data into the engine
  useEffect(() => {
    if (pushed.current === data) return;
    pushed.current = data;
    engineRef.current?.setData(data, nextInitial.current);
    nextInitial.current = false;
  }, [data]);

  useEffect(() => {
    engineRef.current?.setFilter(filter);
  }, [filter]);
  useEffect(() => {
    engineRef.current?.setSelected(selectedId);
  }, [selectedId]);

  // polling
  const poll = useCallback(async () => {
    if (document.hidden || synthetic.current) return;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch("/api/eye", { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as EyeData;
      setData(d);
      setLastOk(Date.now());
      setFailed(false);
      setEverOk(true);
    } catch {
      setFailed(true);
    } finally {
      setLastTried(Date.now());
      clearTimeout(to);
    }
  }, []);
  useEffect(() => {
    if (initial === null) void poll();
    const t = setInterval(poll, POLL_MS);
    const vis = () => {
      if (!document.hidden && Date.now() - lastOkRef.current > POLL_MS) poll();
    };
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll]);
  useEffect(() => {
    lastOkRef.current = lastOk;
  }, [lastOk]);

  // selected order follows live data; keep the last snapshot if it leaves
  const selected = useMemo(() => (selectedId ? data.orders.find((o) => o.id === selectedId) ?? null : null), [data, selectedId]);
  useEffect(() => {
    if (selected) setShown(selected);
  }, [selected]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ticker
  const events = data.events;
  useEffect(() => {
    if (paused || events.length < 2) return;
    const t = setInterval(() => setEvIdx((i) => i + 1), 4200);
    return () => clearInterval(t);
  }, [paused, events.length]);
  const ev = events.length ? events[evIdx % events.length] : null;

  const staleMin = mounted && lastOk ? Math.floor((Date.now() - lastOk) / 60000) : 0;
  void tick;
  const down = !everOk;
  const triedMin = mounted && lastTried ? Math.floor((Date.now() - lastTried) / 60000) : 0;
  const showStale = !demo && !down && (failed || staleMin >= 2);
  const shops = data.businesses.length;
  const compactLay = lay?.compact ?? false;
  const coreNumSize = lay ? Math.max(20, Math.min(54, lay.coreR * 0.9)) : 36;

  return (
    <div className="eye-root" ref={rootRef}>
      <style>{CSS}</style>
      <canvas ref={canvasRef} className="eye-canvas" aria-label="Live map of every order across every shop" role="img" />

      <div className="eye-top" ref={topRef}>
        <div>
          <div className="eye-title">
            THE ALL SEEING EYE
            {demo && <span className="eye-demo">DEMO DATA</span>}
          </div>
          <div className="eye-sub">
            <span className="eye-clock">{mounted ? fmtClock(new Date()) : " "}</span>
            <span>
              watching {data.totals.open} order{data.totals.open === 1 ? "" : "s"} across {shops} shop{shops === 1 ? "" : "s"}
            </span>
            {showStale && <span className="eye-stale">last updated {staleMin < 1 ? "moments" : `${staleMin}m`} ago{failed ? " (retrying)" : ""}</span>}
          </div>
        </div>
        <div className="eye-chips" role="group" aria-label="Filter">
          {CHIPS.map((c) => (
            <button
              key={c.key}
              className="eye-chip"
              aria-pressed={filter === c.key}
              style={{ opacity: filter && filter !== c.key ? 0.55 : 1 }}
              onClick={() => setFilter((f) => (f === c.key ? null : c.key))}
            >
              <i style={{ color: c.color }} />
              {c.label}
              <b>{c.count(data)}</b>
            </button>
          ))}
        </div>
      </div>

      {lay && (
        <div className="eye-core" style={{ left: lay.cx, top: lay.cy }}>
          {down ? (
            <>
              <b style={{ fontSize: Math.max(14, coreNumSize * 0.4), fontWeight: 400, letterSpacing: ".12em" }}>resting</b>
            </>
          ) : (
            <>
              <b style={{ fontSize: coreNumSize }}>{data.totals.open}</b>
              <span>WATCHING</span>
            </>
          )}
        </div>
      )}

      {down && lay && (
        <div className="eye-down" style={{ top: lay.cy + lay.coreR + 28 }}>
          The Eye can{"'"}t reach AlphaOS right now. It reconnects automatically.
          <em>last tried {triedMin < 1 ? "moments" : `${triedMin}m`} ago</em>
        </div>
      )}

      {tip && !selectedId && (
        <div className="eye-tip" style={{ left: Math.max(70, tip.x), top: tip.y }}>
          {tip.o.orderNumber} <em>{"·"} {tip.o.business} {"·"} {tip.o.stage.label}</em>
        </div>
      )}

      <Panel o={shown} open={!!selectedId} top={compactLay ? undefined : topH} onClose={() => setSelectedId(null)} />

      <div className={`eye-ticker${paused ? " paused" : ""}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onTouchStart={() => setPaused((p) => !p)}>
        {mounted && ev ? (
          <span key={evIdx}>
            {fmtTime(new Date(ev.at))} {"·"} {ev.business} {ev.orderNumber} {"·"} {ev.label}
          </span>
        ) : null}
      </div>
    </div>
  );
}
