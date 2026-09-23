"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, Input, Badge, useToast } from "@/components/ui";
import { ChevronDown } from "@/components/ui/icons";
import {
  saveGmailClient,
  triggerGmailPoll,
  setEmailSendingEnabled,
  setStageEmailAutoSend,
  sendGmailTest,
  type GmailTestResult,
} from "@/app/(app)/settings/actions";
import type { InboundSummary } from "@/lib/integrations/gmail";
import { STALE_AFTER_DAYS } from "@/lib/email/backlog-constants";

export type GmailBusinessVM = {
  businessId: string;
  name: string;
  hasClient: boolean;
  hasSecret: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  address: string | null;
  redirectUri: string;
  sendingEnabled: boolean;
  /** businesses.stage_email_auto_send: stage emails send by themselves instead of waiting in Emails. */
  stageAutoSend: boolean;
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
  const [stagePending, startStage] = useTransition();
  const [testTo, setTestTo] = useState("");
  const [testPending, startTest] = useTransition();
  const [testResult, setTestResult] = useState<GmailTestResult | null>(null);
  const status = STATUS[gmail.status];

  function onToggleSending() {
    startToggle(async () => {
      const turningOn = !gmail.sendingEnabled;
      const res = await setEmailSendingEnabled(gmail.businessId, turningOn);
      if (turningOn) {
        toast({
          variant: "success",
          title: "Customer email sending is on",
          description: res.skipped
            ? `Skipped ${res.skipped} stale unsent email${res.skipped === 1 ? "" : "s"}. They are in Emails, Waiting to send.`
            : "No stale emails to skip.",
        });
      }
      router.refresh();
    });
  }

  function onToggleStageAutoSend() {
    startStage(async () => {
      const turningOn = !gmail.stageAutoSend;
      await setStageEmailAutoSend(gmail.businessId, turningOn);
      toast({
        variant: "success",
        title: turningOn ? "Stage emails send by themselves" : "Stage emails wait for a VA",
        description: turningOn
          ? "New order received, in design, printing and shipped emails go out without approval."
          : "New stage emails are drafted in Emails for a VA to approve.",
      });
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
        setPollError(e instanceof Error ? e.message : "Could not check replies");
      }
    });
  }

  return (
    // Open by default: the two sending switches are what people come here for.
    <details className="group rounded-card bg-surface shadow-card" open>
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
            {gmail.sendingEnabled ? "On" : "Off"}
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
          <p className="w-full text-xs text-slate">
            {gmail.sendingEnabled
              ? "Customers get approved emails and the automatic ones (photo request, photo reminder). Turn off to stop every customer email."
              : `No email reaches a customer. When you turn it on, unsent emails for finished orders or older than ${STALE_AFTER_DAYS} days are held back; send or discard them in Messages.`}
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-input border border-line bg-canvas/70 px-3 py-2.5">
          <span className="text-sm font-medium text-ink">Order updates send by themselves</span>
          <Badge variant={gmail.stageAutoSend ? "success" : "neutral"} dot>
            {gmail.stageAutoSend ? "On" : "Off"}
          </Badge>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="ml-auto"
            loading={stagePending}
            onClick={onToggleStageAutoSend}
          >
            {gmail.stageAutoSend ? "Turn off" : "Turn on"}
          </Button>
          <p className="w-full text-xs text-slate">
            Order received, in the artist&apos;s hands, printing, shipped and the proof reminder.{" "}
            {gmail.stageAutoSend
              ? "They send without waiting for a VA (only while customer email is on)."
              : "They wait in Messages for a VA to approve. Best to start this way."}
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <form action={saveGmailClient} className="flex min-w-0 flex-col gap-3">
            <input type="hidden" name="businessId" value={gmail.businessId} />
            <Input
              label="OAuth client ID"
              name="clientId"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={gmail.hasClient ? "Saved. Type a new one to replace it" : "xxxxx.apps.googleusercontent.com"}
              autoComplete="off"
              required={!gmail.hasClient}
            />
            <Input
              label="OAuth client secret"
              name="clientSecret"
              type="password"
              placeholder={gmail.hasSecret ? "Saved. Leave blank to keep it" : "GOCSPX-..."}
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
                    ? "inline-flex h-11 items-center rounded-input border border-line bg-surface px-3 text-sm font-medium sm:h-8 text-ink hover:bg-canvas"
                    : "inline-flex h-11 items-center rounded-input border border-line bg-surface px-3 text-sm font-medium sm:h-8 text-slate opacity-50 pointer-events-none"
                }
              >
                {gmail.status === "connected" ? "Reconnect Gmail" : "Connect Gmail"}
              </a>
            </div>
            <p className="truncate text-xs text-slate">Redirect URI: {gmail.redirectUri}</p>
          </form>

          <div className="flex min-w-0 flex-col gap-3">
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

            <div className="rounded-input bg-canvas/70 p-3">
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
