"use client";

/* eslint-disable @next/next/no-img-element -- order photos and artwork are signed R2/CDN urls of any size */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { ownerReject } from "@/app/(app)/approve/actions";
import { releaseClaim, useApproveClaim } from "@/components/qc/approve-claim";
import { QcPicturePicker, useQcPictures } from "@/components/qc/attachment-picker";
import {
  approvalStore,
  approveHref,
  FULL_PREFETCH,
  PendingApprovalsHost,
  PendingApprovalsInline,
  usePendingApprovals,
} from "@/components/qc/pending-approvals";
import { AutoQcBadge, AutoQcNotes } from "@/components/qc/auto-qc";
import { BottomDock } from "@/components/qc/bottom-dock";
import { AiFixPanel } from "@/components/qc/auto-qc-fix";
import { useToast } from "@/components/ui";
import { ArrowRight, Check, Sparkles, X } from "@/components/ui/icons";
import { focusRing } from "@/components/ui/styles";
import { portraitList } from "@/lib/orders/portrait-list";
import type { ApproveItem } from "@/lib/qc/approve-data";
import { splitChecklistLabel } from "@/lib/qc/checklist";
import { cn } from "@/lib/utils";

type Props = {
  item: ApproveItem;
  position: number;
  total: number;
  nextId: string | null;
  /** Who else is checking right now (their orders are not in this queue). */
  others: { name: string; count: number }[];
  /** Set when ?o= asked for an order someone else has open. */
  takenBy: string | null;
};

function dueText(iso: string | null): { text: string; late: boolean } | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  const h = Math.round(Math.abs(ms) / 3_600_000);
  const span = h >= 48 ? `${Math.round(h / 24)} days` : h <= 1 ? "1 hour" : `${h} hours`;
  return ms < 0 ? { text: `${span} late`, late: true } : { text: `due in ${span}`, late: false };
}

