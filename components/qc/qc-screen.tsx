"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Page, Textarea, useToast } from "@/components/ui";
import { Check, XCircle } from "@/components/ui/icons";
import { shortcutFor, type ItemResults } from "@/lib/qc/checklist";
import type { QcContext } from "@/lib/qc/data";
import {
  confirmQcPassAndSend,
  prepareQcEmailPreview,
  submitQcFail,
  type QcEmailPreviewResult,
  type QcResult,
} from "@/app/(app)/qc/actions";
import { CompareViewer } from "./compare-viewer";
import { ChecklistPanel } from "./checklist-panel";
import { VersionStrip } from "./version-strip";
import { QcHeader } from "./qc-header";
import { FailDialog } from "./fail-dialog";
import { ShortcutLegend, LegendToggle } from "./shortcut-legend";
import { SignatureInput, normalizeSignature } from "./signature-input";

const LEGEND_KEY = "qc-legend-dismissed";

export function QcScreen({
  ctx,
  queueIds,
  reviewerName,
}: {
  ctx: QcContext;
  queueIds: string[];
  reviewerName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  // Which button started the pending work, so only that one spins.
  const [acting, setActing] = useState<"pass" | "fail" | null>(null);

  const items = ctx.checklist.items;
  const [checked, setChecked] = useState<ItemResults>({});
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    ctx.versions.length ? ctx.versions[ctx.versions.length - 1].id : null,
  );
  const [failOpen, setFailOpen] = useState(false);
  const [emailPreview, setEmailPreview] = useState<Extract<QcEmailPreviewResult, { ok: true }>["preview"] | null>(null);
  const [emailBody, setEmailBody] = useState("");
  const [legendOpen, setLegendOpen] = useState(false);
  const [signature, setSignature] = useState("");
  const signed = signature.length > 0 && normalizeSignature(signature) === normalizeSignature(reviewerName);

  // Reset per-order state whenever we land on a new order.
  useEffect(() => {
    setChecked({});
    setSelectedVersionId(ctx.versions.length ? ctx.versions[ctx.versions.length - 1].id : null);
    setFailOpen(false);
    setEmailPreview(null);
    setEmailBody("");
    setSignature("");
  }, [ctx.orderId, ctx.versions]);

  // The legend stays closed until asked for (the ? button, or the ? key);
  // once opened it remembers that choice.
  useEffect(() => {
    if (localStorage.getItem(LEGEND_KEY) === "0") setLegendOpen(true);
  }, []);

  const dismissLegend = useCallback(() => {
    setLegendOpen(false);
    localStorage.setItem(LEGEND_KEY, "1");
  }, []);
  const openLegend = useCallback(() => {
    setLegendOpen(true);
    localStorage.setItem(LEGEND_KEY, "0");
  }, []);

  const allChecked = items.length > 0 && items.every((it) => checked[it.key] === true);
  const doneCount = items.filter((it) => checked[it.key]).length;
  const failedCount = items.filter((it) => checked[it.key] === false).length;

  const shortcutMap = useMemo(() => {
    const m: Record<string, number> = {};
    items.slice(0, 10).forEach((it) => (m[shortcutFor(it.key)] = it.key));
    return m;
  }, [items]);

  // Queue position + neighbours for J/K and auto-advance.
  const index = queueIds.indexOf(ctx.orderId);
  const prevId = index > 0 ? queueIds[index - 1] : null;
  const nextId = index >= 0 && index < queueIds.length - 1 ? queueIds[index + 1] : null;

  const goTo = useCallback((id: string) => router.push(`/qc/${id}`), [router]);
  const advance = useCallback(() => {
    if (nextId) router.push(`/qc/${nextId}`);
    else router.push("/qc");
  }, [nextId, router]);

  const toggle = useCallback(
    (key: number) =>
      setChecked((prev) => {
        const next = { ...prev };
        if (next[key] === true) delete next[key];
        else next[key] = true;
        return next;
      }),
    [],
  );
  const mark = useCallback(
    (key: number, value: boolean | null) =>
      setChecked((prev) => {
        const next = { ...prev };
        if (value === null) delete next[key];
        else next[key] = value;
        return next;
      }),
    [],
  );
  const tickAll = useCallback(() => {
    setChecked(Object.fromEntries(items.map((it) => [it.key, true])));
  }, [items]);

  const handleResult = useCallback(
    (res: QcResult, successTitle: string) => {
      if (res.ok) {
        toast({ variant: "success", title: successTitle });
        advance();
      } else if (res.code === "stale") {
        toast({ variant: "warning", title: "Already moved", description: res.message });
        router.refresh();
      } else {
        toast({ variant: "danger", title: res.code === "email_failed" ? "Email not sent" : "Couldn't save", description: res.message });
      }
    },
    [toast, advance, router],
  );

  const doPass = useCallback(() => {
    if (!ctx.isReviewable || !allChecked || !signed || pending) return;
    setActing("pass");
    start(async () => {
      const res = await prepareQcEmailPreview({
        orderId: ctx.orderId,
        expectedFrom: ctx.status,
        checklist: ctx.checklist,
        itemResults: checked,
        signature,
      });
      if (res.ok) {
        setEmailPreview(res.preview);
        setEmailBody(res.preview.body);
      } else if (res.code === "stale") {
        toast({ variant: "warning", title: "Already moved", description: res.message });
        router.refresh();
      } else {
        toast({ variant: "danger", title: "Couldn't prepare email", description: res.message });
      }
    });
  }, [ctx, allChecked, signed, signature, pending, checked, toast, router]);

  const confirmSend = useCallback(() => {
    if (!emailPreview || pending) return;
    setActing("pass");
    start(async () => {
      const res = await confirmQcPassAndSend({
        orderId: ctx.orderId,
        expectedFrom: ctx.status,
        checklist: ctx.checklist,
        itemResults: checked,
        proofId: emailPreview.proofId,
        templateKey: emailPreview.templateKey,
        templateReason: emailPreview.templateReason,
        attachmentAssetId: emailPreview.attachment.assetId,
        attachmentFingerprint: emailPreview.attachment.fingerprint,
        subject: emailPreview.subject,
        body: emailBody,
        signature,
      });
      if (res.ok) setEmailPreview(null);
      handleResult(res, "Proof sent to the customer");
    });
  }, [checked, ctx, emailBody, emailPreview, handleResult, pending, signature]);

  const doFail = useCallback(
    (failedKeys: number[], reason: string) => {
      setActing("fail");
      start(async () => {
        const res = await submitQcFail({
          orderId: ctx.orderId,
          expectedFrom: ctx.status,
          checklist: ctx.checklist,
          failedKeys,
          reason,
          signature,
        });
        if (res.ok) setFailOpen(false);
        handleResult(res, "Sent back to the designer");
      });
    },
    [ctx, handleResult, signature],
  );

  // Global keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const editable =
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);

      // `?` toggles the legend from anywhere (outside inputs).
      if (e.key === "?" && !editable) {
        e.preventDefault();
        if (legendOpen) dismissLegend();
        else openLegend();
        return;
      }

      // The fail dialog owns the keyboard while it's open.
      if (failOpen || emailPreview || editable) return;

      if (e.key === "j" || e.key === "J") {
        if (nextId) { e.preventDefault(); goTo(nextId); }
        return;
      }
      if (e.key === "k" || e.key === "K") {
        if (prevId) { e.preventDefault(); goTo(prevId); }
        return;
      }

      if (!ctx.isReviewable) return;

      if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        tickAll();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (signed && ctx.isReviewable && !pending) setFailOpen(true);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        doPass();
        return;
      }
      if (e.key in shortcutMap) {
        e.preventDefault();
        toggle(shortcutMap[e.key]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [signed, pending, 
    ctx.isReviewable, failOpen, emailPreview, legendOpen, nextId, prevId, shortcutMap,
    goTo, tickAll, toggle, doPass, dismissLegend, openLegend,
  ]);

  // One line that always says what to do next.
  const nextStep =
    failedCount > 0
      ? signed
        ? "Press Fail and tell the designer what to fix."
        : `${failedCount} marked wrong. Sign your name, then press Fail.`
      : allChecked
        ? signed
          ? "Press Pass. You will see the customer email before it sends."
          : "All good. Sign your name, then press Pass."
        : "Tap each line that looks right. Tap the cross if something is wrong.";

  const selectedIndex = ctx.versions.findIndex((v) => v.id === selectedVersionId);
  const selectedVersion = selectedIndex >= 0 ? ctx.versions[selectedIndex] : null;
  const isLatest = selectedIndex === ctx.versions.length - 1;
  const portraitLabel =
    selectedVersion == null
      ? "Designer's portrait"
      : isLatest
        ? "Designer's portrait"
        : `Designer's portrait (version ${selectedIndex + 1})`;

  // The fail box starts with what the reviewer already said: the lines marked
  // wrong. With none marked, the unticked lines if some were ticked; with
  // nothing touched, none (the reviewer picks). It used to pre-mark every
  // unticked line, so one cross told the designer all five were wrong.
  const markedWrong = items.filter((it) => checked[it.key] === false).map((it) => it.key);
  const initialFailedKeys = markedWrong.length
    ? markedWrong
    : doneCount > 0
      ? items.filter((it) => !checked[it.key]).map((it) => it.key)
      : [];

  return (
    <Page className="max-w-none gap-3">
      <QcHeader
        ctx={ctx}
        position={index + 1}
        total={queueIds.length}
        hasPrev={!!prevId}
        hasNext={!!nextId}
        onPrev={() => prevId && goTo(prevId)}
        onNext={() => nextId && goTo(nextId)}
      />

      {!ctx.isReviewable && (
        <div className="flex items-center justify-between gap-2 rounded-card bg-amber/10 px-4 py-2">
          <span className="text-sm text-amber">
            Already checked. This order is now {ctx.status.replace(/_/g, " ")}.
          </span>
          <Button size="sm" variant="secondary" onClick={advance}>
            Next order
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 min-h-[38rem] flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <CompareViewer
          key={ctx.orderId}
          references={ctx.references}
          portrait={selectedVersion?.url ?? null}
          portraitLabel={portraitLabel}
        />

        <aside className="flex min-h-[28rem] flex-col rounded-card bg-surface p-4 shadow-card">
          <div className="min-h-0 flex-1">
              <ChecklistPanel
                items={items}
                checked={checked}
                onToggle={toggle}
                onMark={mark}
                onTickAll={tickAll}
                disabled={!ctx.isReviewable || pending}
              />
          </div>

          <div className="mt-4 flex flex-col gap-3 border-t border-line/70 pt-4">
            {ctx.isReviewable && (
              <p className="text-sm text-slate" aria-live="polite">
                {nextStep}
              </p>
            )}
            <SignatureInput value={signature} onChange={setSignature} expectedName={reviewerName} disabled={!ctx.isReviewable || pending} />
            <div className="flex gap-2">
              <Button
                variant={failedCount > 0 ? "danger" : "secondary"}
                className="flex-1"
                onClick={() => setFailOpen(true)}
                loading={pending && acting === "fail"}
                disabled={!ctx.isReviewable || !signed || pending}
              >
                <XCircle size={16} /> Fail{" "}
                <kbd className="hidden rounded border border-surface/30 px-1 text-xs lg:inline">F</kbd>
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                onClick={doPass}
                loading={pending && acting === "pass"}
                disabled={!ctx.isReviewable || !allChecked || !signed || pending}
              >
                <Check size={16} /> Pass{" "}
                <kbd className="hidden rounded border border-surface/30 px-1 text-xs lg:inline">↵</kbd>
              </Button>
            </div>
          </div>
        </aside>
      </div>

      <div className="shrink-0">
        <div className="flex items-center justify-between pb-1.5">
          <span className="text-xs font-medium text-slate">Versions</span>
          {selectedVersion && ctx.versions.length > 1 && (
            <span className="text-xs text-slate">
              Showing {isLatest ? "the newest" : `version ${selectedIndex + 1}`}. Tap another to compare.
            </span>
          )}
        </div>
        <VersionStrip
          versions={ctx.versions}
          selectedId={selectedVersionId}
          onSelect={setSelectedVersionId}
        />
      </div>

      <FailDialog
        open={failOpen}
        onClose={() => setFailOpen(false)}
        items={items}
        initialFailedKeys={initialFailedKeys}
        submitting={pending}
        onSubmit={doFail}
      />

      {emailPreview && (
        <EmailPreviewDialog
          preview={emailPreview}
          body={emailBody}
          checklist={ctx.checklist}
          pending={pending}
          onBody={setEmailBody}
          onCancel={() => setEmailPreview(null)}
          onConfirm={confirmSend}
        />
      )}

      {legendOpen ? (
        <ShortcutLegend open={legendOpen} onClose={dismissLegend} />
      ) : (
        <LegendToggle onClick={openLegend} />
      )}
    </Page>
  );
}

function EmailPreviewDialog({
  preview,
  body,
  checklist,
  pending,
  onBody,
  onCancel,
  onConfirm,
}: {
  preview: Extract<QcEmailPreviewResult, { ok: true }>["preview"];
  body: string;
  checklist: QcContext["checklist"];
  pending: boolean;
  onBody: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Escape closes, like the fail dialog (not while a send is in flight).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="qc-email-preview-title"
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-modal bg-surface shadow-lg"
      >
        {/* Body scrolls (as one on a phone, per pane from xl); the footer with
            Send stays put, so the one thing to do is always on screen. */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_28rem] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
        <div className="min-h-0 p-5 xl:overflow-y-auto">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="qc-email-preview-title" className="font-display text-xl font-semibold text-ink">Check the email, then send</h2>
              <p className="mt-1 text-sm text-slate">
                The customer gets this email with the portrait attached.
              </p>
            </div>
            <Badge variant="info">Order {preview.orderNumber}</Badge>
          </div>

          <div className="mt-4 rounded-card border border-line bg-canvas p-3">
            <p className="mb-2 text-sm font-medium text-ink">Attached portrait</p>
            {preview.attachment.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview.attachment.url}
                alt=""
                className="max-h-[34rem] w-full rounded-input bg-surface object-contain"
              />
            ) : (
              <div className="flex h-64 items-center justify-center rounded-input bg-surface text-sm text-slate">
                No preview here, but the file will still be attached.
              </div>
            )}
            <p className="mt-2 text-xs text-slate [overflow-wrap:anywhere]">
              {preview.attachment.filename}
            </p>
          </div>

          <p className="mt-3 flex items-center gap-2 text-sm text-slate">
            <Check size={14} className="text-sage" />
            All {checklist.items.length} checks ticked. Email: {preview.templateLabel}.
          </p>
        </div>

        <aside className="min-h-0 border-t border-line bg-canvas p-5 xl:overflow-y-auto xl:border-l xl:border-t-0">
          <div className="text-sm">
            <p className="text-xs text-slate">To: <span className="text-ink">{preview.to}</span></p>
            <p className="mt-1 text-xs text-slate">Subject: <span className="font-medium text-ink">{preview.subject}</span></p>
          </div>

          <div className="mt-3">
            <Textarea
              label="Message"
              hint="You can change it. Changes are for this email only."
              value={body}
              onChange={(event) => onBody(event.currentTarget.value)}
              rows={14}
              className="text-sm"
            />
          </div>

        </aside>
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-surface px-5 py-3">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Back
          </Button>
          <Button type="button" onClick={onConfirm} loading={pending} disabled={!body.trim()}>
            Send email and pass QC
          </Button>
        </div>
      </div>
    </div>
  );
}
