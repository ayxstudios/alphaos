"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Input, Badge, useToast } from "@/components/ui";
import { ChevronDown } from "@/components/ui/icons";
import {
  saveGmailClient,
  triggerGmailPoll,
  setEmailSendingEnabled,
  sendGmailTest,
  type GmailTestResult,
} from "@/app/(app)/settings/actions";
import type { InboundSummary } from "@/lib/integrations/gmail";

export type GmailBusinessVM = {
  businessId: string;
  name: string;
  hasClient: boolean;
  hasSecret: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  address: string | null;
  redirectUri: string;
  sendingEnabled: boolean;
};

const STATUS: Record<GmailBusinessVM["status"], { label: string; variant: "success" | "warning" | "neutral" }> = {
  connected: { label: "Connected", variant: "success" },
  needs_reauth: { label: "Needs re-auth", variant: "warning" },
  not_connected: { label: "Not connected", variant: "neutral" },
};

export function GmailBusinessCard({ gmail }: { gmail: GmailBusinessVM }) {
  const router = useRouter();
  const toast = useToast();
  const [clientId, setClientId] = useState("");
  const [address, setAddress] = useState(gmail.address ?? "");
  const [polling, startPoll] = useTransition();
  const [poll, setPoll] = useState<InboundSummary | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [togglePending, startToggle] = useTransition();
  const [testTo, setTestTo] = useState("");
  const [testPending, startTest] = useTransition();
  const [testResult, setTestResult] = useState<GmailTestResult | null>(null);
  const status = STATUS[gmail.status];

  function onToggleSending() {
    startToggle(async () => {
      await setEmailSendingEnabled(gmail.businessId, !gmail.sendingEnabled);
      router.refresh();
    });
  }

  function onSendTest() {
    setTestResult(null);
    startTest(async () => {
      const res = await sendGmailTest(gmail.businessId, testTo);
      setTestResult(res);
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? "Test email sent" : "Test failed",
        description: res.message,
      });
    });
  }

  function onPoll() {
    setPoll(null);
    setPollError(null);
    startPoll(async () => {
      try {
        setPoll(await triggerGmailPoll(gmail.businessId));
      } catch (e) {
        setPollError(e instanceof Error ? e.message : "Poll failed");
      }
    });
  }

  return (
    <details className="group rounded-card border border-line bg-surface shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{gmail.name}</span>
            <Badge variant={status.variant} dot>
              {status.label}
            </Badge>
            <Badge variant={gmail.sendingEnabled ? "success" : "warning"} dot>
              Sending {gmail.sendingEnabled ? "on" : "off"}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-slate">{gmail.address ?? "No mailbox set"}</p>
        </div>
        <ChevronDown size={16} className="text-slate transition-transform group-open:rotate-180" />
      </summary>

      <div className="border-t border-line p-4">
        <div
          className={
            gmail.sendingEnabled
              ? "mb-4 flex flex-wrap items-center gap-2 rounded-input border border-sage/25 bg-sage/5 px-3 py-2.5"
              : "mb-4 flex flex-wrap items-center gap-2 rounded-input border border-amber/30 bg-amber/5 px-3 py-2.5"
          }
        >
          <span className="text-sm font-medium text-ink">Customer email sending</span>
          <Badge variant={gmail.sendingEnabled ? "success" : "warning"} dot>
            {gmail.sendingEnabled ? "ON" : "OFF"}
          </Badge>
          <Button
            type="button"
            size="sm"
            variant={gmail.sendingEnabled ? "secondary" : "primary"}
            className="ml-auto"
            loading={togglePending}
            onClick={onToggleSending}
          >
            {gmail.sendingEnabled ? "Turn off" : "Turn on"}
          </Button>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <form action={saveGmailClient} className="flex flex-col gap-3">
            <input type="hidden" name="businessId" value={gmail.businessId} />
            <Input
              label="OAuth client ID"
              name="clientId"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={gmail.hasClient ? "Set - enter to replace" : "xxxxx.apps.googleusercontent.com"}
              autoComplete="off"
              required={!gmail.hasClient}
            />
            <Input
              label="OAuth client secret"
              name="clientSecret"
              type="password"
              placeholder={gmail.hasSecret ? "Set - leave blank to keep" : "GOCSPX-..."}
              autoComplete="off"
              required={!gmail.hasSecret}
            />
            <Input
              label="Sending mailbox"
              name="address"
              type="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="orders@yourbusiness.com"
              autoComplete="off"
              required
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm">
                Save client
              </Button>
              <a
                href={gmail.hasClient ? `/api/gmail/connect?businessId=${gmail.businessId}` : undefined}
                aria-disabled={!gmail.hasClient}
                className={
                  gmail.hasClient
                    ? "inline-flex h-8 items-center rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas"
                    : "inline-flex h-8 items-center rounded-input border border-line bg-surface px-3 text-sm font-medium text-slate opacity-50 pointer-events-none"
                }
              >
                {gmail.status === "connected" ? "Reconnect Gmail" : "Connect Gmail"}
              </a>
            </div>
            <p className="truncate text-xs text-slate">Redirect URI: {gmail.redirectUri}</p>
          </form>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onPoll}
                loading={polling}
                disabled={gmail.status !== "connected"}
              >
                Check replies
              </Button>
              {pollError && <span className="text-sm text-rose">{pollError}</span>}
              {poll && (
                <span className="text-sm text-slate">
                  {poll.skippedRun
                    ? `Skipped: ${poll.skippedRun.replace("_", " ")}.`
                    : `Attached ${poll.attached}, skipped ${poll.skipped}.`}
                </span>
              )}
            </div>

            <div className="rounded-input border border-line bg-canvas p-3">
              <p className="text-sm font-medium text-ink">Send test email</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input
                  type="email"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="you@yourdomain.com"
                  autoComplete="off"
                  className="h-9 w-64"
                  aria-label="Test recipient address"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={onSendTest}
                  loading={testPending}
                  disabled={gmail.status !== "connected" || !testTo.trim()}
                >
                  Send test
                </Button>
              </div>
              {testResult && (
                <ul className="mt-2 flex flex-col gap-0.5 text-xs">
                  {testResult.results.map((r) => (
                    <li key={r.key} className={r.ok ? "text-sage" : "text-rose"}>
                      {r.ok ? "OK" : "Failed"} {r.label}
                      {r.error ? ` - ${r.error}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </details>
  );
}
