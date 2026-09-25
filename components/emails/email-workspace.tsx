"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Disclosure, Input, Textarea, useToast } from "@/components/ui";
import { AlertTriangle, ChevronRight, Mail } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { IgnoredSender, OutboxItem, UnmatchedReply } from "@/lib/email/outbox";
import {
  approveAndSend,
  updateDraftBody,
  discardDraft,
  markEmailSentManually,
  linkReplyToOrder,
  archiveReply,
  searchOrdersForLink,
  ignoreSenderFromMessage,
  removeIgnoredSender,
  type OutboxActionResult,
} from "@/app/(app)/emails/actions";
import { formatAt } from "@/lib/time";

const DAY_MS = 24 * 60 * 60 * 1000;

function formatAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function fmtDateTime(iso: string | null): string {
  return formatAt(iso, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }, "Unknown");
}

export function EmailWorkspace({
  businessId,
  sendingEnabled,
  unmatched,
  outbox,
  history,
  ignoredSenders,
}: {
  businessId: string;
  sendingEnabled: boolean;
  unmatched: UnmatchedReply[];
  outbox: OutboxItem[];
  history: ReactNode;
  ignoredSenders: IgnoredSender[];
}) {
  const failed = outbox.filter((m) => m.status === "failed");
  const pendingOutbox = outbox.filter((m) => m.status !== "failed");

  return (
    <div className="flex flex-col gap-4">
      {!sendingEnabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-card bg-amber/5 px-4 py-3 text-sm shadow-card">
          <AlertTriangle size={16} className="text-amber" />
          <span className="font-medium text-ink">Email sending is off.</span>
          <Link href="/settings?section=email" className="ml-auto font-medium text-pigment hover:text-ink">Open Settings</Link>
        </div>
      )}

      {/* The hero: what a person has to deal with. */}
      <section className="rounded-card bg-surface shadow-card">
        <div className="flex items-center gap-2 px-4 py-3" data-tour="page:messages">
          <h2 className="text-base font-semibold text-ink">Needs you</h2>
          {unmatched.length + failed.length > 0 && <Badge variant="warning">{unmatched.length + failed.length}</Badge>}
        </div>
        <div className="divide-y divide-line/70 border-t border-line/70">
          {unmatched.length === 0 && failed.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate">All caught up. Nothing needs a reply.</p>
          ) : (
            <>
              {unmatched.map((reply) => <ReplyCard key={reply.messageId} reply={reply} businessId={businessId} />)}
              {failed.map((item) => <DraftCard key={item.messageId} item={item} sendingEnabled={sendingEnabled} />)}
            </>
          )}
        </div>
      </section>

      <Disclosure
        summary={<span className="flex items-center gap-2"><Mail size={15} className="text-slate" /> Waiting to send</span>}
        hint={pendingOutbox.length ? `${pendingOutbox.length} draft${pendingOutbox.length === 1 ? "" : "s"}` : "nothing queued"}
        defaultOpen={pendingOutbox.some((m) => m.status !== "queued")}
      >
        {pendingOutbox.length === 0 ? (
          <p className="py-1 text-sm text-slate">Nothing waiting to send.</p>
        ) : (
          <div className="-mx-4 divide-y divide-line/70">
            {pendingOutbox.map((item) => <DraftCard key={item.messageId} item={item} sendingEnabled={sendingEnabled} />)}
          </div>
        )}
      </Disclosure>

      {/* All mail: streamed in its own Suspense boundary (app/(app)/emails/page.tsx),
          so "Needs you" paints before the 50-row history query returns. */}
      {history}

      {ignoredSenders.length > 0 && (
        <Disclosure
          summary={<span className="flex items-center gap-2"><AlertTriangle size={15} className="text-slate" /> Ignored senders</span>}
          hint={`${ignoredSenders.filter((s) => s.active).length} active`}
        >
          <div className="-mx-4 divide-y divide-line/70">
            {ignoredSenders.map((sender) => (
              <IgnoredSenderRow key={sender.id} sender={sender} />
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

function DraftCard({ item, sendingEnabled }: { item: OutboxItem; sendingEnabled: boolean }) {
  const { run, pending } = useActionRunner();
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
    <div className="px-4 py-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="-my-3 flex w-full flex-wrap items-center gap-2 py-3 text-left">
        {item.templateLabel && <Badge variant="info">{item.templateLabel}</Badge>}
        {queued && <Badge variant="warning" dot>System queued</Badge>}
        {item.status === "failed" && <Badge variant="danger" dot>Failed</Badge>}
        {item.skippedReason && <Badge variant="warning" dot>Skipped</Badge>}
        {item.orderFinished && <Badge variant="warning" dot>Order {item.orderFinished}</Badge>}
        <span className="min-w-0 truncate text-sm font-medium text-ink">{item.subject || "(no subject)"}</span>
        <span className="w-full text-xs text-slate sm:ml-auto sm:w-auto">
          {item.customerName ?? item.toAddress ?? "-"}
          {item.orderNumber ? ` · ${item.orderNumber}` : ""} · {fmtDateTime(item.createdAt)}
        </span>
      </button>
      {open && (
        <div className="mt-3">
          <div className="rounded-input border border-line bg-canvas p-3 text-sm">
            <p className="text-xs text-slate">To: <span className="text-ink">{item.toAddress ?? "-"}</span></p>
            <p className="text-xs text-slate">Subject: <span className="font-medium text-ink">{item.subject}</span></p>
          </div>
          {item.status === "failed" && item.error && <p className="mt-2 text-xs text-rose">Last error: {item.error}</p>}
          {item.orderFinished && (
            <p className="mt-2 text-xs text-amber">
              This order is already {item.orderFinished}, so this email is probably out of date. Send it only if it still makes sense, otherwise discard it.
            </p>
          )}
          {item.skippedReason && (
            <p className="mt-2 text-xs text-amber">
              Skipped when sending was turned on ({item.skippedReason}). Approve &amp; send only if it still makes sense, otherwise discard.
            </p>
          )}
          {queued ? (
            <p className="mt-2 whitespace-pre-wrap rounded-input [overflow-wrap:anywhere] border border-line bg-canvas p-3 font-mono text-xs text-ink">
              {item.body || "(empty)"}
            </p>
          ) : (
            <Textarea label="Body" value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="mt-2 font-mono text-xs" />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!queued && (
              <Button type="button" size="sm" onClick={send} loading={pending} disabled={!sendingEnabled}>
                {item.status === "failed" ? "Retry send" : "Approve & send"}
              </Button>
            )}
            {item.orderId && <Link href={`/orders/${item.orderId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-pigment hover:text-ink sm:min-h-0">Open order</Link>}
            {!queued && !manualSent && <Button type="button" size="sm" variant="ghost" onClick={() => setManualSent(true)}>Mark sent manually</Button>}
            {!discarding ? (
              <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setDiscarding(true)}>Discard</Button>
            ) : (
              <div className="ml-auto flex items-center gap-2">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" aria-label="Discard reason" className="h-8 w-48" />
                <Button type="button" size="sm" variant="danger" disabled={!reason.trim()} onClick={() => run(() => discardDraft(item.messageId, reason))}>Confirm</Button>
              </div>
            )}
          </div>
          {manualSent && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-input border border-line bg-canvas p-2">
              <Input value={manualReason} onChange={(e) => setManualReason(e.target.value)} placeholder="Manual send reason" className="h-8 w-72" />
              <Button type="button" size="sm" disabled={!manualReason.trim()} onClick={() => run(() => markEmailSentManually(item.messageId, manualReason))}>Confirm manual send</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReplyCard({ reply, businessId }: { reply: UnmatchedReply; businessId: string }) {
  const { run, pending } = useActionRunner();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ orderId: string; orderNumber: string; customerName: string | null }[]>([]);
  const [searching, startSearch] = useTransition();
  const [reason, setReason] = useState("");
  const stale = reply.ageMs > DAY_MS;

  function search(term: string) {
    setQ(term);
    if (term.trim().length < 2) return setResults([]);
    startSearch(async () => setResults(await searchOrdersForLink(businessId, term)));
  }

  return (
    <div className="relative px-4 py-3">
      {/* The "waiting over a day" dot sits in the gutter, so every row's text lines up with the header. */}
      {stale && <span className="absolute left-1.5 top-[1.35rem] size-1.5 rounded-full bg-rose" aria-hidden="true" title="Waiting over 24h" />}
      <button type="button" onClick={() => setOpen((o) => !o)} className="-my-3 flex w-full items-center gap-3 py-3 text-left" aria-expanded={open}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{reply.subject || "(no subject)"}</span>
          <span className="block truncate text-xs text-slate">{reply.fromAddress ?? "unknown sender"}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-slate">{formatAge(reply.ageMs)}</span>
        <ChevronRight size={16} className={cn("shrink-0 text-slate transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-3">
          <p className="whitespace-pre-wrap rounded-input [overflow-wrap:anywhere] border border-line bg-canvas p-3 text-sm text-ink">{reply.body || "(empty)"}</p>
          {reply.suggestion && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-input border border-pigment/20 bg-pigment-soft/40 p-2.5 text-sm">
              <span className="text-ink">
                Suggested by {reply.suggestion.reason}: <strong>{reply.suggestion.orderNumber}</strong> ({reply.suggestion.customerName})
              </span>
              <Button type="button" size="sm" className="ml-auto" loading={pending} onClick={() => run(() => linkReplyToOrder(reply.messageId, reply.suggestion!.orderId))}>
                Link
              </Button>
            </div>
          )}
          <div className="mt-3">
            <p className="mb-1.5 text-xs font-medium text-ink">Which order is this about?</p>
            <Input value={q} onChange={(e) => search(e.target.value)} placeholder="Type the order number" aria-label="Order number to link this message to" className="h-9 max-w-xs" />
            {searching && <p className="mt-1 text-xs text-slate">Searching…</p>}
            {results.length > 0 && (
              <div className="mt-2 flex flex-col divide-y divide-line rounded-input border border-line">
                {results.map((o) => (
                  <div key={o.orderId} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-ink">{o.orderNumber}</span>
                    {o.customerName && <span className="text-xs text-slate">{o.customerName}</span>}
                    <Button type="button" size="sm" variant="secondary" className="ml-auto" onClick={() => run(() => linkReplyToOrder(reply.messageId, o.orderId))}>Link</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. not a customer" aria-label="Why archive it" className="h-8 w-56" />
            <Button type="button" size="sm" variant="ghost" disabled={!reason.trim()} onClick={() => run(() => archiveReply(reply.messageId, reason))}>Archive</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => run(() => ignoreSenderFromMessage(reply.messageId))}>Ignore sender</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function IgnoredSenderRow({ sender }: { sender: IgnoredSender }) {
  const { run } = useActionRunner();
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
      <Badge variant={sender.active ? "warning" : "neutral"}>{sender.active ? "Active" : "Off"}</Badge>
      <span className="font-medium text-ink">{sender.value}</span>
      <span className="text-xs text-slate">{sender.matchType}</span>
      {sender.active && (
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => run(() => removeIgnoredSender(sender.id))}>
          Restore sender
        </Button>
      )}
    </div>
  );
}

export function useActionRunner() {
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
  return { run, pending };
}
