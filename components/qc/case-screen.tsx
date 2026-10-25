"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { StreamTabs } from "@/components/qc/approve-streams";
import { BottomDock } from "@/components/qc/bottom-dock";
import { EmptyState, Page, useToast } from "@/components/ui";
import { ArrowRight, Check, CheckCircle, Pencil } from "@/components/ui/icons";
import { focusRing } from "@/components/ui/styles";
import { CASE_AUTO_AFTER_H, NO_REPLY, type CaseCard, type CaseKind, type CaseWrite } from "@/lib/cases/cards";
import { cn } from "@/lib/utils";

/**
 * One customer case at a time, like the QC cards (both owners, 2026-10-21). What happened, her exact words, and what the
 * agent would do, ready to do in one tap. The agent tries to solve a case itself first: only the ones it cannot settle
 * reach this screen. A swipe records the decision and the agent does it after a 30 s undo window; a case nobody swipes
 * for 24 h is done on the agent's own pick.
 *
 * Since 2026-10-25 ("when you click something it waits then goes to the next one ... it should be faster") the whole
 * pile lives on the screen (CaseDeck): a tap shows the next case at once and the swipe is recorded in the background
 * (POST /api/approve/cases). One that does not go through comes back into the pile with a note; Undo puts it back on
 * screen. The list refreshes itself every minute without moving the case being read.
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

export type CaseChoice =
  | { decision: "tick"; replyEdit: string; actionsOff: number[] }
  | { decision: "own"; ownerText: string }
  | { decision: "sorted" };

/**
 * Swipes made in this tab: case id -> when the agent recorded it (Infinity while it is on its way). Module-wide, so a copy
 * of the page from the router cache (up to 3 min old) or a list read before the swipe landed never shows it again.
 */
const decided = new Map<string, number>();
/** The server's clock and the phone's can differ by a few seconds. */
const CLOCK_SLACK_MS = 10_000;
const REFRESH_MS = 60_000;
/** A second tap this soon after the next case appeared was meant for the last one (a double tap): never decide unseen. */
const DOUBLE_TAP_MS = 450;

/** The cards still to decide, from a list read at `at`. */
function undecided(list: CaseCard[], at: number): CaseCard[] {
  return list.filter((c) => {
    const t = decided.get(c.id);
    return t === undefined || at > t + CLOCK_SLACK_MS;
  });
}

async function call(body: Record<string, unknown>): Promise<CaseWrite> {
  try {
    const res = await fetch("/api/approve/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return ((await res.json().catch(() => null)) as CaseWrite | null) ?? { ok: false, message: "That didn't go through." };
  } catch {
    return { ok: false, message: "That didn't go through (connection dropped)." };
  }
}

const why = (m: string) => (/didn't go through/i.test(m) ? "the connection dropped." : /[.!?]$/.test(m.trim()) ? m.trim() : `${m.trim()}.`);

export function CaseDeck({
  cards: initial,
  at,
  startId,
  counts,
}: {
  cards: CaseCard[];
  /** When the server read `cards` (ms). */
  at: number;
  startId: string | null;
  counts: { new: number; revision: number };
}) {
  const toast = useToast();
  const [cards, setCards] = useState(() => undecided(initial, at));
  const [currentId, setCurrentId] = useState<string | null>(() => {
    const list = undecided(initial, at);
    return (list.find((c) => c.id === startId) ?? list[0])?.id ?? null;
  });
  const listAt = useRef(at);
  const shownId = useRef<string | null>(null);
  const movedAt = useRef(0);
  const lastRead = useRef(Date.now());

  const index = Math.max(0, cards.findIndex((c) => c.id === currentId));
  const current = cards[index] ?? null;
  useEffect(() => {
    shownId.current = current?.id ?? null;
  });

  const show = useCallback((id: string | null) => {
    setCurrentId(id);
    movedAt.current = Date.now();
    window.history.replaceState(null, "", caseHref(id));
    window.scrollTo({ top: 0 });
  }, []);

  /** A newer list in: new cases join, settled ones leave, the case on screen stays put. */
  const merge = useCallback((list: CaseCard[], when: number) => {
    if (when < listAt.current) return;
    listAt.current = when;
    setCards((prev) => {
      const next = undecided(list, when).map((c) => {
        const mine = prev.find((p) => p.id === c.id);
        return mine?.failedNote && !c.failedNote ? { ...c, failedNote: mine.failedNote } : c;
      });
      const id = shownId.current;
      const pos = prev.findIndex((p) => p.id === id);
      // Settled elsewhere while being read: it stays until they move on (a tap on it then says so).
      if (id && pos >= 0 && !decided.has(id) && !next.some((c) => c.id === id)) next.splice(Math.min(pos, next.length), 0, prev[pos]);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const started = Date.now();
    lastRead.current = started;
    try {
      const res = await fetch("/api/approve/cases", { cache: "no-store" });
      const j = (await res.json()) as { ok?: boolean; cards?: CaseCard[] };
      if (j.ok && Array.isArray(j.cards)) merge(j.cards, started);
    } catch {
      // The next tick tries again; the pile on screen is still right.
    }
  }, [merge]);

  // A new list from the server (the tab tapped again, a link to one case): merge it, and open the case it names.
  useEffect(() => {
    merge(initial, at);
  }, [initial, at, merge]);
  useEffect(() => {
    if (startId) setCurrentId(startId);
  }, [startId]);

  useEffect(() => {
    if (Date.now() - at > 15_000) void refresh(); // a copy from the router cache
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const back = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRead.current > 20_000) void refresh();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", back);
    };
  }, [at, refresh]);

  /** Back into the pile where it was. */
  function put(card: CaseCard, pos: number, failedNote: string | null) {
    setCards((prev) => (prev.some((c) => c.id === card.id) ? prev : [...prev.slice(0, pos), { ...card, failedNote }, ...prev.slice(pos)]));
  }

  function decide(card: CaseCard, choice: CaseChoice, what: string) {
    if (Date.now() - movedAt.current < DOUBLE_TAP_MS) return;
    const pos = Math.max(0, cards.findIndex((c) => c.id === card.id));
    const rest = cards.filter((c) => c.id !== card.id);
    decided.set(card.id, Infinity);
    setCards(rest);
    show(rest.length ? rest[pos % rest.length].id : null);

    const said: { unsay?: () => void } = {}; // the "I'll do it" toast, taken back if it did not go in
    const sent = call({ op: "decide", id: card.id, ...choice }).then((res) => {
      if (res.ok) {
        decided.set(card.id, Date.now());
        return true;
      }
      said.unsay?.();
      if (res.conflict) {
        decided.set(card.id, Date.now());
        toast({ variant: "info", title: "Already decided", description: `${card.title}: it was settled on another screen.` });
        return false;
      }
      decided.delete(card.id);
      put(card, pos, why(res.message));
      toast({
        variant: "warning",
        title: "That one didn't go through",
        description: `${card.title}. It's back in Cases.`,
        duration: 15_000,
        action: { label: "Open", onClick: () => show(card.id) },
      });
      return false;
    });

    said.unsay = toast({
      variant: "success",
      title: what,
      description: "I'll do it in a moment.",
      duration: 25_000,
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            if (!(await sent)) return; // it never went in (a failed one is already back in the pile)
            const u = await call({ op: "undo", id: card.id });
            if (!u.ok) {
              toast({ variant: "warning", title: "Too late to undo", description: u.message });
              return;
            }
            decided.delete(card.id);
            put(card, pos, null);
            show(card.id);
            toast({ variant: "info", title: "Undone, it's back in Cases" });
          })();
        },
      },
    });
  }

  const tabs = <StreamTabs active="cases" counts={{ ...counts, cases: cards.length }} casesUrgent={cards.some((x) => x.urgent)} />;
  if (!current) {
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <Page className="max-w-xl">
          <EmptyState icon={CheckCircle} headline="No cases" body="Nothing needs you. I settle customer problems myself and bring you only the ones I can't." />
        </Page>
      </div>
    );
  }
  const next = cards.length > 1 ? cards[(index + 1) % cards.length].id : null;
  return (
    <div className="flex flex-col gap-4">
      {tabs}
      <CaseScreen
        key={current.id}
        card={current}
        position={index + 1}
        total={cards.length}
        onSkip={next ? () => show(next) : null}
        onDecide={(choice, what) => decide(current, choice, what)}
      />
    </div>
  );
}

