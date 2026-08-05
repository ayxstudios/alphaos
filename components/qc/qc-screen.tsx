"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Page, useToast } from "@/components/ui";
import { Check, XCircle } from "@/components/ui/icons";
import { shortcutFor, type ItemResults } from "@/lib/qc/checklist";
import type { QcContext } from "@/lib/qc/data";
import { submitQcPass, submitQcFail, type QcResult } from "@/app/(app)/qc/actions";
import { CompareViewer } from "./compare-viewer";
import { ChecklistPanel } from "./checklist-panel";
import { VersionStrip } from "./version-strip";
import { QcHeader } from "./qc-header";
import { FailDialog } from "./fail-dialog";
import { ShortcutLegend, LegendToggle } from "./shortcut-legend";

const LEGEND_KEY = "qc-legend-dismissed";

export function QcScreen({ ctx, queueIds }: { ctx: QcContext; queueIds: string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  const items = ctx.checklist.items;
  const [checked, setChecked] = useState<ItemResults>({});
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    ctx.versions.length ? ctx.versions[ctx.versions.length - 1].id : null,
  );
  const [failOpen, setFailOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);

  // Reset per-order state whenever we land on a new order.
  useEffect(() => {
    setChecked({});
    setSelectedVersionId(ctx.versions.length ? ctx.versions[ctx.versions.length - 1].id : null);
    setFailOpen(false);
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
    else router.push("/queue?tab=awaiting_qc");
  }, [nextId, router]);

  const toggle = useCallback(
    (key: number) => setChecked((prev) => ({ ...prev, [key]: !prev[key] })),
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
      const res = await submitQcPass({
        orderId: ctx.orderId,
        expectedFrom: ctx.status,
        checklist: ctx.checklist,
        itemResults: checked,
      });
      handleResult(res, "Passed — sent to approval");
    });
  }, [ctx, allChecked, pending, checked, handleResult]);

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
      if (failOpen || editable) return;

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
    ctx.isReviewable, failOpen, legendOpen, nextId, prevId, shortcutMap,
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
              onTickAll={tickAll}
              disabled={!ctx.isReviewable || pending}
            />
          </div>

          <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
            {ctx.isReviewable && !allChecked && (
              <p className="text-xs text-slate">
                Tick all {items.length} items to enable Pass.{" "}
                <Badge variant="neutral">{doneCount}/{items.length}</Badge>
              </p>
            )}
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

      {legendOpen ? (
        <ShortcutLegend open={legendOpen} onClose={dismissLegend} />
      ) : (
        <LegendToggle onClick={openLegend} />
      )}
    </Page>
  );
}
