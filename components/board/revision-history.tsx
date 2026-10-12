"use client";

import { cn } from "@/lib/utils";
import { CopyField, Disclosure } from "@/components/ui";
import { revisionCopyText, type RevisionHistoryNote } from "@/lib/orders/revision-history";
import { exactTime } from "./card-meta";

const KIND_LABEL: Record<RevisionHistoryNote["kind"], string> = {
  qc: "QC failed",
  customer: "Customer asked for changes",
  team: "Revision requested",
};

/** What the Copy button copies, in words (hover title, screen readers). */
const KIND_WHAT: Record<RevisionHistoryNote["kind"], string> = {
  qc: "QC note",
  customer: "customer's request",
  team: "revision note",
};

/**
 * Every QC fail and revision on the order, newest first, each with when it
 * was asked, who asked and its own Copy button: a designer back on a card can
 * read what was asked before, not only the latest note.
 */
export function RevisionHistory({
  notes,
  timeZone,
  defaultOpen,
}: {
  notes: RevisionHistoryNote[];
  /** The designer's zone; staff read the app zone. */
  timeZone?: string;
  defaultOpen: boolean;
}) {
  if (notes.length === 0) return null;
  return (
    <Disclosure
      summary="QC and revision notes"
      hint={`${notes.length} · newest first`}
      defaultOpen={defaultOpen}
      className="bg-canvas/60 shadow-none"
    >
      <ol className="flex flex-col gap-2.5">
        {notes.map((n, i) => (
          <li key={n.id} className="rounded-input border border-line bg-surface p-3">
            <CopyField text={revisionCopyText(n.note, n.items)} what={KIND_WHAT[n.kind]}>
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate">
                <span className={cn("font-semibold", n.kind === "qc" ? "text-rose" : "text-pigment")}>
                  {KIND_LABEL[n.kind]}
                </span>
                {i === 0 && notes.length > 1 && (
                  <span className="rounded border border-line bg-canvas px-1.5 py-0.5 font-medium text-ink">Latest</span>
                )}
                <span>
                  {exactTime(n.at, timeZone)}
                  {n.who ? ` · ${n.who}` : ""}
                </span>
              </p>
              {n.note && (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink [overflow-wrap:anywhere]">{n.note}</p>
              )}
              {n.items.length > 0 && (
                <ul className="ml-5 mt-1 list-outside list-disc space-y-0.5 text-sm text-slate">
                  {n.items.map((item, j) => (
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              )}
              {n.pins > 0 && (
                <p className="mt-1 text-xs text-slate">
                  The customer marked {n.pins} spot{n.pins === 1 ? "" : "s"} on the proof.
                </p>
              )}
            </CopyField>
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}
