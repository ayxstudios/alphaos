/**
 * AI fix samples on /approve (Yousif 2026-10-14). When Auto QC finds problems,
 * the AI repaints only those spots on the designer's portrait. This panel shows
 * what it changed, each spot zoomed in before and after, and what it left
 * alone. It is a suggestion: the owner sends it with "Send AI fix", or ignores
 * it and approves or rejects as usual. docs/AUTO_QC.md "Fix samples".
 */
import type { AutoQcFixQc, AutoQcFixView, FixBox } from "@/lib/qc/auto-qc-fix";
import { cn } from "@/lib/utils";

/**
 * Auto QC of the fix itself (Yousif 2026-10-14: "The AutoQC should even judge
 * the AI fix too"): the same judge that checks the designer's version checks
 * the fix image, and the verdict sits right on the fix so the owner knows it
 * was checked before tapping Send AI fix.
 */
function FixQcBadge({ qc }: { qc: AutoQcFixQc | null }) {
  const failed = qc?.checks.filter((c) => c.result === "fail") ?? [];
  const b = !qc
    ? { text: "Auto QC of this fix pending", tone: "bg-canvas text-slate", title: "The judge checks new fixes every few minutes" }
    : qc.verdict === "pass"
      ? { text: "Auto QC'd this fix · looks right", tone: "bg-sage/10 text-sage", title: qc.summary ?? "" }
      : qc.verdict === "issues"
        ? { text: `Auto QC'd this fix · ${failed.length || 1} issue${failed.length === 1 ? "" : "s"}`, tone: "bg-rose/10 text-rose", title: qc.summary ?? "" }
        : { text: "Auto QC'd this fix · couldn't judge", tone: "bg-amber/10 text-amber", title: qc.summary ?? "" };
  return (
    <div className="flex flex-col gap-2">
      <span
        className={cn("inline-flex max-w-full items-center self-start rounded-input px-2 py-0.5 text-xs font-semibold", b.tone)}
        title={b.title || undefined}
        data-testid="ai-fix-qc-badge"
        data-verdict={qc?.verdict ?? "pending"}
      >
        <span className="min-w-0 truncate">{b.text}</span>
      </span>
      {failed.length ? (
        <ul className="flex flex-col gap-1 rounded-card border border-rose/30 bg-rose/5 p-3" aria-label="Problems Auto QC found in the fix">
          {failed.map((c) => (
            <li key={c.key} className="break-words text-sm text-ink">
              <span className="font-semibold text-rose">{c.label}</span>
              {c.note ? `: ${c.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The spot with some room around it, so the change reads in context. */
function padBox(b: FixBox, pad = 0.35): FixBox {
  const m = Math.max(b.x1 - b.x0, b.y1 - b.y0) * pad;
  return { x0: Math.max(0, b.x0 - m), y0: Math.max(0, b.y0 - m), x1: Math.min(1, b.x1 + m), y1: Math.min(1, b.y1 + m) };
}

/** One picture cropped to `box` with CSS only (the full file is already signed, no extra upload). */
function ZoomTile({ url, box, aspect, label }: { url: string; box: FixBox; aspect: number; label: string }) {
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const pos = (start: number, size: number) => (size >= 0.999 ? 0 : (start / (1 - size)) * 100);
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <div
        role="img"
        aria-label={label}
        className="w-full rounded-input bg-canvas bg-no-repeat"
        style={{
          aspectRatio: `${(bw * aspect).toFixed(4)} / ${bh.toFixed(4)}`,
          backgroundImage: `url("${url}")`,
          backgroundSize: `${(100 / bw).toFixed(3)}% ${(100 / bh).toFixed(3)}%`,
          backgroundPosition: `${pos(box.x0, bw).toFixed(3)}% ${pos(box.y0, bh).toFixed(3)}%`,
        }}
      />
      <figcaption className="text-xs text-slate">{label}</figcaption>
    </figure>
  );
}

function FixCard({ fix, beforeUrl, labelled }: { fix: AutoQcFixView; beforeUrl: string | null; labelled: boolean }) {
  const aspect = fix.width && fix.height ? fix.width / fix.height : 0.8;
  return (
    <div className="flex flex-col gap-3">
      {labelled ? <p className="text-sm font-semibold text-ink">{fix.portrait ? `Portrait ${fix.portrait}` : "Untagged upload"}</p> : null}
      <FixQcBadge qc={fix.qc} />
      <ul className="flex flex-col gap-3" aria-label="What the AI changed">
        {fix.fixed.map((a, i) => (
          <li key={i} className="flex flex-col gap-2">
            <p className="break-words text-sm text-ink">
              <span className="font-semibold text-pigment">{a.label || "Fixed"}</span>
              {a.what ? `: ${a.what}` : ""}
            </p>
            {a.box && fix.url && beforeUrl ? (
              <div className="grid grid-cols-2 gap-2">
                <ZoomTile url={beforeUrl} box={padBox(a.box)} aspect={aspect} label="Designer's" />
                <ZoomTile url={fix.url} box={padBox(a.box)} aspect={aspect} label="AI fix" />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {fix.notFixed.length ? (
        <ul className="flex flex-col gap-1 rounded-card border border-amber/30 bg-amber/5 p-3" aria-label="Not fixed">
          {fix.notFixed.map((m, i) => (
            <li key={i} className="break-words text-sm text-ink">
              <span className="font-semibold text-amber">Not fixed{m.label ? `: ${m.label}` : ""}</span>
              {m.why ? `. ${m.why}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The AI fix panel. `beforeUrl(assetId)` resolves the designer version each fix
 * was painted on (already signed on the page).
 */
export function AiFixPanel({ fixes, beforeUrl, onShow }: { fixes: AutoQcFixView[]; beforeUrl: (assetId: string) => string | null; onShow?: () => void }) {
  if (!fixes.length) return null;
  return (
    <div className={cn("flex flex-col gap-3 rounded-card border border-pigment/30 bg-pigment-soft p-3")} data-testid="ai-fix-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-pigment">AI fix ready</h2>
        {onShow ? (
          <button type="button" onClick={onShow} className="min-h-11 rounded-input px-2 text-sm font-medium text-pigment underline-offset-2 hover:underline sm:min-h-0">
            See it full size
          </button>
        ) : null}
      </div>
      <p className="text-sm text-slate">A suggestion. Only these spots changed, the rest is the designer&apos;s own work.</p>
      {fixes.map((f) => (
        <FixCard key={f.id} fix={f} beforeUrl={beforeUrl(f.sourceAssetId)} labelled={fixes.length > 1} />
      ))}
    </div>
  );
}
