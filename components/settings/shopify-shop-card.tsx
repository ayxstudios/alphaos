"use client";

import { useState, useTransition } from "react";

import {
  Button,
  Input,
  Select,
  Badge,
  InfoBubble,
} from "@/components/ui";
import { ChevronDown } from "@/components/ui/icons";
import {
  saveShopifyCredentials,
  testShopifyConnection,
  triggerShopifySync,
  backfillShopifyShop,
  registerShopifyWebhooks,
  saveShopBackfillCutoff,
} from "@/app/(app)/settings/actions";
import { ResolutionRulesEditor } from "@/components/settings/resolution-rules-editor";
import { formatSyncTime, syncHealth } from "@/lib/integrations/sync-health";
import type { ShopifyWebhookStatus, SyncSummary } from "@/lib/integrations/shopify";
import type { FigureRule } from "@/lib/integrations/figures";

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
  lastSyncAt: string | null;
  backfillCutoffAt: string | null;
  webhookStatus: ShopifyWebhookStatus;
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
  const [registeringWebhooks, startWebhookRegistration] = useTransition();
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [webhookStatus, setWebhookStatus] = useState<ShopifyWebhookStatus>(shop.webhookStatus);
  const [webhookError, setWebhookError] = useState<string | null>(shop.webhookStatus.error ?? null);

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
    if (!confirm("Backfill re-scans the last 60 days. Orders before the cutoff import as archived and no customer emails are sent. Continue?")) return;
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

  function onRegisterWebhooks() {
    setWebhookError(null);
    startWebhookRegistration(async () => {
      try {
        setWebhookStatus(await registerShopifyWebhooks(shop.id));
      } catch (e) {
        setWebhookError(e instanceof Error ? e.message : "Webhook registration failed");
      }
    });
  }

  const health = syncHealth(shop.lastSyncAt);
  const lastSync = formatSyncTime(shop.lastSyncAt);
  const cursor = shop.lastSyncCursor ? new Date(shop.lastSyncCursor).toLocaleString() : "none";
  const cutoffDate = shop.backfillCutoffAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const webhookUris = webhookStatus.subscriptions
    .map((sub) => sub.uri)
    .filter((uri): uri is string => !!uri);

  return (
    <details className="group rounded-card border border-line bg-surface shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{shop.name}</span>
            <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] font-medium uppercase text-slate">Shopify</span>
            {shop.status === "connected" ? (
              <Badge variant="success" dot>Connected</Badge>
            ) : (
              <Badge variant="neutral" dot>Not connected</Badge>
            )}
            {health !== "ok" && (
              <Badge variant="warning" dot>
                Sync {health === "never" ? "never run" : "stale"}
              </Badge>
            )}
            {!webhookStatus.pointingCorrectly && (
              <Badge variant="danger" dot>Webhook missing</Badge>
            )}
          </div>
        </div>
        <span className="hidden text-sm text-slate sm:inline">Last sync {lastSync}</span>
        <ChevronDown size={16} className="text-slate transition-transform group-open:rotate-180" />
      </summary>

      <div className="border-t border-line p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="flex flex-col gap-4">
            <form action={saveShopifyCredentials} className="grid gap-3 rounded-input border border-line bg-canvas p-3">
              <input type="hidden" name="shopId" value={shop.id} />
              <input type="hidden" name="authType" value={mode} />

              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-slate">App type</span>
                <InfoBubble label="Shopify app type">
                  Use Client ID + secret for the new Shopify Dev Dashboard app. Legacy is only for old permanent-token custom apps.
                </InfoBubble>
              </div>
              <Select
                value={mode}
                onChange={(e) => setMode(e.target.value as AuthMode)}
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
                    placeholder={shop.hasClientId ? "Set - enter to replace" : "Client ID"}
                    autoComplete="off"
                    required={!shop.hasClientId}
                  />
                  <Input
                    label="Client secret"
                    name="clientSecret"
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder={shop.hasClientSecret ? "Set - leave blank to keep" : "Client secret"}
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
                    placeholder={shop.hasToken ? "Set - leave blank to keep" : "shpat_..."}
                    autoComplete="off"
                    required={!shop.hasToken}
                  />
                  <Input
                    label="Webhook secret"
                    name="webhookSecret"
                    type="password"
                    value={webhookSecret}
                    onChange={(e) => setWebhookSecret(e.target.value)}
                    placeholder={shop.hasWebhookSecret ? "Set - leave blank to keep" : "Webhook secret"}
                    autoComplete="off"
                    required={!shop.hasWebhookSecret}
                  />
                </>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={onTest} loading={testing}>
                  Test
                </Button>
                <Button type="submit" size="sm">
                  Save credentials
                </Button>
              </div>
              {test && (
                <p className={test.ok ? "text-sm text-sage" : "text-sm text-rose"}>{test.message}</p>
              )}
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

            <div className="rounded-input border border-line bg-canvas p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">Webhook</p>
                  <p className="truncate text-xs text-slate">
                    {webhookStatus.pointingCorrectly ? "Registered" : "Not pointing at AlphaOS"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onRegisterWebhooks}
                  loading={registeringWebhooks}
                  disabled={shop.status !== "connected"}
                >
                  Register webhooks
                </Button>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-pigment">Show URLs</summary>
                <p className="mt-2 break-all text-xs text-slate">Expected: {webhookStatus.expectedUrl}</p>
                <p className="mt-1 break-all text-xs text-slate">
                  Current: {webhookUris.length ? webhookUris.join(", ") : "not registered"}
                </p>
              </details>
              {webhookError && <p className="mt-2 text-sm text-rose">{webhookError}</p>}
            </div>

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
              >
                Backfill 60d
              </Button>
              <span className="text-xs text-slate">{shop.shopDomain ?? "No domain"} · cursor {cursor}</span>
            </div>
            {syncError && <p className="text-sm text-rose">{syncError}</p>}
            {summary && (
              <p className="text-sm text-slate">
                {summary.skippedRun
                  ? `Sync skipped: ${summary.skippedRun.replace("_", " ")}.`
                  : `Imported ${summary.imported} new` +
                    (summary.archived ? `, archived ${summary.archived}` : "") +
                    (summary.failed ? `, ${summary.failed} failed` : "") +
                    ` · ${summary.total ?? "?"} total` +
                    (summary.windowDays ? ` · covering last ${summary.windowDays} days.` : ".")}
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
