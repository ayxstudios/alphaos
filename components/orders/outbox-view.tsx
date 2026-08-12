"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Input, Textarea, useToast } from "@/components/ui";
import { AlertTriangle, Inbox, Mail } from "@/components/ui/icons";
import type { OutboxItem, UnmatchedReply } from "@/lib/email/outbox";
import {
  approveAndSend,
  updateDraftBody,
  discardDraft,
  markEmailSentManually,
  linkReplyToOrder,
  archiveReply,
  searchOrdersForLink,
  type OutboxActionResult,
} from "@/app/(app)/orders/outbox-actions";

const DAY_MS = 24 * 60 * 60 * 1000;

function formatAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function fmtDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function OutboxView({
  outbox,
  unmatched,
  sendingEnabled,
  businessId,
}: {
  outbox: OutboxItem[];
  unmatched: UnmatchedReply[];
  sendingEnabled: boolean;
  businessId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  function run(action: () => Promise<OutboxActionResult>) {
    start(async () => {
      const res = await action();
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? res.message ?? "Done" : "Couldn't complete",
        description: res.ok ? undefined : res.message,
      });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {!sendingEnabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-amber/30 bg-amber/5 px-4 py-3 text-sm">
          <AlertTriangle size={16} className="text-amber" />
          <span className="font-medium text-ink">Email sending is OFF for this workspace.</span>
          <span className="text-slate">Drafts can be reviewed and edited, but sends are blocked until you enable sending.</span>
          <Link href="/settings" className="ml-auto font-medium text-pigment hover:text-ink">Open Settings</Link>
        </div>
      )}

      {/* Unmatched replies — oldest first, longest wait most urgent. */}
      {unmatched.length > 0 && (
        <div className="rounded-card border border-rose/25 bg-rose/[0.03] p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <Inbox size={16} className="text-rose" />
            <h2 className="text-base font-semibold text-ink">Unmatched replies</h2>
            <Badge variant="danger">{unmatched.length}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-slate">
            Replies we couldn&apos;t thread to an order. A customer is waiting — link each to its order, or archive it.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {unmatched.map((r) => (
              <ReplyCard key={r.messageId} reply={r} businessId={businessId} run={run} pending={pending} />
            ))}
          </div>
        </div>
      )}

      {/* Drafts, failed sends, and system-queued email. */}
      <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Mail size={16} className="text-slate" />
          <h2 className="text-base font-semibold text-ink">Outbox</h2>
          {outbox.length > 0 && <Badge variant="neutral">{outbox.length}</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-slate">
          Customer emails waiting for review, retry, or system send. Queued messages are read-only but can be discarded.
        </p>
        {outbox.length === 0 ? (
          <p className="mt-3 text-sm text-slate">Nothing waiting to send.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {outbox.map((item) => (
              <DraftCard key={item.messageId} item={item} sendingEnabled={sendingEnabled} run={run} pending={pending} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DraftCard({
  item,
  sendingEnabled,
  run,
  pending,
}: {
  item: OutboxItem;
  sendingEnabled: boolean;
  run: (action: () => Promise<OutboxActionResult>) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(item.body);
  const [discarding, setDiscarding] = useState(false);
  const [manualSent, setManualSent] = useState(false);
  const [reason, setReason] = useState("");
  const [manualReason, setManualReason] = useState("");
  const queued = item.status === "queued";

  function send() {
    run(async () => {
      if (body !== item.body) {
        const upd = await updateDraftBody(item.messageId, body);
        if (!upd.ok) return upd;
      }
      return approveAndSend(item.messageId);
    });
  }

  return (
    <div className="rounded-input border border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left"
      >
        {item.templateLabel && <Badge variant="info">{item.templateLabel}</Badge>}
        {queued && <Badge variant="warning" dot>System queued</Badge>}
        {item.status === "failed" && <Badge variant="danger" dot>Failed</Badge>}
        <span className="min-w-0 truncate text-sm font-medium text-ink">{item.subject || "(no subject)"}</span>
        <span className="ml-auto text-xs text-slate">
          {item.customerName ?? item.toAddress ?? "—"}
          {item.orderNumber ? ` · ${item.orderNumber}` : ""} · {fmtDateTime(item.createdAt)}
        </span>
      </button>
      {open && (
        <div className="border-t border-line p-3">
          {/* Rendered as the customer sees it. */}
          <div className="rounded-input border border-line bg-canvas p-3 text-sm">
            <p className="text-xs text-slate">To: <span className="text-ink">{item.toAddress ?? "—"}</span></p>
            <p className="text-xs text-slate">Subject: <span className="font-medium text-ink">{item.subject}</span></p>
          </div>
          {item.status === "failed" && item.error && (
            <p className="mt-2 text-xs text-rose">Last error: {item.error}</p>
          )}
          {queued ? (
            <div className="mt-2 rounded-input border border-amber/25 bg-amber/5 p-3">
              <p className="text-xs font-medium text-ink">System-queued email</p>
              <p className="mt-1 text-xs text-slate">
                This was queued by an automated workflow and will be sent by the next Gmail poll cron run. It is read-only.
              </p>
              <p className="mt-3 whitespace-pre-wrap rounded-input border border-line bg-surface p-3 font-mono text-xs text-ink">
                {item.body || "(empty)"}
              </p>
            </div>
          ) : (
            <Textarea
              label="Body (editable before sending)"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="mt-2 font-mono text-xs"
            />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!queued && (
              <>
                <Button type="button" size="sm" onClick={send} loading={pending} disabled={!sendingEnabled}>
                  {item.status === "failed" ? "Retry send" : "Approve & send"}
                </Button>
                {!sendingEnabled && <span className="text-xs text-amber">Sending is OFF — enable it in Settings.</span>}
              </>
            )}
            {item.orderId && (
              <Link href={`/orders/${item.orderId}`} className="text-sm font-medium text-pigment hover:text-ink">
                Open order
              </Link>
            )}
            {!queued && !manualSent && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setManualSent(true)}>
                Mark sent manually
              </Button>
            )}
            {!discarding ? (
              <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setDiscarding(true)}>
                Discard
              </Button>
            ) : (
              <div className="ml-auto flex items-center gap-2">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (required)"
                  aria-label="Discard reason"
                  className="h-8 w-48"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={!reason.trim()}
                  onClick={() => run(() => discardDraft(item.messageId, reason))}
                >
                  Confirm discard
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDiscarding(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
          {manualSent && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-input border border-line bg-canvas p-2">
              <Input
                value={manualReason}
                onChange={(e) => setManualReason(e.target.value)}
                placeholder="Manual send reason (required)"
                aria-label="Manual send reason"
                className="h-8 w-72"
              />
              <Button
                type="button"
                size="sm"
                disabled={!manualReason.trim()}
                onClick={() => run(() => markEmailSentManually(item.messageId, manualReason))}
              >
                Confirm manual send
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setManualSent(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReplyCard({
  reply,
  businessId,
  run,
  pending,
}: {
  reply: UnmatchedReply;
  businessId: string;
  run: (action: () => Promise<OutboxActionResult>) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ orderId: string; orderNumber: string; customerName: string | null }[]>([]);
  const [searching, startSearch] = useTransition();
  const [archiving, setArchiving] = useState(false);
  const [reason, setReason] = useState("");
  const stale = reply.ageMs > DAY_MS;

  function search(term: string) {
    setQ(term);
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    startSearch(async () => setResults(await searchOrdersForLink(businessId, term)));
  }

  return (
    <div className="rounded-input border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <Badge variant={stale ? "danger" : "warning"} dot>
          Waiting {formatAge(reply.ageMs)}
          {stale ? " · over 24h" : ""}
        </Badge>
        <span className="min-w-0 truncate text-sm font-medium text-ink">{reply.subject || "(no subject)"}</span>
        <span className="text-xs text-slate">{reply.fromAddress ?? "unknown sender"}</span>
        <button type="button" onClick={() => setOpen((o) => !o)} className="ml-auto text-sm font-medium text-pigment hover:text-ink">
          {open ? "Hide" : "View"}
        </button>
      </div>
      {open && (
        <div className="border-t border-line p-3">
          <p className="whitespace-pre-wrap rounded-input border border-line bg-canvas p-3 text-sm text-ink">{reply.body || "(empty)"}</p>

          {reply.suggestion && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-input border border-pigment/20 bg-pigment-soft/40 p-2.5 text-sm">
              <span className="text-ink">
                Looks like order <strong>{reply.suggestion.orderNumber}</strong> ({reply.suggestion.customerName})
              </span>
              <Button
                type="button"
                size="sm"
                className="ml-auto"
                loading={pending}
                onClick={() => run(() => linkReplyToOrder(reply.messageId, reply.suggestion!.orderId))}
              >
                Link to {reply.suggestion.orderNumber}
              </Button>
            </div>
          )}

          <div className="mt-3">
            <p className="text-xs font-medium text-ink">Link to a different order</p>
            <Input
              value={q}
              onChange={(e) => search(e.target.value)}
              placeholder="Search order number…"
              aria-label="Search order to link"
              className="mt-1 h-9 max-w-xs"
            />
            {searching && <p className="mt-1 text-xs text-slate">Searching…</p>}
            {results.length > 0 && (
              <div className="mt-2 flex flex-col divide-y divide-line rounded-input border border-line">
                {results.map((o) => (
                  <div key={o.orderId} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-ink">{o.orderNumber}</span>
                    {o.customerName && <span className="text-xs text-slate">{o.customerName}</span>}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="ml-auto"
                      onClick={() => run(() => linkReplyToOrder(reply.messageId, o.orderId))}
                    >
                      Link
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {!archiving ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setArchiving(true)}>
                Archive (not a customer / spam)
              </Button>
            ) : (
              <>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (required)"
                  aria-label="Archive reason"
                  className="h-8 w-56"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={!reason.trim()}
                  onClick={() => run(() => archiveReply(reply.messageId, reason))}
                >
                  Confirm archive
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setArchiving(false)}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
