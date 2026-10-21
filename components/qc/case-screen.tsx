"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { decideCase, undoCase } from "@/app/(app)/approve/actions";
import { BottomDock } from "@/components/qc/bottom-dock";
import { useToast } from "@/components/ui";
import { ArrowRight, Check, Pencil } from "@/components/ui/icons";
import { focusRing } from "@/components/ui/styles";
import { CASE_AUTO_AFTER_H, NO_REPLY, type CaseCard, type CaseKind } from "@/lib/cases/cards";
import { cn } from "@/lib/utils";

/**
 * One customer case at a time, like the QC cards (both owners, 2026-10-21). What happened, her exact words, and what the
 * agent would do, ready to do in one tap. The agent tries to solve a case itself first: only the ones it cannot settle
 * reach this screen. A swipe records the decision and the agent does it after a 30 s undo window; a case nobody swipes
 * for 24 h is done on the agent's own pick.
 */

const KIND: Record<CaseKind, { label: string; tone: string }> = {
  legal: { label: "Etsy case / legal", tone: "bg-rose/10 text-rose" },
  refund: { label: "Money back", tone: "bg-rose/10 text-rose" },
  upset: { label: "Upset buyer", tone: "bg-amber/10 text-amber" },
  revision: { label: "Move a revision", tone: "bg-amber/10 text-amber" },
  print: { label: "Print layout", tone: "bg-pigment-soft text-pigment" },
  approve: { label: "Approve", tone: "bg-pigment-soft text-pigment" },
  late: { label: "Late order", tone: "bg-amber/10 text-amber" },
  qc: { label: "QC", tone: "bg-pigment-soft text-pigment" },
  photos: { label: "Photos", tone: "bg-pigment-soft text-pigment" },
  other: { label: "Needs you", tone: "bg-pigment-soft text-pigment" },
};

