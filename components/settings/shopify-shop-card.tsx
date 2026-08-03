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
  Select,
  Badge,
} from "@/components/ui";
import {
  saveShopifyCredentials,
  testShopifyConnection,
  triggerShopifySync,
  backfillShopifyShop,
} from "@/app/(app)/settings/actions";
import { ResolutionRulesEditor } from "@/components/settings/resolution-rules-editor";
import type { SyncSummary } from "@/lib/integrations/shopify";
import type { FigureRule, StyleRule } from "@/lib/integrations/figures";

type AuthMode = "client_credentials" | "legacy";

export type ShopifyShopVM = {
  id: string;
  name: string;
  authType: AuthMode;
  status: "connected" | "not_connected";
  shopDomain: string | null;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasToken: boolean;
  hasWebhookSecret: boolean;
  lastSyncCursor: string | null;
  allowHeuristic: boolean;
  ruleCount: number;
  figureRules: FigureRule[];
  styleRules: StyleRule[];
  optionNames: string[];
};

const MODE_LABEL: Record<AuthMode, string> = {
  client_credentials: "New app (Client ID + secret)",
  legacy: "Legacy (permanent token)",
};

export function ShopifyShopCard({ shop }: { shop: ShopifyShopVM }) {
  const [mode, setMode] = useState<AuthMode>(shop.authType);
  const [domain, setDomain] = useState(shop.shopDomain ?? "");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [testing, startTest] = useTransition();
  const [syncing, startSync] = useTransition();
  const [backfilling, startBackfill] = useTransition();
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  function onTest() {
    setTest(null);
    startTest(async () => {
      try {
        setTest(
          await testShopifyConnection({
            shopId: shop.id,
            authType: mode,
            domain,
            clientId,
            clientSecret,
            accessToken,
          }),
        );
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

  function onBackfill() {
    if (!confirm("Backfill re-scans the last 60 days with NO customer emails sent. Continue?")) return;
    setSyncError(null);
    setSummary(null);
    startBackfill(async () => {
      try {
        setSummary(await backfillShopifyShop(shop.id));
      } catch (e) {
        setSyncError(e instanceof Error ? e.message : "Backfill failed");
      }
    });
  }

  const lastSync = shop.lastSyncCursor ? new Date(shop.lastSyncCursor).toLocaleString() : "never";

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
          {shop.shopDomain ?? "no domain set"} · {MODE_LABEL[shop.authType]} · last sync {lastSync} ·{" "}
          {shop.ruleCount} figure rule{shop.ruleCount === 1 ? "" : "s"} · heuristic{" "}
          {shop.allowHeuristic ? "on" : "off"}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <form action={saveShopifyCredentials} className="flex flex-col gap-3">
          <input type="hidden" name="shopId" value={shop.id} />
          <input type="hidden" name="authType" value={mode} />

          <Select
            label="App type"
            value={mode}
            onChange={(e) => setMode(e.target.value as AuthMode)}
            hint={
              mode === "client_credentials"
                ? "Dev Dashboard app: a Client ID + secret exchanged for a short-lived token. The client secret also verifies webhooks."
                : "Deprecated admin custom app: a permanent access token plus a separate webhook secret."
            }
          >
            <option value="client_credentials">{MODE_LABEL.client_credentials}</option>
            <option value="legacy">{MODE_LABEL.legacy}</option>
          </Select>

          <Input
            label="Store domain"
            name="shopDomain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="pixart.myshopify.com"
            autoComplete="off"
            required
          />

          {mode === "client_credentials" ? (
            <>
              <Input
                label="Client ID"
                name="clientId"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={shop.hasClientId ? "•••••••• (set — enter to replace)" : "Client ID from the Dev Dashboard"}
                autoComplete="off"
                required={!shop.hasClientId}
              />
              <Input
                label="Client secret"
                name="clientSecret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={shop.hasClientSecret ? "•••••••• (set — leave blank to keep)" : "Also signs webhook HMAC"}
                autoComplete="off"
                required={!shop.hasClientSecret}
              />
            </>
          ) : (
            <>
              <Input
                label="Admin API access token"
                name="accessToken"
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={shop.hasToken ? "•••••••• (set — leave blank to keep)" : "shpat_..."}
                autoComplete="off"
                required={!shop.hasToken}
              />
              <Input
                label="Webhook secret (custom app API secret key)"
                name="webhookSecret"
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={shop.hasWebhookSecret ? "•••••••• (set — leave blank to keep)" : "Signs webhook HMAC"}
                autoComplete="off"
                required={!shop.hasWebhookSecret}
              />
            </>
          )}

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

        <ResolutionRulesEditor
          shopId={shop.id}
          initialFigureRules={shop.figureRules}
          initialStyleRules={shop.styleRules}
          optionNames={shop.optionNames}
        />
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
              : `Imported ${summary.imported} new` +
                (summary.failed ? `, ${summary.failed} failed` : "") +
                ` · ${summary.total ?? "?"} total` +
                (summary.windowDays ? ` · covering last ${summary.windowDays} days.` : ".")}
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
