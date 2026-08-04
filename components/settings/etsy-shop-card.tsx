"use client";

import { useState, useTransition } from "react";

import { cn } from "@/lib/utils";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Input,
  Badge,
} from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { saveEtsyCredentials, triggerSync, backfillEtsyShop } from "@/app/(app)/settings/actions";
import { ResolutionRulesEditor } from "@/components/settings/resolution-rules-editor";
import type { SyncSummary } from "@/lib/integrations/etsy";
import type { FigureRule, StyleRule } from "@/lib/integrations/figures";

export type EtsyShopVM = {
  id: string;
  name: string;
  hasKeystring: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  etsyShopId: string | null;
  lastSyncCursor: string | null;
  allowHeuristic: boolean;
  ruleCount: number;
  figureRules: FigureRule[];
  styleRules: StyleRule[];
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

  const lastSync = shop.lastSyncCursor
    ? new Date(Number(shop.lastSyncCursor) * 1000).toLocaleString()
    : "never";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{shop.name}</CardTitle>
          <StatusBadge status={shop.status} />
        </div>
        <CardDescription>
          Etsy shop {shop.etsyShopId ? `#${shop.etsyShopId}` : "(id set on connect)"} ·
          last sync {lastSync} · {shop.ruleCount} figure rule{shop.ruleCount === 1 ? "" : "s"} ·
          heuristic {shop.allowHeuristic ? "on" : "off"}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <form action={saveEtsyCredentials} className="flex flex-col gap-3">
          <input type="hidden" name="shopId" value={shop.id} />
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
          <Button type="submit" variant="secondary" size="sm" className="w-fit">
            Save app credentials
          </Button>
        </form>

        <ResolutionRulesEditor
          shopId={shop.id}
          platform="etsy"
          initialFigureRules={shop.figureRules}
          initialStyleRules={shop.styleRules}
          initialNonPortraitSkus={shop.nonPortraitSkus}
          initialNonPortraitTitles={shop.nonPortraitTitles}
          initialPhotoRequestEnabled={shop.photoRequestEnabled}
          optionNames={shop.optionNames}
          skuSuggestions={shop.skuSuggestions}
          titleSuggestions={shop.titleSuggestions}
        />
      </CardContent>

      <CardFooter className="flex-col items-start gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/etsy/connect?shopId=${shop.id}`}
            aria-disabled={!shop.hasKeystring}
            className={cn(
              "inline-flex h-8 items-center justify-center rounded-input bg-pigment px-3 text-sm font-medium text-surface",
              "transition-[opacity] motion-hover hover:opacity-90",
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
