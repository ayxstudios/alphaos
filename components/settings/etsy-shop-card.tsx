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
import { saveEtsyCredentials, triggerSync } from "@/app/(app)/settings/actions";
import type { SyncSummary } from "@/lib/integrations/etsy";

export type EtsyShopVM = {
  id: string;
  name: string;
  hasKeystring: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  etsyShopId: string | null;
  lastSyncCursor: string | null;
  allowHeuristic: boolean;
  ruleCount: number;
};

function StatusBadge({ status }: { status: EtsyShopVM["status"] }) {
  if (status === "connected") return <Badge variant="success" dot>Connected</Badge>;
  if (status === "needs_reauth") return <Badge variant="danger" dot>Needs reauth</Badge>;
  return <Badge variant="neutral" dot>Not connected</Badge>;
}

export function EtsyShopCard({ shop }: { shop: EtsyShopVM }) {
  const [pending, startTransition] = useTransition();
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
