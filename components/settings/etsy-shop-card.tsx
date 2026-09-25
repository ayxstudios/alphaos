"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import {
  Button,
  ConfirmDrawer,
  Input,
  Badge,
  useToast,
} from "@/components/ui";
import { ChevronDown } from "@/components/ui/icons";
import { saveEtsyCredentials, triggerSync, backfillEtsyShop } from "@/app/(app)/settings/actions";
import { ResolutionRulesEditor } from "@/components/settings/resolution-rules-editor";
import { CutoffForm } from "@/components/settings/cutoff-form";
import { formatSyncTime, syncHealth } from "@/lib/integrations/sync-health";
import type { SyncSummary } from "@/lib/integrations/etsy";
import type { FigureRule } from "@/lib/integrations/figures";
import { formatAt } from "@/lib/time";

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
  const router = useRouter();
  const toast = useToast();
  const [saving, startSave] = useTransition();
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

  function onSaveCredentials(formData: FormData) {
    startSave(async () => {
      try {
        const res = await saveEtsyCredentials(formData);
        if (!res.ok) {
          toast({ variant: "danger", title: "Not saved", description: res.message });
          return;
        }
        toast({ variant: "success", title: "Etsy keys saved", description: res.message });
        router.refresh();
      } catch {
        toast({ variant: "danger", title: "Not saved", description: "Could not save. Try again." });
      }
    });
  }

  const [backfillOpen, setBackfillOpen] = useState(false);
  function onBackfill() {
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
    ? formatAt(Number(shop.lastSyncCursor) * 1000, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }, "nothing yet")
    : "nothing yet";
  const cutoffDate = shop.backfillCutoffAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);

  return (
    <details className="group rounded-card bg-surface shadow-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{shop.name}</span>
            <span className="rounded bg-canvas px-1.5 py-0.5 text-xs font-medium uppercase text-slate">Etsy</span>
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
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="flex flex-col gap-4">
            <form action={onSaveCredentials} className="grid gap-3 rounded-input bg-canvas/70 p-3">
              <input type="hidden" name="shopId" value={shop.id} />
              <Input
                label="Keystring"
                name="keystring"
                placeholder={shop.hasKeystring ? "Saved. Type a new one to replace it" : "Etsy app keystring"}
                autoComplete="off"
                required
              />
              <Input
                label="Shared secret"
                name="sharedSecret"
                type="password"
                placeholder={shop.hasKeystring ? "Saved. Type a new one to replace it" : "Etsy app shared secret"}
                autoComplete="off"
                required
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="secondary" size="sm" loading={saving}>
                  Save credentials
                </Button>
                <a
                  href={`/api/etsy/connect?shopId=${shop.id}`}
                  aria-disabled={!shop.hasKeystring}
                  className={cn(
                    "inline-flex h-11 items-center justify-center rounded-input bg-pigment px-3 text-sm font-medium text-surface sm:h-8",
                    "transition-[opacity] motion-hover hover:opacity-90",
                    !shop.hasKeystring && "pointer-events-none opacity-50",
                  )}
                >
                  {shop.status === "connected" ? "Reconnect" : "Connect"}
                </a>
              </div>
            </form>

            <CutoffForm shopId={shop.id} cutoffDate={cutoffDate} />

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
                variant="secondary"
                size="sm"
                onClick={() => setBackfillOpen(true)}
                loading={backfilling}
                disabled={shop.status !== "connected"}
              >
                Re-import 60 days
              </Button>
              <ConfirmDrawer
                open={backfillOpen}
                onClose={() => setBackfillOpen(false)}
                onConfirm={onBackfill}
                title="Re-import 60 days"
                confirmLabel="Re-import"
              >
                <p className="text-sm text-slate">
                  This checks the shop for every order from the last 60 days and adds any that are missing. Orders from
                  before the cutoff come in as archived.
                </p>
              </ConfirmDrawer>
              <span className="text-xs text-slate">Shop ID {shop.etsyShopId ?? "not connected"} · last order seen {cursor}</span>
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
