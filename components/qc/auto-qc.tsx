/**
 * Auto QC badge and notes (Yousif 2026-10-14). The AI's look at the artwork,
 * shown next to the owner's own QC. It never decides anything: the owner
 * reads it and approves or rejects as before. docs/AUTO_QC.md.
 */
import type { AutoQcCheck, AutoQcPortrait, AutoQcView } from "@/lib/qc/auto-qc";
import { cn } from "@/lib/utils";

function badgeText(v: AutoQcView | null): { text: string; tone: string; title: string } {
  if (!v) return { text: "Auto QC pending", tone: "bg-canvas text-slate", title: "The AI has not looked at this artwork yet" };
  if (!v.current)
    return { text: "Auto QC'd an older version", tone: "bg-canvas text-slate", title: "The designer uploaded again; a fresh check is coming" };
  if (v.wrongFile)
    return { text: `Wrong file: ${v.wrongFile.note}`, tone: "bg-rose/10 text-rose", title: "Auto QC thinks this is not this order's artwork" };
  if (v.verdict === "pass") return { text: "Has been Auto QC'd · looks right", tone: "bg-sage/10 text-sage", title: v.summary ?? "" };
  if (v.verdict === "issues")
    return {
      text: `Has been Auto QC'd · ${v.issues || 1} issue${v.issues === 1 ? "" : "s"}`,
      tone: "bg-rose/10 text-rose",
      title: v.summary ?? "",
    };
  return { text: "Has been Auto QC'd · couldn't judge", tone: "bg-amber/10 text-amber", title: v.summary ?? "" };
}

export function AutoQcBadge({ view, size = "md" }: { view: AutoQcView | null; size?: "sm" | "md" }) {
  const b = badgeText(view);
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-input font-semibold",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm",
        b.tone,
      )}
      title={b.title || undefined}
      data-testid="auto-qc-badge"
      data-verdict={view ? (view.current ? view.verdict : "stale") : "pending"}
    >
      <span className="min-w-0 truncate">{b.text}</span>
    </span>
  );
}

function CheckLine({ c, tone }: { c: AutoQcCheck; tone: string }) {
  return (
    <li className="flex flex-col gap-0.5">
      <span className={cn("text-sm font-semibold", tone)}>{c.label}</span>
      {c.note ? <span className="whitespace-pre-wrap break-words text-sm text-ink">{c.note}</span> : null}
    </li>
  );
}

function PortraitNotes({ p, labelled }: { p: AutoQcPortrait; labelled: boolean }) {
  const failed = p.checks.filter((c) => c.result === "fail");
  const unsure = p.checks.filter((c) => c.result === "unsure");
  const passed = p.checks.filter((c) => c.result === "pass");
  const na = p.checks.filter((c) => c.result === "na");
  return (
    <div className="flex flex-col gap-2">
      {labelled ? (
        <p className="text-sm font-semibold text-ink">{p.portrait ? `Portrait ${p.portrait}` : "Untagged upload"}</p>
      ) : null}
      {/* One portrait: its summary is the order summary already shown above, so it is not repeated. */}
      {labelled && p.summary ? <p className="break-words text-sm text-slate">{p.summary}</p> : null}
      {failed.length ? (
        <ul className="flex flex-col gap-2 rounded-card border border-rose/30 bg-rose/5 p-3" aria-label="Problems found">
          {failed.map((c) => (
            <CheckLine key={c.key} c={c} tone="text-rose" />
          ))}
        </ul>
      ) : null}
      {unsure.length ? (
        <ul className="flex flex-col gap-2 rounded-card border border-amber/30 bg-amber/5 p-3" aria-label="Could not tell">
          {unsure.map((c) => (
            <CheckLine key={c.key} c={{ ...c, label: `${c.label}: could not tell` }} tone="text-amber" />
          ))}
        </ul>
      ) : null}
      {passed.length || na.length ? (
        <details className="rounded-card border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate">
            Passed ({passed.length}){na.length ? ` · not in the photos (${na.length})` : ""}
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {passed.map((c) => (
              <CheckLine key={c.key} c={c} tone="text-sage" />
            ))}
            {na.map((c) => (
              <CheckLine key={c.key} c={{ ...c, label: `${c.label}: not in the photos` }} tone="text-slate" />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function AutoQcNotes({ view }: { view: AutoQcView | null }) {
  return (
    <div className="flex flex-col gap-2" data-testid="auto-qc-notes">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate">Auto QC</h2>
      {!view ? (
        <p className="text-sm text-slate">The AI has not checked this artwork yet. It looks at new uploads every few minutes.</p>
      ) : (
        <>
          {!view.current ? (
            <p className="rounded-card bg-canvas p-3 text-sm text-slate">
              These notes are about an older version. The designer uploaded again, so a fresh check is coming.
            </p>
          ) : null}
          {view.current && view.wrongFile ? (
            <p className="rounded-card border border-rose/30 bg-rose/5 p-3 text-sm font-semibold text-rose" data-testid="auto-qc-wrong-file">
              Wrong file: {view.wrongFile.note}
            </p>
          ) : null}
          {view.summary ? <p className="break-words text-base text-ink">{view.summary}</p> : null}
          {view.revision ? (
            <div
              className={cn(
                "flex flex-col gap-1 rounded-card border p-3",
                view.revision.done === "yes" ? "border-sage/30 bg-sage/5" : "border-rose/30 bg-rose/5",
              )}
            >
              <p className={cn("text-sm font-semibold", view.revision.done === "yes" ? "text-sage" : "text-rose")}>
                {view.revision.done === "yes"
                  ? "Revision done fully"
                  : view.revision.done === "partly"
                    ? "Revision only partly done"
                    : "Revision not done"}
              </p>
              {view.revision.note ? <p className="break-words text-sm text-ink">{view.revision.note}</p> : null}
              {view.revision.missed.length ? (
                <ul className="list-disc pl-5 text-sm text-ink">
                  {view.revision.missed.map((m) => (
                    <li key={m} className="break-words">
                      Missed: {m}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {view.portraits.map((p, i) => (
            <PortraitNotes key={`${p.assetId}-${i}`} p={p} labelled={view.portraits.length > 1} />
          ))}
          <p className="text-xs text-slate" suppressHydrationWarning>
            Checked {new Date(view.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.
            Notes only: you still approve or reject.
          </p>
        </>
      )}
    </div>
  );
}