function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function ApproveScreen({ item, position, total, nextId, others, takenBy }: Props) {
  const { ctx } = item;
  const router = useRouter();
  const toast = useToast();
  // Two owners (2026-10-14): this order is mine while it is on screen.
  useApproveClaim(ctx.orderId, ctx.orderNumber);
  // An AI portrait waits for its Auto QC before Approve opens (lib/qc/ai-qc-gate.ts): look again every 30 s.
  useEffect(() => {
    if (!item.aiWaiting) return;
    const t = window.setInterval(() => router.refresh(), 30_000);
    return () => window.clearInterval(t);
  }, [item.aiWaiting, router]);
  useEffect(() => {
    if (takenBy) toast({ variant: "info", title: `${takenBy} is checking that one`, description: "Here is the next one." });
  }, [takenBy, toast]);
  usePendingApprovals(); // re-render when the skip list changes (Skip link)
  // The page Approve moves to (this order skipped), preloaded so the swap is instant.
  const afterApprove = approveHref(nextId, undefined, ctx.orderId);
  useEffect(() => {
    router.prefetch(afterApprove, FULL_PREFETCH);
    // Where Stop lands: this same order, pinned. Warm before Approve is tapped.
    router.prefetch(approveHref(ctx.orderId, ctx.orderId), FULL_PREFETCH);
  }, [afterApprove, ctx.orderId, router]);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"reject" | "missing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  // A note typed before an app update reload comes back, panel open (see callAction).
  useEffect(() => {
    const key = `approve-note:${ctx.orderId}`;
    const kept = window.sessionStorage.getItem(key);
    if (!kept) return;
    window.sessionStorage.removeItem(key);
    setNote(kept);
    setRejecting(true);
  }, [ctx.orderId]);
  const [picked, setPicked] = useState<number[]>([]);
  const pictures = useQcPictures(ctx.orderId);
  // Which artwork the viewer shows: the new version, the one before it (revisions) or the AI fix (2026-10-14).
  const [view, setView] = useState<"new" | "before" | "fix">("new");
  const [attachFix, setAttachFix] = useState(false);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);

  const allVersions = ctx.versions.filter((v) => v.url);
  // 2+ portrait orders whose designer tagged each upload: the owner checks
  // every portrait in turn, each with its own new/before (Jerome, 2026-10-14).
  const portraitGroups =
    ctx.portraits.length >= 2 && allVersions.some((v) => v.portrait)
      ? [
          ...ctx.portraits.map((p) => ({
            n: p.n,
            title: `Portrait ${p.n}`,
            label: p.label,
            versions: allVersions.filter((v) => v.portrait === p.n),
          })),
          ...(allVersions.some((v) => !v.portrait)
            ? [{ n: 0, title: "Untagged", label: "", versions: allVersions.filter((v) => !v.portrait) }]
            : []),
        ]
      : null;
  const [portraitN, setPortraitN] = useState(portraitGroups?.[0]?.n ?? 0);
  const group = portraitGroups ? (portraitGroups.find((g) => g.n === portraitN) ?? portraitGroups[0]) : null;
  const versions = group ? group.versions : allVersions;
  const latest = versions[versions.length - 1] ?? null;
  const before = item.isRevision && versions.length > 1 ? versions[versions.length - 2] : null;
  // The AI fix painted on this portrait's newest version, if there is one (one-portrait orders: the only fix).
  const fix = item.fixes.find((f) => (group ? (f.portrait ?? 0) === group.n : true) && f.sourceAssetId === latest?.id) ?? null;
  const shown = view === "fix" && fix?.url ? { url: fix.url } : view === "before" && before ? before : latest;
  const fixIds = item.fixes.map((f) => f.id);
  const due = dueText(ctx.dueAt);
  const photos = ctx.references.filter((r) => r.url);
  // A portrait with no file yet (order 4199589633, 2026-10-14): the order cannot
  // go to the customer (the server refuses it too), so Approve gives way to a
  // one-tap send back that tells the designer which portrait is missing.
  const missing = ctx.proofFiles.mode === "slots" ? ctx.proofFiles.missing.map((m) => m.n) : [];
  const missingWho = missing.length ? portraitList(missing) : "";
  const missingNote = missing.length
    ? `${missingWho} of ${ctx.proofFiles.expected} ${missing.length > 1 ? "are" : "is"} missing. This order is ${ctx.proofFiles.expected} separate portraits, so please add ${missing.length > 1 ? "them" : "it"} and submit again.`
    : "";

  useEffect(() => {
    if (!enlarged) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setEnlarged(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlarged]);

  // fresh: false only after Approve, whose target URL is new and was fully
  // prefetched above; a refresh there purged that prefetch and held this
  // order on screen for ~6 s while the server re-rendered.
  function goNext(fresh = true) {
    startTransition(() => {
      router.replace(approveHref(nextId));
      if (fresh) router.refresh();
    });
  }

  // Yousif 2026-10-14: a dropped connection or an app update mid-session left
  // "Sending back..." spinning forever with nothing sent. Every call now ends:
  // a thrown error or a 30 s stall frees the button with a reason, and a retry
  // is safe because the server answers "Already checked" when the first landed.
  async function callAction<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, fail) => setTimeout(() => fail(new Error("timeout")), 30_000)),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/server action/i.test(msg)) {
        // The page is older than the live app: reload onto this order, note kept.
        if (note.trim()) window.sessionStorage.setItem(`approve-note:${ctx.orderId}`, note);
        setError("AlphaOS was just updated, reloading. Tap again once it opens.");
        window.location.assign(`/approve?o=${ctx.orderId}`);
        return null;
      }
      setError(
        msg === "timeout"
          ? "No answer after 30 seconds, it may not have gone through. Check your connection and tap again."
          : "That didn't go through (connection dropped). Tap again.",
      );
      return null;
    } finally {
      setBusy(null);
    }
  }

  // Yousif 2026-10-14: no "Sending..." wait. The approval is queued with a short
  // Stop window (components/qc/pending-approvals.tsx) and the screen moves on.
  function approve() {
    setError(null);
    approvalStore.enqueue({ orderId: ctx.orderId, orderNumber: ctx.orderNumber, customerName: ctx.customerName });
    goNext(false);
  }

  // "Send AI fix" (Yousif 2026-10-14): the same Stop window, with the fixes the
  // server turns into the newest versions before the proof goes out.
  function approveFix() {
    setError(null);
    approvalStore.enqueue({ orderId: ctx.orderId, orderNumber: ctx.orderNumber, customerName: ctx.customerName, fixIds });
    goNext(false);
  }

  async function reject() {
    if (!note.trim()) {
      setError("Write what needs fixing first.");
      return;
    }
    if (pictures.busy || pictures.failedCount > 0) {
      setError(pictures.busy ? "Wait for the pictures to finish uploading." : "Retry or remove the picture that did not upload.");
      return;
    }
    await sendBack("reject", {
      note,
      failedKeys: picked,
      attachmentAssetIds: pictures.assetIds,
      attachFixIds: attachFix ? fixIds : [],
    });
  }

  // One tap: the missing portrait note goes back as is (it marks the Count check).
  function sendBackMissing() {
    void sendBack("missing", { note: missingNote, failedKeys: [] });
  }

  async function sendBack(kind: "reject" | "missing", input: Omit<Parameters<typeof ownerReject>[0], "orderId">) {
    setBusy(kind);
    setError(null);
    const res = await callAction(() => ownerReject({ orderId: ctx.orderId, ...input }));
    if (!res) return;
    if (!res.ok) {
      if (res.code === "stale" || res.code === "claimed") {
        toast(
          res.code === "claimed"
            ? { variant: "warning", title: res.message, description: "Your note was not sent." }
            : { variant: "warning", title: "Already checked", description: res.message },
        );
        goNext();
        return;
      }
      setError(res.message);
      return;
    }
    toast({ variant: "success", title: res.title, description: res.description });
    goNext();
  }

  const locked = busy !== null || pending;
  const says = ctx.orderSays;
  const rejectButton = (
    <button
      type="button"
      disabled={locked}
      onClick={() => {
        setRejecting(true);
        setError(null);
        // The missing portrait goes in the note too; the owner adds the rest.
        if (missingNote) setNote((n) => n || missingNote);
      }}
      data-testid="reject"
      className={cn("inline-flex h-14 items-center justify-center gap-2 rounded-input border-2 border-rose text-lg font-semibold text-rose disabled:opacity-50", focusRing)}
    >
      <X size={20} /> Reject
    </button>
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4" data-testid="approve-screen" data-kind={item.isRevision ? "revision" : "new"}>
      <PendingApprovalsHost />
      {/* Where am I in the pile */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h1 className="font-display text-xl font-semibold text-ink">Approve</h1>
          {others.length ? (
            <p className="text-xs text-slate" data-testid="others-checking">
              {others.map((x) => `${x.name} is checking ${x.count}`).join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-1 text-sm text-slate">
          <span>
            {position} of {total} to check
          </span>
          {nextId ? (
            <Link
              href={approveHref(nextId)}
              onClick={() => releaseClaim(ctx.orderId)}
              className={cn("ml-1 inline-flex min-h-11 items-center gap-1 rounded-input px-2 font-medium text-pigment hover:bg-pigment-soft sm:min-h-0 sm:py-1", focusRing)}
            >
              Skip <ArrowRight size={14} />
            </Link>
          ) : null}
        </div>
      </div>

      <section className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card sm:p-5">
        {/* What this is, at a glance */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {item.isRevision ? (
              <span className="rounded-input bg-amber/10 px-3 py-1 text-base font-bold tracking-wide text-amber" data-testid="kind-label">
                REVISION{item.round > 1 ? ` ${item.round}` : ""}
              </span>
            ) : (
              <span className="rounded-input bg-pigment-soft px-3 py-1 text-base font-bold tracking-wide text-pigment" data-testid="kind-label">
                NEW ORDER
              </span>
            )}
            {item.urgent ? (
              <span className="rounded-input bg-rose/10 px-3 py-1 text-sm font-bold text-rose" title={item.urgentReason ?? undefined}>
                URGENT
              </span>
            ) : null}
            {due ? (
              <span className={cn("text-sm font-medium", due.late ? "text-rose" : "text-slate")} suppressHydrationWarning>
                {due.text}
              </span>
            ) : null}
            <AutoQcBadge view={item.autoQc} />
          </div>
          <p className="text-sm text-slate">
            <span className="font-medium text-ink">{ctx.orderNumber}</span>
            {item.shopName ? ` · ${item.shopName}` : ""}
            {/\p{L}/u.test(ctx.customerName) ? ` · ${ctx.customerName}` : ""}
            {ctx.designerName ? ` · by ${ctx.designerName}` : ""}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* The artwork */}
          <div className="flex min-w-0 flex-col gap-2">
            {missing.length ? (
              <div role="alert" data-testid="portrait-missing" className="rounded-card border border-rose bg-surface px-3 py-2 text-sm text-ink">
                <p className="font-semibold text-rose">
                  {missingWho} of {ctx.proofFiles.expected} {missing.length > 1 ? "have" : "has"} no file yet.
                </p>
                <p className="text-slate">
                  The customer only gets this order with every portrait. Send it back so the designer adds{" "}
                  {missing.length > 1 ? "them" : "it"}.
                </p>
              </div>
            ) : null}
            {/* Files matched to portraits by upload order, or left out (lib/proofs/files.ts). */}
            {ctx.proofFiles.mode === "slots"
              ? ctx.proofFiles.warnings.map((w) => (
                  <p key={w} className="text-sm text-amber" data-testid="portrait-warning">
                    {w}
                  </p>
                ))
              : null}
            {portraitGroups ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm text-slate">
                  This order has {ctx.portraits.length} portraits. Check each one.
                </p>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Which portrait">
                  {portraitGroups.map((g) => (
                    <button
                      key={g.n}
                      type="button"
                      onClick={() => {
                        setPortraitN(g.n);
                        setView("new");
                      }}
                      aria-pressed={group?.n === g.n}
                      title={g.label || undefined}
                      className={cn(
                        "flex min-h-11 max-w-full items-center rounded-input border px-3 text-sm sm:min-h-9",
                        focusRing,
                        group?.n === g.n
                          ? "border-pigment bg-pigment-soft font-medium text-ink"
                          : "border-line bg-surface text-slate hover:text-ink",
                      )}
                    >
                      <span className="min-w-0 truncate">
                        {g.title}
                        {g.label ? ` · ${g.label}` : ""}
                        {g.versions.length ? "" : " (none yet)"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {before || fix ? (
              <div className="flex gap-1 self-start rounded-input bg-canvas p-1" role="group" aria-label="Which version">
                {[
                  { k: "new" as const, label: before ? "New version" : "Designer's" },
                  ...(before ? [{ k: "before" as const, label: "Before" }] : []),
                  ...(fix ? [{ k: "fix" as const, label: "AI fix" }] : []),
                ].map((b) => (
                  <button
                    key={b.k}
                    type="button"
                    onClick={() => setView(b.k)}
                    aria-pressed={view === b.k}
                    className={cn(
                      "inline-flex min-h-11 items-center gap-1 rounded-input px-3 text-sm font-medium sm:min-h-9",
                      focusRing,
                      view === b.k ? "bg-surface text-ink shadow-card" : "text-slate",
                      b.k === "fix" && view !== b.k && "text-pigment",
                    )}
                  >
                    {b.k === "fix" ? <Sparkles size={14} /> : null}
                    {b.label}
                  </button>
                ))}
              </div>
            ) : null}
            {shown?.url && broken === shown.url ? (
              <div className="flex h-64 flex-col items-center justify-center gap-1 rounded-card bg-canvas p-4 text-center text-sm text-slate">
                The artwork did not load.
                <Link href={`/orders/${ctx.orderId}`} className="font-medium text-pigment underline-offset-2 hover:underline">
                  Open full order
                </Link>
              </div>
            ) : shown?.url ? (
              <button
                type="button"
                onClick={() => setEnlarged(shown.url)}
                className={cn("flex items-center justify-center overflow-hidden rounded-card bg-canvas", focusRing)}
                aria-label="Open the artwork full size"
              >
                <img src={shown.url} alt={`Artwork for ${ctx.orderNumber}`} onError={() => setBroken(shown.url)} className="max-h-[60vh] w-full object-contain lg:max-h-[70vh]" />
              </button>
            ) : (
              <div className="flex h-64 items-center justify-center rounded-card bg-canvas text-sm text-slate">No artwork uploaded yet</div>
            )}
            {view === "fix" && fix ? (
              <p className="text-sm text-pigment">AI fix, a suggestion: only the spots listed beside it changed.</p>
            ) : null}
          </div>

          {/* What to judge it against */}
          <div className={cn("flex min-w-0 flex-col gap-4", item.isRevision && "order-first lg:order-none")}>
            {item.isRevision ? (
              <div className="flex flex-col gap-2" data-testid="change-requests">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-amber">What they asked for</h2>
                {item.requests.length === 0 ? (
                  <p className="rounded-card border border-line p-3 text-base text-ink">
                    {says.notes ?? "No notes were written for this revision."}
                  </p>
                ) : (
                  item.requests.map((r, i) => (
                    <div key={r.id} className={cn("flex flex-col gap-1 rounded-card border p-3", i === 0 ? "border-amber/40 bg-amber/5" : "border-line")}>
                      {/* Local time differs between the server and the phone: the
                          browser's own value wins without a hydration error. */}
                      <p className="text-xs text-slate" suppressHydrationWarning>
                        {r.kind === "customer" ? "Customer" : r.kind === "qc" ? `QC${r.who ? `, ${r.who}` : ""}` : (r.who ?? "Team")} · {whenText(r.at)}
                        {i === 0 ? " · latest" : ""}
                      </p>
                      {r.note ? <p className="whitespace-pre-wrap break-words text-base text-ink">{r.note}</p> : null}
                      {r.items.length ? (
                        <ul className="list-disc pl-5 text-sm text-ink">
                          {r.items.map((t) => (
                            <li key={t}>{splitChecklistLabel(t).name}</li>
                          ))}
                        </ul>
                      ) : null}
                      {r.pins ? <p className="text-sm text-slate">{r.pins} spot{r.pins > 1 ? "s" : ""} marked on the proof</p> : null}
                    </div>
                  ))
                )}
              </div>
            ) : null}

            <AutoQcNotes view={item.autoQc} />

            <AiFixPanel
              fixes={item.fixes}
              beforeUrl={(id) => allVersions.find((v) => v.id === id)?.url ?? null}
              onShow={fix?.url ? () => setView("fix") : undefined}
            />

            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate">
                Customer photo{photos.length === 1 ? "" : "s"} {photos.length > 1 ? `(${photos.length})` : ""}
              </h2>
              {photos.length === 0 ? (
                <p className="text-sm text-slate">No photos on this order.</p>
              ) : (
                <div className={cn("grid gap-2", item.isRevision ? "grid-cols-4" : "grid-cols-3")}>
                  {photos.map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setEnlarged(p.url)}
                      className={cn("aspect-square overflow-hidden rounded-input bg-canvas", focusRing)}
                      aria-label={`Customer photo ${i + 1}, open full size`}
                    >
                      <img src={p.url!} alt="" className="size-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!item.isRevision ? (
              <dl className="flex flex-col gap-2 text-sm" data-testid="order-info">
                {says.items.map((it, i) => (
                  <div key={i} className="flex flex-col">
                    <dt className="text-xs text-slate">Ordered</dt>
                    <dd className="break-words text-ink">
                      <span className="font-medium">{it.title ?? it.productType}</span>
                      {it.options.length ? <span className="text-slate"> · {it.options.map((o) => `${o.name}: ${o.value}`).join(" · ")}</span> : null}
                    </dd>
                  </div>
                ))}
                <div className="flex gap-6">
                  <div className="flex flex-col">
                    <dt className="text-xs text-slate">People / pets</dt>
                    <dd className="text-ink">{ctx.figuresResolved || ctx.figureCount ? ctx.figureCount : "Not set"}</dd>
                  </div>
                  {ctx.style ? (
                    <div className="flex min-w-0 flex-col">
                      <dt className="text-xs text-slate">Style</dt>
                      <dd className="break-words text-ink">{ctx.style}</dd>
                    </div>
                  ) : null}
                </div>
                {says.personalization ? (
                  <div className="flex flex-col">
                    <dt className="text-xs text-slate">Personalization</dt>
                    <dd className="whitespace-pre-wrap break-words text-base text-ink">{says.personalization}</dd>
                  </div>
                ) : null}
                {says.buyerNote ? (
                  <div className="flex flex-col">
                    <dt className="text-xs text-slate">Buyer note</dt>
                    <dd className="whitespace-pre-wrap break-words text-base text-ink">{says.buyerNote}</dd>
                  </div>
                ) : null}
                {says.notes ? (
                  <div className="flex flex-col">
                    <dt className="text-xs text-slate">Order notes</dt>
                    <dd className="whitespace-pre-wrap break-words text-ink">{says.notes}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}

            <Link href={`/orders/${ctx.orderId}`} className={cn("self-start rounded-input text-sm font-medium text-pigment underline-offset-2 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center", focusRing)}>
              Open full order
            </Link>
          </div>
        </div>
      </section>

      {/* The two buttons, on the very bottom edge of the screen */}
      <BottomDock>
        <PendingApprovalsInline />
        {item.aiWaiting && !rejecting ? (
          <p className="rounded-input bg-canvas px-3 py-2 text-sm text-slate" data-testid="ai-auto-qc-waiting">
            Auto QC is still checking this AI portrait. Approve opens once it&apos;s done, usually within 10 minutes.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-input bg-rose/10 px-3 py-2 text-sm text-rose">
            {error}
          </p>
        ) : null}
        {rejecting ? (
          <div className="flex flex-col gap-3" data-testid="reject-panel">
            <label htmlFor="touchups" className="text-sm font-semibold text-ink">
              What needs fixing?
            </label>
            <textarea
              id="touchups"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. Make her hair darker and add the necklace from photo 2"
              className={cn("w-full rounded-input border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-slate", focusRing)}
            />
            <div className="flex flex-wrap gap-2" role="group" aria-label="What is wrong (optional)">
              {ctx.checklist.items.map((it) => {
                const on = picked.includes(it.key);
                return (
                  <button
                    key={it.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPicked((p) => (on ? p.filter((k) => k !== it.key) : [...p, it.key]))}
                    className={cn(
                      "min-h-11 rounded-input border px-3 text-sm font-medium sm:min-h-9",
                      focusRing,
                      on ? "border-rose bg-rose/10 text-rose" : "border-line text-slate",
                    )}
                  >
                    {splitChecklistLabel(it.label).name}
                  </button>
                );
              })}
            </div>
            <QcPicturePicker state={pictures} disabled={locked} />
            {fixIds.length ? (
              <button
                type="button"
                aria-pressed={attachFix}
                disabled={locked}
                onClick={() => setAttachFix((v) => !v)}
                data-testid="attach-ai-fix"
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 self-start rounded-input border px-3 text-sm font-medium sm:min-h-9",
                  focusRing,
                  attachFix ? "border-pigment bg-pigment-soft text-pigment" : "border-line text-slate",
                )}
              >
                {attachFix ? <Check size={16} /> : <Sparkles size={16} />}
                {attachFix ? "AI fix added as a picture for the designer" : "Add the AI fix as a picture for the designer"}
              </button>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  setRejecting(false);
                  setError(null);
                }}
                className={cn("h-12 rounded-input border border-line text-base font-medium text-ink disabled:opacity-50", focusRing)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={locked || pictures.busy}
                onClick={reject}
                data-testid="send-back"
                className={cn("h-12 rounded-input bg-rose px-3 text-base font-semibold text-surface disabled:opacity-60", focusRing)}
              >
                {/* The full label is wider than half a phone screen. */}
                {busy === "reject" ? (
                  "Sending back..."
                ) : (
                  <>
                    <span className="sm:hidden">Send back</span>
                    <span className="hidden sm:inline">Send back to designer</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : missing.length ? (
          // A portrait has no file: nothing can be approved, Reject (notes) | Send back (one tap).
          <div className="grid grid-cols-2 gap-3">
            {rejectButton}
            <button
              type="button"
              disabled={locked}
              onClick={sendBackMissing}
              data-testid="send-back-missing"
              className={cn("inline-flex h-14 flex-col items-center justify-center rounded-input bg-rose px-2 text-surface disabled:opacity-60", focusRing)}
            >
              {busy === "missing" ? (
                <span className="text-lg font-semibold">Sending back...</span>
              ) : (
                <>
                  <span className="text-lg font-semibold leading-tight">Send back</span>
                  <span className="max-w-full truncate text-xs leading-tight">{missingWho} missing</span>
                </>
              )}
            </button>
          </div>
        ) : (
          // Phone: Send AI fix full width on top of Reject | Approve. Wider: one row, Send AI fix last.
          <div className={cn("grid grid-cols-2 gap-3", fixIds.length && "sm:grid-cols-3")}>
            {fixIds.length ? (
              <button
                type="button"
                disabled={locked || item.aiWaiting}
                onClick={approveFix}
                data-testid="approve-ai-fix"
                className={cn("col-span-2 inline-flex h-12 items-center justify-center gap-2 rounded-input bg-pigment text-lg font-semibold text-surface disabled:opacity-60 sm:order-last sm:col-span-1 sm:h-14", focusRing)}
              >
                <Sparkles size={20} /> Send AI fix
              </button>
            ) : null}
            {rejectButton}
            <button
              type="button"
              disabled={locked || !allVersions.length || item.aiWaiting}
              onClick={approve}
              data-testid="approve"
              className={cn("inline-flex h-14 items-center justify-center gap-2 rounded-input bg-sage text-lg font-semibold text-surface disabled:opacity-60", fixIds.length && "max-sm:text-base", focusRing)}
            >
              {/* "Approve designer's" only fits half a phone screen without the tick. */}
              <Check size={20} className={cn(fixIds.length && "max-sm:hidden")} /> {fixIds.length ? "Approve designer's" : "Approve"}
            </button>
          </div>
        )}
      </BottomDock>

      {enlarged ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Full size"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4"
          onClick={() => setEnlarged(null)}
        >
          <img src={enlarged} alt="" className="max-h-full max-w-full object-contain" />
          <button
            type="button"
            onClick={() => setEnlarged(null)}
            className={cn("absolute right-3 top-3 flex size-11 items-center justify-center rounded-full bg-surface text-ink", focusRing)}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
