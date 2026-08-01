"use client";

import { useState, useTransition } from "react";

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
import {
  saveShopifyCredentials,
  testShopifyConnection,
  triggerShopifySync,
} from "@/app/(app)/settings/actions";
import type { SyncSummary } from "@/lib/integrations/shopify";

export type ShopifyShopVM = {
  id: string;
  name: string;
  hasToken: boolean;
  status: "connected" | "not_connected";
  shopDomain: string | null;
  lastSyncCursor: string | null;
  allowHeuristic: boolean;
  ruleCount: number;
};

export function ShopifyShopCard({ shop }: { shop: ShopifyShopVM }) {
  const [domain, setDomain] = useState(shop.shopDomain ?? "");
  const [token, setToken] = useState("");
  const [testing, startTest] = useTransition();
  const [syncing, startSync] = useTransition();
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  function onTest() {
    setTest(null);
    startTest(async () => {
      try {
        setTest(await testShopifyConnection(domain, token));
      } catch {
        setTest({ ok: false, message: "Test failed" });
      }
    });
  }

  function onSync() {
    setSyncError(null);
    setSummary(null);
    startSync(async () => {
      try {
        setSummary(await triggerShopifySync(shop.id));
      } catch (e) {
        setSyncError(e instanceof Error ? e.message : "Sync failed");
      }
    });
  }

  const lastSync = shop.lastSyncCursor
    ? new Date(shop.lastSyncCursor).toLocaleString()
    : "never";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{shop.name}</CardTitle>
          {shop.status === "connected" ? (
            <Badge variant="success" dot>Connected</Badge>
          ) : (
            <Badge variant="neutral" dot>Not connected</Badge>
          )}
        </div>
        <CardDescription>
          {shop.shopDomain ?? "no domain set"} · last sync {lastSync} ·{" "}
          {shop.ruleCount} figure rule{shop.ruleCount === 1 ? "" : "s"} · heuristic{" "}
          {shop.allowHeuristic ? "on" : "off"}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={saveShopifyCredentials} className="flex flex-col gap-3">
          <input type="hidden" name="shopId" value={shop.id} />
          <Input
            label="Store domain"
            name="shopDomain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="pixart.myshopify.com"
            autoComplete="off"
            required
          />
          <Input
            label="Admin API access token"
            name="accessToken"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={shop.hasToken ? "•••••••• (set — enter to replace)" : "shpat_..."}
            autoComplete="off"
            required
          />
          <Input
            label="Webhook secret (custom app API secret key)"
            name="webhookSecret"
            type="password"
            placeholder={shop.hasToken ? "•••••••• (set — enter to replace)" : "Signs webhook HMAC"}
            autoComplete="off"
            required
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={onTest} loading={testing}>
              Test connection
            </Button>
            <Button type="submit" size="sm">
              Save credentials
            </Button>
          </div>
          {test && (
            <p className={test.ok ? "text-sm text-sage" : "text-sm text-rose"}>{test.message}</p>
          )}
        </form>
      </CardContent>

      <CardFooter className="flex-col items-start gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onSync}
            loading={syncing}
            disabled={shop.status !== "connected"}
          >
            Sync now
          </Button>
          <span className="text-xs text-slate">
            Webhook endpoint: <code className="text-ink">/api/shopify/webhook</code> (register
            orders/create)
          </span>
        </div>
        {syncError && <p className="text-sm text-rose">{syncError}</p>}
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
