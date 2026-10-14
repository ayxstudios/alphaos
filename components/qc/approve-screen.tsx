"use client";

/* eslint-disable @next/next/no-img-element -- order photos and artwork are signed R2/CDN urls of any size */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { ownerReject } from "@/app/(app)/approve/actions";
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
import { useToast } from "@/components/ui";
import { ArrowRight, Check, X } from "@/components/ui/icons";
import { focusRing } from "@/components/ui/styles";
import type { ApproveItem } from "@/lib/qc/approve-data";
import { splitChecklistLabel } from "@/lib/qc/checklist";
import { cn } from "@/lib/utils";

type Props = { item: ApproveItem; position: number; total: number; nextId: string | null };

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

export function ApproveScreen({ item, position, total, nextId }: Props) {
  const { ctx } = item;
  const router = useRouter();
  const toast = useToast();
  usePendingApprovals(); // re-render when the skip list changes (Skip link)
  // The page Approve moves to (this order skipped), preloaded so the swap is instant.
  const afterApprove = approveHref(nextId, undefined, ctx.orderId);
  useEffect(() => {
    router.prefetch(afterApprove, FULL_PREFETCH);
    // Where Stop lands: this same order, pinned. Warm before Approve is tapped.
    router.prefetch(approveHref(ctx.orderId, ctx.orderId), FULL_PREFETCH);
  }, [afterApprove, ctx.orderId, router]);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"reject" | null>(null);
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
  const pictures = useQcPictures(ctx.orderId);  const [showBefore, setShowBefore] = useState(false);
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
  const shown = showBefore && before ? before : latest;
  const due = dueText(ctx.dueAt);
  const photos = ctx.references.filter((r) => r.url);

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

  async function reject() {
    if (!note.trim()) {
      setError("Write what needs fixing first.");
      return;
    }
    if (pictures.busy || pictures.failedCount > 0) {
      setError(pictures.busy ? "Wait for the pictures to finish uploading." : "Retry or remove the picture that did not upload.");
      return;
    }
    setBusy("reject");
    setError(null);
    const res = await callAction(() => ownerReject({ orderId: ctx.orderId, note, failedKeys: picked, attachmentAssetIds: pictures.assetIds }));
    if (!res) return;
    if (!res.ok) {
      if (res.code === "stale") {
        toast({ variant: "warning", title: "Already checked", description: res.message });
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

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4" data-testid="approve-screen" data-kind={item.isRevision ? "revision" : "new"}>
      <PendingApprovalsHost />
      {/* Where am I in the pile */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold text-ink">Approve</h1>
        <div className="flex items-center gap-1 text-sm text-slate">
          <span>
            {position} of {total} to check
          </span>
          {nextId ? (
            <Link
              href={approveHref(nextId)}
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
                        setShowBefore(false);
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
            {before ? (
              <div className="flex gap-1 self-start rounded-input bg-canvas p-1" role="group" aria-label="Which version">
                {[
                  { k: false, label: "New version" },
                  { k: true, label: "Before" },
                ].map((b) => (
                  <button
                    key={b.label}
                    type="button"
                    onClick={() => setShowBefore(b.k)}
                    aria-pressed={showBefore === b.k}
                    className={cn(
                      "min-h-11 rounded-input px-3 text-sm font-medium sm:min-h-9",
                      focusRing,
                      showBefore === b.k ? "bg-surface text-ink shadow-card" : "text-slate",
                    )}
                  >
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

      {/* The two buttons, always in reach */}
      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 flex flex-col gap-3 rounded-card bg-surface p-3 shadow-lg lg:bottom-4">
        <PendingApprovalsInline />
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
                className={cn("h-12 rounded-input bg-rose text-base font-semibold text-surface disabled:opacity-60", focusRing)}
              >
                {busy === "reject" ? "Sending back..." : "Send back to designer"}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setRejecting(true);
                setError(null);
              }}
              data-testid="reject"
              className={cn("inline-flex h-14 items-center justify-center gap-2 rounded-input border-2 border-rose text-lg font-semibold text-rose disabled:opacity-50", focusRing)}
            >
              <X size={20} /> Reject
            </button>
            <button
              type="button"
              disabled={locked || !allVersions.length}
              onClick={approve}
              data-testid="approve"
              className={cn("inline-flex h-14 items-center justify-center gap-2 rounded-input bg-sage text-lg font-semibold text-surface disabled:opacity-60", focusRing)}
            >
              <Check size={20} /> Approve
            </button>
          </div>
        )}
      </div>

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
