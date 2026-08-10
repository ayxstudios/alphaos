"use client";

import { useState, useTransition } from "react";

import { cn } from "@/lib/utils";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
  Input,
  Badge,
  InfoBubble,
} from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { Building } from "@/components/ui/icons";
import { saveEtsyCredentials, triggerSync, backfillEtsyShop } from "@/app/(app)/settings/actions";
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
    if (!confirm("Backfill re-scans the last 60 days with NO customer emails sent. Continue?")) return;
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

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-pigment-soft text-pigment">
              <Building size={18} />
            </span>
            <div className="min-w-0">
              <CardTitle className="truncate">{shop.name}</CardTitle>
              <p className="text-xs text-slate">
                Etsy shop{" "}
                {shop.etsyShopId ? (
                  <span className="font-mono tabular-nums text-ink">#{shop.etsyShopId}</span>
                ) : (
                  "(id set on connect)"
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {health !== "ok" && (
              <Badge variant="warning" dot>
                Sync {health === "never" ? "never run" : "stale"}
              </Badge>
            )}
            <StatusBadge status={shop.status} />
          </div>
        </div>

        {/* Scannable meta strip instead of one long sentence. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs text-slate">
          <span>
            Last sync{" "}
            <span className="font-mono tabular-nums text-ink">{lastSync}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            Cursor <span className="font-mono tabular-nums text-ink">{cursor}</span>
            <InfoBubble label="What is the sync cursor?">
              The Etsy API pagination position from the last successful sync. Orders
              created after this point are picked up on the next sync.
            </InfoBubble>
          </span>
          <span>
            {shop.ruleCount} figure rule{shop.ruleCount === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1">
            Heuristic figure count {shop.allowHeuristic ? "on" : "off"}
            <InfoBubble label="What is heuristic figure count?">
              When on, AlphaOS guesses the number of figures/pets from the order
              quantity if no figure rule matches. Off by default so unmatched orders
              route to manual review instead.
            </InfoBubble>
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div>
          <h4 className="text-sm font-semibold text-ink">API credentials</h4>
          <form action={saveEtsyCredentials} className="mt-2 flex flex-col gap-3">
            <input type="hidden" name="shopId" value={shop.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Keystring"
                name="keystring"
                placeholder={shop.hasKeystring ? "•••••••• (set — enter to replace)" : "Etsy app keystring"}
                autoComplete="off"
                required
              />
              <Input
                label="Shared secret"
                name="sharedSecret"
                type="password"
                placeholder={shop.hasKeystring ? "•••••••• (set — enter to replace)" : "Etsy app shared secret"}
                autoComplete="off"
                required
              />
            </div>
            <Button type="submit" variant="secondary" size="sm" className="w-fit">
              Save app credentials
            </Button>
          </form>
        </div>

        <div className="border-t border-line pt-5">
          <h4 className="text-sm font-semibold text-ink">Import rules</h4>
          <p className="mt-0.5 text-xs text-slate">
            How figure counts, non-portrait line items, and photo requests resolve for
            this shop&apos;s orders.
          </p>
          <div className="mt-2">
            <ResolutionRulesEditor
              shopId={shop.id}
              platform="etsy"
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
      </CardContent>

      <CardFooter className="flex-col items-start gap-3 border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/etsy/connect?shopId=${shop.id}`}
            aria-disabled={!shop.hasKeystring}
            className={cn(
              "inline-flex h-8 items-center justify-center rounded-input bg-pigment px-3 text-sm font-semibold text-surface shadow-sm",
              "transition-colors motion-hover hover:bg-[#233e70]",
              focusRing,
              !shop.hasKeystring && "pointer-events-none opacity-50",
            )}
          >
            {shop.status === "connected" ? "Reconnect" : "Connect"}
          </a>
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
            title="Re-scan 60 days; no customer emails"
          >
            Backfill 60d (no email)
          </Button>
          {!shop.hasKeystring && (
            <span className="text-xs text-slate">Save the keystring before connecting.</span>
          )}
        </div>

        {error && <p className="text-sm text-rose">{error}</p>}
        {summary && (
          <p className="text-sm text-slate">
            {summary.skippedRun
              ? `Sync skipped: ${summary.skippedRun.replace("_", " ")}.`
              : `Imported ${summary.imported}, skipped ${summary.skipped}, failed ${summary.failed}.`}
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
