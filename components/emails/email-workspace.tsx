"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge, Button, Input, Textarea, useToast } from "@/components/ui";
import { AlertTriangle, Inbox, Mail, Search } from "@/components/ui/icons";
import type { IgnoredSender, MailHistoryItem, OutboxItem, UnmatchedReply } from "@/lib/email/outbox";
import {
  approveAndSend,
  updateDraftBody,
  discardDraft,
  markEmailSentManually,
  linkReplyToOrder,
  archiveReply,
  searchOrdersForLink,
  ignoreSenderFromMessage,
  unsuppressMessage,
  removeIgnoredSender,
  type OutboxActionResult,
} from "@/app/(app)/emails/actions";
import { ComposeButton } from "./compose-button";

const DAY_MS = 24 * 60 * 60 * 1000;

function formatAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "Unknown";
  return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function EmailWorkspace({
  businessId,
  sendingEnabled,
  unmatched,
  outbox,
  history,
  ignoredSenders,
  q,
  includeSuppressed,
  page,
  pageSize,
}: {
  businessId: string;
  sendingEnabled: boolean;
  unmatched: UnmatchedReply[];
  outbox: OutboxItem[];
  history: { rows: MailHistoryItem[]; total: number; suppressedCount: number };
  ignoredSenders: IgnoredSender[];
  q: string;
  includeSuppressed: boolean;
  page: number;
  pageSize: number;
}) {
  const failed = outbox.filter((m) => m.status === "failed");
  const pendingOutbox = outbox.filter((m) => m.status !== "failed");
  const totalPages = Math.max(1, Math.ceil(history.total / pageSize));

  return (
    <div className="flex flex-col gap-5">
      {!sendingEnabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-amber/30 bg-amber/5 px-4 py-3 text-sm">
          <AlertTriangle size={16} className="text-amber" />
          <span className="font-medium text-ink">Email sending is off.</span>
          <Link href="/settings?section=email" className="ml-auto font-medium text-pigment hover:text-ink">Open Settings</Link>
        </div>
      )}

      <section className="rounded-card border border-rose/20 bg-surface shadow-sm">
        <SectionTitle icon={Inbox} title="Needs action" count={unmatched.length + failed.length} />
        <div className="divide-y divide-line">
          {unmatched.length === 0 && failed.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate">No replies or failed sends need action.</p>
          ) : (
            <>
              {unmatched.map((reply) => <ReplyCard key={reply.messageId} reply={reply} businessId={businessId} />)}
              {failed.map((item) => <DraftCard key={item.messageId} item={item} sendingEnabled={sendingEnabled} />)}
            </>
          )}
        </div>
      </section>

      <section className="rounded-card border border-line bg-surface shadow-sm">
        <SectionTitle icon={Mail} title="Outbox" count={pendingOutbox.length} />
        <div className="divide-y divide-line">
          {pendingOutbox.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate">Nothing waiting to send.</p>
          ) : (
            pendingOutbox.map((item) => <DraftCard key={item.messageId} item={item} sendingEnabled={sendingEnabled} />)
          )}
        </div>
      </section>

      <section className="rounded-card border border-line bg-surface shadow-sm">
        <div className="border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Mail size={16} className="text-slate" />
            <h2 className="text-base font-semibold text-ink">All mail</h2>
            <Badge>{history.total}</Badge>
            {history.suppressedCount > 0 && (
              <Link
                href={`/emails?showSuppressed=${includeSuppressed ? "0" : "1"}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                className="ml-auto inline-flex h-8 items-center rounded-input border border-line px-3 text-sm font-medium text-ink hover:bg-canvas"
              >
                {includeSuppressed ? "Hide" : "Show"} {history.suppressedCount} suppressed
              </Link>
            )}
          </div>
          <form className="relative mt-3 max-w-xl">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
            <input type="hidden" name="showSuppressed" value={includeSuppressed ? "1" : "0"} />
            <input
              name="q"
              defaultValue={q}
              placeholder="Search sender, subject, order, or customer"
              className="h-10 w-full rounded-input border border-line bg-canvas pl-9 pr-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-pigment"
            />
          </form>
        </div>
        <div className="divide-y divide-line">
          {history.rows.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate">No mail found.</p>
          ) : (
            history.rows.map((item) => <MailRow key={item.messageId} item={item} businessId={businessId} />)
          )}
        </div>
        <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
          <Link
            href={`/emails?q=${encodeURIComponent(q)}&showSuppressed=${includeSuppressed ? "1" : "0"}&page=${Math.max(1, page - 1)}&pageSize=${pageSize}`}
            className={page <= 1 ? "pointer-events-none text-slate/50" : "font-medium text-pigment hover:text-ink"}
          >
            Previous
          </Link>
          <span className="text-slate">Page {page} of {totalPages}</span>
          <Link
            href={`/emails?q=${encodeURIComponent(q)}&showSuppressed=${includeSuppressed ? "1" : "0"}&page=${Math.min(totalPages, page + 1)}&pageSize=${pageSize}`}
            className={page >= totalPages ? "pointer-events-none text-slate/50" : "font-medium text-pigment hover:text-ink"}
          >
            Next
          </Link>
        </div>
      </section>

      {ignoredSenders.length > 0 && (
        <section className="rounded-card border border-line bg-surface shadow-sm">
          <SectionTitle icon={AlertTriangle} title="Ignored senders" count={ignoredSenders.filter((s) => s.active).length} />
          <div className="divide-y divide-line">
            {ignoredSenders.map((sender) => (
              <IgnoredSenderRow key={sender.id} sender={sender} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SectionTitle({ icon: Icon, title, count }: { icon: typeof Mail; title: string; count: number }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-3">
      <Icon size={16} className="text-slate" />
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <Badge variant={count ? "warning" : "neutral"}>{count}</Badge>
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
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-2 text-left">
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
        <div className="mt-3">
          <div className="rounded-input border border-line bg-canvas p-3 text-sm">
            <p className="text-xs text-slate">To: <span className="text-ink">{item.toAddress ?? "—"}</span></p>
            <p className="text-xs text-slate">Subject: <span className="font-medium text-ink">{item.subject}</span></p>
          </div>
          {item.status === "failed" && item.error && <p className="mt-2 text-xs text-rose">Last error: {item.error}</p>}
          {queued ? (
            <p className="mt-2 whitespace-pre-wrap rounded-input border border-line bg-canvas p-3 font-mono text-xs text-ink">
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
            {item.orderId && <Link href={`/orders/${item.orderId}`} className="text-sm font-medium text-pigment hover:text-ink">Open order</Link>}
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
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={stale ? "danger" : "warning"} dot>Waiting {formatAge(reply.ageMs)}{stale ? " · over 24h" : ""}</Badge>
        <span className="min-w-0 truncate text-sm font-medium text-ink">{reply.subject || "(no subject)"}</span>
        <span className="text-xs text-slate">{reply.fromAddress ?? "unknown sender"}</span>
        <button type="button" onClick={() => setOpen((o) => !o)} className="ml-auto text-sm font-medium text-pigment hover:text-ink">{open ? "Hide" : "View"}</button>
      </div>
      {open && (
        <div className="mt-3">
          <p className="whitespace-pre-wrap rounded-input border border-line bg-canvas p-3 text-sm text-ink">{reply.body || "(empty)"}</p>
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
            <Input value={q} onChange={(e) => search(e.target.value)} placeholder="Search order number" aria-label="Search order to link" className="h-9 max-w-xs" />
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
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Archive reason" aria-label="Archive reason" className="h-8 w-56" />
            <Button type="button" size="sm" variant="ghost" disabled={!reason.trim()} onClick={() => run(() => archiveReply(reply.messageId, reason))}>Archive</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => run(() => ignoreSenderFromMessage(reply.messageId))}>Ignore sender</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function MailRow({ item, businessId }: { item: MailHistoryItem; businessId: string }) {
  const { run } = useActionRunner();
  const inbound = item.direction === "inbound";
  const replySubject = item.subject.toLowerCase().startsWith("re:") ? item.subject : `Re: ${item.subject || ""}`.trim();
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={inbound ? "info" : "neutral"} dot>{inbound ? "Inbound" : "Outbound"}</Badge>
        {item.suppressed && <Badge variant="warning">Suppressed</Badge>}
        {item.archived && <Badge variant="neutral">Archived</Badge>}
        {item.status === "failed" && <Badge variant="danger">Failed</Badge>}
        <span className="min-w-0 truncate text-sm font-medium text-ink">{item.subject || "(no subject)"}</span>
        <span className="ml-auto text-xs text-slate">{fmtDateTime(item.sentAt ?? item.createdAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate">
        <span>{inbound ? "From" : "To"} {item.address ?? "unknown"}</span>
        {item.customerName && <span>· {item.customerName}</span>}
        {item.orderNumber && <Link href={`/orders/${item.orderId}`} className="font-medium text-pigment hover:text-ink">· {item.orderNumber}</Link>}
      </div>
      {item.body && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-slate">{item.body}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {inbound && item.address && (
          <ComposeButton
            businessId={businessId}
            to={item.address}
            subject={replySubject}
            orderId={item.orderId}
            customerId={item.customerId}
            replyToMessageId={item.messageId}
            label="Reply"
            size="sm"
            variant="ghost"
          />
        )}
        {item.orderId && <Link href={`/orders/${item.orderId}`} className="text-sm font-medium text-pigment hover:text-ink">Open order</Link>}
        {item.customerId && <Link href={`/customers/${item.customerId}`} className="text-sm font-medium text-pigment hover:text-ink">Open customer</Link>}
        {item.suppressed && (
          <Button type="button" size="sm" variant="ghost" onClick={() => run(() => unsuppressMessage(item.messageId))}>Restore</Button>
        )}
      </div>
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

function useActionRunner() {
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