function CaseScreen({
  card,
  position,
  total,
  onSkip,
  onDecide,
}: {
  card: CaseCard;
  position: number;
  total: number;
  onSkip: (() => void) | null;
  onDecide: (choice: CaseChoice, what: string) => void;
}) {
  const [reply, setReply] = useState(card.suggestedReply ?? "");
  const [off, setOff] = useState<number[]>([]);
  const [elsewhere, setElsewhere] = useState(false);
  const [own, setOwn] = useState("");

  const kind = KIND[card.kind];
  const hasPick = !!card.suggestedReply || card.suggestedActions.length > 0;
  const auto = autoEligible(card) ? autoIn(card.raisedAt) : null;

  function doMyPick() {
    const asSuggested = reply.trim() === (card.suggestedReply ?? "").trim();
    // An emptied reply box = send her nothing; an edited one goes as written; untouched = the agent's own words.
    const replyEdit = asSuggested ? "" : reply.trim() ? reply : NO_REPLY;
    onDecide({ decision: "tick", replyEdit, actionsOff: off }, "Doing my pick");
  }

  const links = card.links.filter((l) => /^https?:\/\//.test(l.url));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4" data-testid="case-screen" data-kind={card.kind}>
      <div className="flex items-center justify-between gap-3 text-sm text-slate">
        <span>
          {position} of {total} to decide
        </span>
        {onSkip ? (
          <button type="button" onClick={onSkip} data-testid="case-skip" className={cn("inline-flex min-h-11 items-center gap-1 rounded-input px-2 font-medium text-pigment hover:bg-pigment-soft sm:min-h-0 sm:py-1", focusRing)}>
            Skip <ArrowRight size={14} />
          </button>
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
              <button type="button" onClick={() => setElsewhere(false)} className={cn("h-12 rounded-input border border-line text-base font-medium text-ink disabled:opacity-50", focusRing)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={!own.trim()}
                onClick={() => onDecide({ decision: "own", ownerText: own.trim() }, "Doing it your way")}
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
                onClick={doMyPick}
                data-testid="case-pick"
                className={cn("col-span-2 inline-flex h-14 items-center justify-center gap-2 rounded-input bg-sage text-lg font-semibold text-surface disabled:opacity-60", focusRing)}
              >
                <Check size={20} /> Do my pick
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onDecide({ decision: "sorted" }, "Marked as sorted")}
              data-testid="case-sorted"
              className={cn("inline-flex h-12 items-center justify-center rounded-input border-2 border-line text-base font-semibold text-ink disabled:opacity-50", focusRing)}
            >
              Already sorted
            </button>
            <button
              type="button"
              onClick={() => setElsewhere(true)}
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