/** The same test as the agent's autoPass: never a legal case, never money going back. */
function autoEligible(c: CaseCard): boolean {
  if (c.kind === "legal") return false;
  if (c.kind === "refund" && c.suggestedActions.some((a) => /refund/i.test(a))) return false;
  return !!c.suggestedReply || c.suggestedActions.length > 0;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function autoIn(iso: string | null): string | null {
  if (!iso) return null;
  const h = Math.ceil(CASE_AUTO_AFTER_H - (Date.now() - Date.parse(iso)) / 3_600_000);
  return h <= 0 ? "soon" : `${h} h`;
}

export function caseHref(id: string | null): string {
  return id ? `/approve?s=cases&c=${encodeURIComponent(id)}` : "/approve?s=cases";
}

export function CaseScreen({ card, position, total, nextId }: { card: CaseCard; position: number; total: number; nextId: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [reply, setReply] = useState(card.suggestedReply ?? "");
  const [off, setOff] = useState<number[]>([]);
  const [elsewhere, setElsewhere] = useState(false);
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = KIND[card.kind];
  const hasPick = !!card.suggestedReply || card.suggestedActions.length > 0;
  const auto = autoEligible(card) ? autoIn(card.raisedAt) : null;
  const locked = busy || pending;

  function move() {
    startTransition(() => {
      router.replace(caseHref(nextId));
      router.refresh();
    });
  }

  async function send(input: Parameters<typeof decideCase>[0], what: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await Promise.race([
        decideCase(input),
        new Promise<never>((_, fail) => setTimeout(() => fail(new Error("timeout")), 30_000)),
      ]);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({
        variant: "success",
        title: what,
        description: "Recorded. I'll do it in a moment.",
        duration: 25_000,
        action: {
          label: "Undo",
          onClick: () => {
            void undoCase(card.id).then((u) => {
              toast(u.ok ? { variant: "info", title: "Undone, it's back in Cases" } : { variant: "warning", title: "Too late to undo", description: u.message });
              router.refresh();
            });
          },
        },
      });
      move();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/server action/i.test(msg) ? "AlphaOS was just updated. Reload the page, then tap again." : "That didn't go through. Tap again.");
    } finally {
      setBusy(false);
    }
  }

  function doMyPick() {
    const asSuggested = reply.trim() === (card.suggestedReply ?? "").trim();
    // An emptied reply box = send her nothing; an edited one goes as written; untouched = the agent's own words.
    const replyEdit = asSuggested ? "" : reply.trim() ? reply : NO_REPLY;
    void send({ id: card.id, decision: "tick", replyEdit, actionsOff: off }, "Doing my pick");
  }

  const links = card.links.filter((l) => /^https?:\/\//.test(l.url));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4" data-testid="case-screen" data-kind={card.kind}>
      <div className="flex items-center justify-between gap-3 text-sm text-slate">
        <span>
          {position} of {total} to decide
        </span>
        {nextId ? (
          <Link href={caseHref(nextId)} className={cn("inline-flex min-h-11 items-center gap-1 rounded-input px-2 font-medium text-pigment hover:bg-pigment-soft sm:min-h-0 sm:py-1", focusRing)}>
            Skip <ArrowRight size={14} />
          </Link>
        ) : null}
      </div>

      <section className="flex flex-col gap-5 rounded-card bg-surface p-4 shadow-card sm:p-5">
        {/* Who and how bad, at a glance */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-input px-3 py-1 text-base font-bold tracking-wide", kind.tone)} data-testid="case-kind">
              {kind.label.toUpperCase()}
            </span>
            {card.urgent ? <span className="rounded-input bg-rose/10 px-3 py-1 text-sm font-bold text-rose">URGENT</span> : null}
            {card.raisedAt ? (
              <span className="text-sm text-slate" suppressHydrationWarning>
                raised {ago(card.raisedAt)}
              </span>
            ) : null}
          </div>
          <h1 className="font-display text-xl font-semibold text-ink">{card.title}</h1>
          <p className="text-sm text-slate">
            {[card.shop, card.buyer, card.orderNo ? `#${card.orderNo}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>

        {card.failedNote ? (
          <p role="alert" className="rounded-card border border-rose bg-surface px-3 py-2 text-sm text-rose">
            Last time it did not go through: {card.failedNote} Tap again to retry.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* What is going on */}
          <div className="flex min-w-0 flex-col gap-4">
            {card.herWords ? (
              <div className="flex flex-col gap-1.5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate">What she wrote</h2>
                <blockquote className="whitespace-pre-wrap break-words rounded-card border-l-4 border-rose bg-canvas px-4 py-3 text-base text-ink" data-testid="her-words">
                  {card.herWords}
                </blockquote>
              </div>
            ) : null}
            {card.situation ? (
              <div className="flex flex-col gap-1.5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate">What happened</h2>
                <p className="whitespace-pre-wrap break-words text-base text-ink">{card.situation}</p>
              </div>
            ) : null}
            {card.whatIDid ? (
              <div className="flex flex-col gap-1.5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate">What I already did</h2>
                <p className="whitespace-pre-wrap break-words text-base text-ink">{card.whatIDid}</p>
              </div>
            ) : null}
            {card.why ? (
              <div className="flex flex-col gap-1.5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate">Why it is yours</h2>
                <p className="whitespace-pre-wrap break-words text-base text-ink">{card.why}</p>
              </div>
            ) : null}
            {links.length ? (
              <div className="flex flex-wrap gap-3">
                {links.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className={cn("rounded-input text-sm font-medium text-pigment underline-offset-2 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center", focusRing)}>
                    {l.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>

          {/* What I would do */}
          <div className="flex min-w-0 flex-col gap-4 rounded-card border border-line p-3 sm:p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-sage">What I would do</h2>
            {!hasPick ? (
              <p className="text-base text-slate" data-testid="no-pick">
                I don&apos;t have a pick for this one yet. Tell me what to do, or mark it already sorted.
              </p>
            ) : null}
            {card.suggestedActions.length ? (
              <ul className="flex flex-col gap-1" data-testid="pick-actions">
                {card.suggestedActions.map((a, i) => {
                  const on = !off.includes(i);
                  return (
                    <li key={i}>
                      <label className={cn("flex min-h-11 cursor-pointer items-start gap-3 rounded-input px-2 py-2 hover:bg-canvas", !on && "opacity-60")}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={locked}
                          onChange={() => setOff((o) => (on ? [...o, i] : o.filter((x) => x !== i)))}
                          className="mt-1 size-5 shrink-0 accent-sage"
                        />
                        <span className={cn("min-w-0 break-words text-base text-ink", !on && "line-through")}>{a}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {card.suggestedReply ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="case-reply" className="text-sm font-semibold text-ink">
                  I would reply
                </label>
                <textarea
                  id="case-reply"
                  value={reply}
                  disabled={locked}
                  onChange={(e) => setReply(e.target.value)}
                  rows={6}
                  placeholder="Leave empty to send her nothing"
                  className={cn("w-full rounded-input border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-slate", focusRing)}
                />
                {reply.trim() === "" ? <p className="text-sm text-amber">She will get no reply.</p> : null}
              </div>
            ) : null}
            {auto ? (
              <p className="text-sm text-slate" data-testid="auto-note" suppressHydrationWarning>
                If nobody decides, I do this in {auto}.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <BottomDock>
        {error ? (
          <p role="alert" className="rounded-input bg-rose/10 px-3 py-2 text-sm text-rose">
            {error}
          </p>
        ) : null}
        {elsewhere ? (
          <div className="flex flex-col gap-3" data-testid="own-panel">
            <label htmlFor="case-own" className="text-sm font-semibold text-ink">
              What should I do?
            </label>
            <textarea
              id="case-own"
              value={own}
              autoFocus
              onChange={(e) => setOwn(e.target.value)}
              rows={3}
              placeholder="e.g. Offer a full redraw by Jerome, no refund yet"
              className={cn("w-full rounded-input border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-slate", focusRing)}
            />
            <div className="grid grid-cols-2 gap-3">
              <button type="button" disabled={locked} onClick={() => setElsewhere(false)} className={cn("h-12 rounded-input border border-line text-base font-medium text-ink disabled:opacity-50", focusRing)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={locked || !own.trim()}
                onClick={() => void send({ id: card.id, decision: "own", ownerText: own.trim() }, "Doing it your way")}
                data-testid="case-own-send"
                className={cn("h-12 rounded-input bg-pigment px-3 text-base font-semibold text-surface disabled:opacity-60", focusRing)}
              >
                Do this
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {hasPick ? (
              <button
                type="button"
                disabled={locked}
                onClick={doMyPick}
                data-testid="case-pick"
                className={cn("col-span-2 inline-flex h-14 items-center justify-center gap-2 rounded-input bg-sage text-lg font-semibold text-surface disabled:opacity-60", focusRing)}
              >
                <Check size={20} /> {busy ? "Recording..." : "Do my pick"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={locked}
              onClick={() => void send({ id: card.id, decision: "sorted" }, "Marked as sorted")}
              data-testid="case-sorted"
              className={cn("inline-flex h-12 items-center justify-center rounded-input border-2 border-line text-base font-semibold text-ink disabled:opacity-50", focusRing)}
            >
              Already sorted
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setElsewhere(true);
                setError(null);
              }}
              data-testid="case-else"
              className={cn("inline-flex h-12 items-center justify-center gap-2 rounded-input border-2 border-pigment text-base font-semibold text-pigment disabled:opacity-50", focusRing)}
            >
              <Pencil size={18} /> Do it my way
            </button>
          </div>
        )}
      </BottomDock>
    </div>
  );
}
