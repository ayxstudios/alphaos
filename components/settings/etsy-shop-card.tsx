"use client";

import { useState, useTransition } from "react";

import { cn } from "@/lib/utils";
import {
  Button,
  Input,
  Badge,
} from "@/components/ui";
import { ChevronDown } from "@/components/ui/icons";
import { saveEtsyCredentials, triggerSync, backfillEtsyShop, saveShopBackfillCutoff } from "@/app/(app)/settings/actions";
import { ResolutionRulesEditor } from "@/components/settings/resolution-rules-editor";
import { formatSyncTime, syncHealth } from "@/lib/integrations/sync-health";
import type { SyncSummary } from "@/lib/integrations/etsy";
import type { FigureRule } from "@/lib/integrations/figures";

export type EtsyShopVM = {
  id: string;
  name: string;
  hasKeystring: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  etsyShopId: string | null;
  lastSyncCursor: string | null;
  lastSyncAt: string | null;
  backfillCutoffAt: string | null;
  allowHeuristic: boolean;
  ruleCount: number;
  figureRules: FigureRule[];
  optionNames: string[];
  nonPortraitSkus: string[];
  nonPortraitTitles: string[];
  photoRequestEnabled: boolean;
  skuSuggestions: string[];
  titleSuggestions: string[];
};

function StatusBadge({ status }: { status: EtsyShopVM["status"] }) {
  if (status === "connected") return <Badge variant="success" dot>Connected</Badge>;
  if (status === "needs_reauth") return <Badge variant="danger" dot>Needs reauth</Badge>;
  return <Badge variant="neutral" dot>Not connected</Badge>;
}

export function EtsyShopCard({ shop }: { shop: EtsyShopVM }) {
  const [pending, startTransition] = useTransition();
  const [backfilling, startBackfill] = useTransition();
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSync() {
    setError(null);
    setSummary(null);
    startTransition(async () => {
      try {
        setSummary(await triggerSync(shop.id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sync failed");
      }
    });
  }

  function onBackfill() {
    if (!confirm("Backfill re-scans the last 60 days. Orders before the cutoff import as archived. Continue?")) return;
    setError(null);
    setSummary(null);
    startBackfill(async () => {
      try {
        setSummary(await backfillEtsyShop(shop.id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Backfill failed");
      }
    });
  }

  const health = syncHealth(shop.lastSyncAt);
  const lastSync = formatSyncTime(shop.lastSyncAt);
  const cursor = shop.lastSyncCursor
    ? new Date(Number(shop.lastSyncCursor) * 1000).toLocaleString()
    : "none";
  const cutoffDate = shop.backfillCutoffAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);

  return (
    <details className="group rounded-card border border-line bg-surface shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{shop.name}</span>
            <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] font-medium uppercase text-slate">Etsy</span>
            <StatusBadge status={shop.status} />
            {health !== "ok" && (
              <Badge variant="warning" dot>
                Sync {health === "never" ? "never run" : "stale"}
              </Badge>
            )}
          </div>
        </div>
        <span className="hidden text-sm text-slate sm:inline">Last sync {lastSync}</span>
        <ChevronDown size={16} className="text-slate transition-transform group-open:rotate-180" />
      </summary>

      <div className="border-t border-line p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="flex flex-col gap-4">
            <form action={saveEtsyCredentials} className="grid gap-3 rounded-input border border-line bg-canvas p-3">
              <input type="hidden" name="shopId" value={shop.id} />
              <Input
                label="Keystring"
                name="keystring"
                placeholder={shop.hasKeystring ? "Set - enter to replace" : "Etsy app keystring"}
                autoComplete="off"
                required
              />
              <Input
                label="Shared secret"
                name="sharedSecret"
                type="password"
                placeholder={shop.hasKeystring ? "Set - enter to replace" : "Etsy app shared secret"}
                autoComplete="off"
                required
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="secondary" size="sm">
                  Save credentials
                </Button>
                <a
                  href={`/api/etsy/connect?shopId=${shop.id}`}
                  aria-disabled={!shop.hasKeystring}
                  className={cn(
                    "inline-flex h-8 items-center justify-center rounded-input bg-pigment px-3 text-sm font-medium text-surface",
                    "transition-[opacity] motion-hover hover:opacity-90",
                    !shop.hasKeystring && "pointer-events-none opacity-50",
                  )}
                >
                  {shop.status === "connected" ? "Reconnect" : "Connect"}
                </a>
              </div>
            </form>

            <form action={saveShopBackfillCutoff} className="rounded-input border border-line bg-canvas p-3">
              <input type="hidden" name="shopId" value={shop.id} />
              <div className="flex flex-wrap items-end gap-3">
                <Input
                  label="Live-order cutoff"
                  name="backfillCutoffDate"
                  type="date"
                  defaultValue={cutoffDate}
                  required
                />
                <Button type="submit" variant="secondary" size="sm">
                  Save cutoff
                </Button>
              </div>
            </form>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onSync}
                loading={pending}
                disabled={shop.status !== "connected"}
              >
                Sync now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onBackfill}
                loading={backfilling}
                disabled={shop.status !== "connected"}
              >
                Backfill 60d
              </Button>
              <span className="text-xs text-slate">Shop ID {shop.etsyShopId ?? "not connected"} · cursor {cursor}</span>
            </div>
            {error && <p className="text-sm text-rose">{error}</p>}
            {summary && (
              <p className="text-sm text-slate">
                {summary.skippedRun
                  ? `Sync skipped: ${summary.skippedRun.replace("_", " ")}.`
                  : `Imported ${summary.imported}, archived ${summary.archived}, skipped ${summary.skipped}, failed ${summary.failed}.`}
              </p>
            )}
          </div>

          <ResolutionRulesEditor
            shopId={shop.id}
            initialFigureRules={shop.figureRules}
            initialNonPortraitSkus={shop.nonPortraitSkus}
            initialNonPortraitTitles={shop.nonPortraitTitles}
            initialPhotoRequestEnabled={shop.photoRequestEnabled}
            optionNames={shop.optionNames}
            skuSuggestions={shop.skuSuggestions}
            titleSuggestions={shop.titleSuggestions}
          />
        </div>
      </div>
    </details>
  );
}
