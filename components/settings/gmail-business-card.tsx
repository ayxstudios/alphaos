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
import { saveGmailClient, triggerGmailPoll } from "@/app/(app)/settings/actions";
import type { InboundSummary } from "@/lib/integrations/gmail";

export type GmailBusinessVM = {
  businessId: string;
  name: string;
  hasClient: boolean;
  hasSecret: boolean;
  status: "connected" | "needs_reauth" | "not_connected";
  address: string | null;
  redirectUri: string;
};

const STATUS: Record<GmailBusinessVM["status"], { label: string; variant: "success" | "warning" | "neutral" }> = {
  connected: { label: "Connected", variant: "success" },
  needs_reauth: { label: "Needs re-auth", variant: "warning" },
  not_connected: { label: "Not connected", variant: "neutral" },
};

export function GmailBusinessCard({ gmail }: { gmail: GmailBusinessVM }) {
  const [clientId, setClientId] = useState("");
  const [address, setAddress] = useState(gmail.address ?? "");
  const [polling, startPoll] = useTransition();
  const [poll, setPoll] = useState<InboundSummary | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const status = STATUS[gmail.status];

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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{gmail.name}</CardTitle>
          <Badge variant={status.variant} dot>
            {status.label}
          </Badge>
        </div>
        <CardDescription>
          {gmail.address ? <>Sends from <span className="text-ink">{gmail.address}</span></> : "No sending address set"}
          {" · "}Redirect URI to whitelist: <code className="text-ink">{gmail.redirectUri}</code>
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form action={saveGmailClient} className="flex flex-col gap-3">
          <input type="hidden" name="businessId" value={gmail.businessId} />
          <Input
            label="OAuth client ID"
            name="clientId"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={gmail.hasClient ? "•••• (set — enter to replace)" : "xxxxx.apps.googleusercontent.com"}
            autoComplete="off"
            required={!gmail.hasClient}
          />
          <Input
            label="OAuth client secret"
            name="clientSecret"
            type="password"
            placeholder={gmail.hasSecret ? "•••••••• (set — leave blank to keep)" : "GOCSPX-..."}
            autoComplete="off"
            required={!gmail.hasSecret}
          />
          <Input
            label="Sending mailbox (orders@…)"
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
            {/* Connect is a server GET that redirects to Google, so use a link. */}
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
          {!gmail.hasClient && (
            <p className="text-xs text-slate">Save the client id/secret before connecting.</p>
          )}
        </form>
      </CardContent>

      <CardFooter className="flex-col items-start gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onPoll}
            loading={polling}
            disabled={gmail.status !== "connected"}
          >
            Check for replies
          </Button>
          <span className="text-xs text-slate">Runs the inbound poller once (normally scheduled).</span>
        </div>
        {pollError && <p className="text-sm text-rose">{pollError}</p>}
        {poll && (
          <p className="text-sm text-slate">
            {poll.skippedRun
              ? `Skipped: ${poll.skippedRun.replace("_", " ")}.`
              : `Attached ${poll.attached} repl${poll.attached === 1 ? "y" : "ies"}, skipped ${poll.skipped}.`}
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
