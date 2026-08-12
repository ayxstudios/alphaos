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

  const items = ctx.checklist.items;
  const [checked, setChecked] = useState<ItemResults>({});
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    ctx.versions.length ? ctx.versions[ctx.versions.length - 1].id : null,
  );
  const [failOpen, setFailOpen] = useState(false);
  const [emailPreview, setEmailPreview] = useState<Extract<QcEmailPreviewResult, { ok: true }>["preview"] | null>(null);
  const [emailBody, setEmailBody] = useState("");
  const [legendOpen, setLegendOpen] = useState(true);

  // Reset per-order state whenever we land on a new order.
  useEffect(() => {
    setChecked({});
    setSelectedVersionId(ctx.versions.length ? ctx.versions[ctx.versions.length - 1].id : null);
    setFailOpen(false);
    setEmailPreview(null);
    setEmailBody("");
  }, [ctx.orderId, ctx.versions]);

  useEffect(() => {
    if (localStorage.getItem(LEGEND_KEY) === "1") setLegendOpen(false);
  }, []);

  const dismissLegend = useCallback(() => {
    setLegendOpen(false);
    localStorage.setItem(LEGEND_KEY, "1");
  }, []);
  const openLegend = useCallback(() => {
    setLegendOpen(true);
    localStorage.removeItem(LEGEND_KEY);
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
    else router.push("/orders?view=awaiting_qc");
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
    (key: number, value: boolean) => setChecked((prev) => ({ ...prev, [key]: value })),
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
        toast({ variant: "danger", title: "Couldn't submit", description: res.message });
      }
    },
    [toast, advance, router],
  );

  const doPass = useCallback(() => {
    if (!ctx.isReviewable || !allChecked || pending) return;
    start(async () => {
      const res = await prepareQcEmailPreview({
        orderId: ctx.orderId,
        expectedFrom: ctx.status,
        checklist: ctx.checklist,
        itemResults: checked,
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
  }, [ctx, allChecked, pending, checked, toast, router]);

  const confirmSend = useCallback(() => {
    if (!emailPreview || pending) return;
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
      });
      if (res.ok) setEmailPreview(null);
      handleResult(res, "Email sent — sent to approval");
    });
  }, [checked, ctx, emailBody, emailPreview, handleResult, pending]);

  const doFail = useCallback(
    (failedKeys: number[], reason: string) => {
      start(async () => {
        const res = await submitQcFail({
          orderId: ctx.orderId,
          expectedFrom: ctx.status,
          checklist: ctx.checklist,
          failedKeys,
          reason,
        });
        if (res.ok) setFailOpen(false);
        handleResult(res, "Failed — returned to designer");
      });
    },
    [ctx, handleResult],
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
        setFailOpen(true);
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
  }, [
    ctx.isReviewable, failOpen, emailPreview, legendOpen, nextId, prevId, shortcutMap,
    goTo, tickAll, toggle, doPass, dismissLegend, openLegend,
  ]);

  const selectedIndex = ctx.versions.findIndex((v) => v.id === selectedVersionId);
  const selectedVersion = selectedIndex >= 0 ? ctx.versions[selectedIndex] : null;
  const isLatest = selectedIndex === ctx.versions.length - 1;
  const portraitLabel =
    selectedVersion == null
      ? "Delivered portrait"
      : isLatest
        ? "Delivered (latest)"
        : `Delivered (v${selectedIndex + 1})`;

  const initialFailedKeys = items.filter((it) => !checked[it.key]).map((it) => it.key);

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
        <div className="flex items-center justify-between gap-2 rounded-card border border-amber/25 bg-amber/10 px-4 py-2">
          <span className="text-sm text-amber">
            This order is no longer awaiting QC (now {ctx.status.replace(/_/g, " ")}). Nothing to
            review.
          </span>
          <Button size="sm" variant="secondary" onClick={advance}>
            Next order
          </Button>
        </div>
      )}

      <div className="grid min-h-[38rem] flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <CompareViewer
          key={ctx.orderId}
          references={ctx.references}
          portrait={selectedVersion?.url ?? null}
          portraitLabel={portraitLabel}
        />

        <aside className="flex min-h-[28rem] flex-col rounded-card border border-line bg-surface p-3 shadow-sm">
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

          <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
            {ctx.isReviewable && !allChecked && (
              <p className="text-xs text-slate">
                Mark every item Pass to enable Pass. Use X for anything the designer missed.{" "}
                <Badge variant="neutral">{doneCount}/{items.length}</Badge>
                {failedCount > 0 && <Badge variant="danger">{failedCount} X</Badge>}
              </p>
            )}
            <div className="rounded-input bg-canvas px-3 py-2 text-xs text-slate">
              QC sign-off: <span className="font-medium text-ink">{reviewerName}</span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="danger"
                className="flex-1"
                onClick={() => setFailOpen(true)}
                disabled={!ctx.isReviewable || pending}
              >
                <XCircle size={16} /> Fail{" "}
                <kbd className="rounded border border-surface/30 px-1 text-[10px]">F</kbd>
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                onClick={doPass}
                loading={pending}
                disabled={!ctx.isReviewable || !allChecked}
              >
                <Check size={16} /> Pass{" "}
                <kbd className="rounded border border-surface/30 px-1 text-[10px]">↵</kbd>
              </Button>
            </div>
          </div>
        </aside>
      </div>

      <div className="shrink-0">
        <div className="flex items-center justify-between pb-1">
          <span className="text-xs font-medium text-slate">Version history</span>
          {selectedVersion && (
            <span className="text-xs text-slate">
              Showing {isLatest ? "latest" : `v${selectedIndex + 1}`} · click to compare a prior
              submission
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4">
      <div className="grid max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-modal bg-surface shadow-lg xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="min-h-0 overflow-y-auto p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-semibold text-ink">Preview customer email</h2>
              <p className="mt-1 text-sm text-slate">
                Template: <span className="font-medium text-ink">{preview.templateLabel}</span> · {preview.templateReason}
              </p>
            </div>
            <Badge variant="info">Order {preview.orderNumber}</Badge>
          </div>

          <div className="mt-4 rounded-card border border-line bg-canvas p-3">
            <p className="mb-2 text-sm font-medium text-ink">Portrait attached to this email</p>
            {preview.attachment.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview.attachment.url}
                alt=""
                className="max-h-[34rem] w-full rounded-input bg-surface object-contain"
              />
            ) : (
              <div className="flex h-64 items-center justify-center rounded-input bg-surface text-sm text-slate">
                Preview unavailable, but the stored asset will be attached if readable.
              </div>
            )}
            <p className="mt-2 text-xs text-slate">
              {preview.attachment.filename} · {preview.attachment.contentType}
              {preview.attachment.sizeBytes ? ` · ${(preview.attachment.sizeBytes / 1024 / 1024).toFixed(1)} MB raw` : ""}
            </p>
          </div>

          <div className="mt-4 rounded-card border border-line p-3">
            <p className="text-sm font-medium text-ink">QC checklist completed</p>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {checklist.items.map((item) => (
                <div key={item.key} className="flex items-center gap-2 text-sm text-slate">
                  <Check size={14} className="text-sage" />
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <aside className="min-h-0 overflow-y-auto border-t border-line bg-canvas p-5 xl:border-l xl:border-t-0">
          <div className="rounded-card border border-line bg-surface p-3 text-sm">
            <p className="text-xs text-slate">To: <span className="text-ink">{preview.to}</span></p>
            <p className="mt-1 text-xs text-slate">Subject: <span className="font-medium text-ink">{preview.subject}</span></p>
            <div className="mt-3 whitespace-pre-wrap rounded-input border border-line bg-canvas p-3 text-sm text-ink">
              {body}
            </div>
          </div>

          <Textarea
            label="Body edits for this send only"
            value={body}
            onChange={(event) => onBody(event.currentTarget.value)}
            rows={12}
            className="mt-4 font-mono text-xs"
          />

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={onConfirm} loading={pending} disabled={!body.trim()}>
              Send email & pass QC
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
