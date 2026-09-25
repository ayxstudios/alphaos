"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button, ConfirmDrawer, Input, Badge, useToast } from "@/components/ui";
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
  /** businesses.stage_email_auto_send: order updates send by themselves instead of waiting in Messages. */
  stageAutoSend: boolean;
};

const STATUS: Record<GmailBusinessVM["status"], { label: string; variant: "success" | "warning" | "neutral" }> = {
  connected: { label: "Connected", variant: "success" },
  needs_reauth: { label: "Needs reconnecting", variant: "warning" },
  not_connected: { label: "Not connected", variant: "neutral" },
};

/** The order updates that follow the "send by themselves" switch, named once. */
const ORDER_UPDATES = "Order received, in the artist's hands, printing, shipped and the proof reminder.";

export function GmailBusinessCard({ gmail }: { gmail: GmailBusinessVM }) {
  const router = useRouter();
  const toast = useToast();
  const [clientId, setClientId] = useState("");
  const [address, setAddress] = useState(gmail.address ?? "");
  const [saving, startSave] = useTransition();
  const [polling, startPoll] = useTransition();
  const [poll, setPoll] = useState<InboundSummary | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [togglePending, startToggle] = useTransition();
  const [stagePending, startStage] = useTransition();
  const [confirmOn, setConfirmOn] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testPending, startTest] = useTransition();
  const [testResult, setTestResult] = useState<GmailTestResult | null>(null);
  const status = STATUS[gmail.status];
  const connected = gmail.status === "connected";

  function onSaveClient(formData: FormData) {
    startSave(async () => {
      const res = await saveGmailClient(formData);
      if (!res.ok) {
        toast({ variant: "danger", title: "Not saved", description: res.message });
        return;
      }
      setClientId("");
      toast({ variant: "success", title: "Gmail keys saved", description: res.message });
      router.refresh();
    });
  }

  function turnSending(on: boolean) {
    startToggle(async () => {
      try {
        const res = await setEmailSendingEnabled(gmail.businessId, on);
        if (on) {
          const held = res.skipped + res.heldFromQueue;
          toast({
            variant: "success",
            title: "Customer email sending is on",
            description: held
              ? `${held} older unsent email${held === 1 ? " was" : "s were"} held back. Send or discard ${held === 1 ? "it" : "them"} in Messages, under Waiting to send.`
              : "Nothing older was waiting, so nothing was held back.",
          });
        } else {
          toast({
            variant: "success",
            title: "Customer email sending is off",
            description: "No email reaches a customer until you turn it on again.",
          });
        }
        router.refresh();
      } catch {
        toast({ variant: "danger", title: "Could not change sending", description: "Try again in a moment." });
      }
    });
  }

  function onToggleSending() {
    if (gmail.sendingEnabled) turnSending(false);
    else setConfirmOn(true);
  }

  function onToggleStageAutoSend() {
    startStage(async () => {
      const turningOn = !gmail.stageAutoSend;
      try {
        await setStageEmailAutoSend(gmail.businessId, turningOn);
        toast({
          variant: "success",
          title: turningOn ? "Order updates send by themselves" : "Order updates wait for a VA",
          description: turningOn
            ? `${ORDER_UPDATES} They go out without approval, while customer email sending is on.`
            : `${ORDER_UPDATES} They wait in Messages for a VA to approve.`,
        });
        router.refresh();
      } catch {
        toast({ variant: "danger", title: "Could not change order updates", description: "Try again in a moment." });
      }
    });
  }

  function onSendTest() {
    setTestResult(null);
    startTest(async () => {
      try {
        const res = await sendGmailTest(gmail.businessId, testTo);
        setTestResult(res);
        toast({
          variant: res.ok ? "success" : "danger",
          title: res.ok ? "Test emails sent" : "Some test emails did not send",
          description: res.message,
        });
      } catch {
        toast({ variant: "danger", title: "Could not send the test", description: "Try again in a moment." });
      }
    });
  }

  function onPoll() {
    setPoll(null);
    setPollError(null);
    startPoll(async () => {
      try {
        const res = await triggerGmailPoll(gmail.businessId);
        if (res.ok) setPoll(res.data);
        else setPollError(res.message);
      } catch {
        setPollError("Could not check replies. Try again in a moment.");
      }
    });
  }

  const pollText = poll
    ? poll.skippedRun === "not_connected"
      ? "Connect Gmail first."
      : poll.skippedRun
        ? "Already checking this mailbox. Try again in a minute."
        : `${poll.attached} customer repl${poll.attached === 1 ? "y" : "ies"} matched to orders; ${poll.skipped} ${poll.skipped === 1 ? "was" : "were"} not about an order.`
    : null;

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
          <p className="mt-1 text-xs text-slate [overflow-wrap:anywhere]">{gmail.address ?? "No mailbox set"}</p>
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
            disabled={!gmail.sendingEnabled && !connected}
            onClick={onToggleSending}
          >
            {gmail.sendingEnabled ? "Turn off" : "Turn on"}
          </Button>
          <p className="w-full text-xs text-slate">
            {gmail.sendingEnabled
              ? "Customers get approved emails and the automatic ones (photo request, photo reminder). Turn off to stop every customer email."
              : connected
                ? `No email reaches a customer. When you turn it on, unsent emails for finished orders or older than ${STALE_AFTER_DAYS} days are held back; send or discard them in Messages.`
                : "No email reaches a customer. Connect Gmail below before turning it on."}
          </p>
        </div>

        <ConfirmDrawer
          open={confirmOn}
          onClose={() => setConfirmOn(false)}
          onConfirm={() => turnSending(true)}
          title="Turn on customer email"
          confirmLabel="Turn on"
        >
          <p className="text-sm text-slate">
            Real customers start getting email from {gmail.address ?? "this mailbox"}: approved replies, proofs, and the
            automatic photo request and reminder.
          </p>
          <p className="text-sm text-slate">
            Unsent emails for finished orders, or older than {STALE_AFTER_DAYS} days, are held back so nobody gets an
            out-of-date message. You can send or discard them in Messages.
          </p>
        </ConfirmDrawer>

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
            {ORDER_UPDATES}{" "}
            {gmail.stageAutoSend
              ? "They send without waiting for a VA."
              : "They wait in Messages for a VA to approve. Best to start this way."}
            {!gmail.sendingEnabled && " Nothing sends while customer email sending is off."}
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <form action={onSaveClient} className="flex min-w-0 flex-col gap-3">
            <input type="hidden" name="businessId" value={gmail.businessId} />
            <Input
              label="Google client ID"
              name="clientId"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={gmail.hasClient ? "Saved. Type a new one to replace it" : "xxxxx.apps.googleusercontent.com"}
              autoComplete="off"
              required={!gmail.hasClient}
            />
            <Input
              label="Google client secret"
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
              <Button type="submit" size="sm" loading={saving}>
                Save keys
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
                {connected ? "Reconnect Gmail" : "Connect Gmail"}
              </a>
              {!gmail.hasClient && <span className="text-xs text-slate">Save the keys first.</span>}
            </div>
            <p className="text-xs text-slate">
              In Google Cloud, add this as the sign-in return address:
              <code className="mt-1 block text-ink [overflow-wrap:anywhere]">{gmail.redirectUri}</code>
            </p>
          </form>

          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={onPoll} loading={polling} disabled={!connected}>
                Check replies now
              </Button>
              {!connected && <span className="text-xs text-slate">Connect Gmail first.</span>}
              {pollError && (
                <span role="alert" className="text-sm text-rose">
                  {pollError}
                </span>
              )}
              {pollText && (
                <span role="status" className="text-sm text-slate">
                  {pollText}
                </span>
              )}
            </div>

            <div className="rounded-input bg-canvas/70 p-3">
              <p className="text-sm font-medium text-ink">Send test emails</p>
              <p className="mt-0.5 text-xs text-slate">
                Every template goes to one address you choose, with sample details. Nothing goes to a customer.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="w-full sm:w-64">
                  <Input
                    type="email"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder="you@yourdomain.com"
                    autoComplete="off"
                    className="h-11 sm:h-9"
                    aria-label="Send test emails to"
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={onSendTest}
                  loading={testPending}
                  disabled={!connected || !testTo.trim()}
                >
                  Send test
                </Button>
                {!connected && <span className="text-xs text-slate">Connect Gmail first.</span>}
              </div>
              {testResult && (
                <ul role="status" className="mt-2 flex flex-col gap-0.5 text-xs">
                  {testResult.results.map((r) => (
                    <li key={r.key} className={r.ok ? "text-sage" : "text-rose"}>
                      {r.ok ? "Sent: " : "Not sent: "}
                      {r.label}
                      {r.error ? ` (${r.error})` : ""}
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
