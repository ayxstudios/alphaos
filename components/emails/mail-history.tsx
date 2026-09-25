"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Badge, Button, Disclosure } from "@/components/ui";
import { Search } from "@/components/ui/icons";
import type { MailHistoryItem } from "@/lib/email/outbox";
import { loadMailBody, unsuppressMessage } from "@/app/(app)/emails/actions";
import { ComposeButton } from "./compose-button";
import { fmtDateTime, useActionRunner } from "./email-workspace";

/**
 * "All mail" on the Messages page: search, the history rows and paging. Each
 * row carries a short preview only; the full text loads through a server
 * action when a person expands the row. Rendered by the page inside its own
 * Suspense boundary, so the rest of the page paints before this query.
 */
export function MailHistory({
  businessId,
  history,
  q,
  includeSuppressed,
  page,
  pageSize,
}: {
  businessId: string;
  history: { rows: MailHistoryItem[]; total: number; suppressedCount: number };
  q: string;
  includeSuppressed: boolean;
  page: number;
  pageSize: number;
}) {
  const totalPages = Math.max(1, Math.ceil(history.total / pageSize));
  return (
    <Disclosure
      summary={<span className="flex items-center gap-2"><Search size={15} className="text-slate" /> All mail</span>}
      hint={`${history.total} message${history.total === 1 ? "" : "s"}`}
      defaultOpen={Boolean(q) || includeSuppressed || page > 1}
    >
      <div className="-mx-4">
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          <form className="relative min-w-0 flex-1 sm:max-w-md">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
            <input type="hidden" name="showSuppressed" value={includeSuppressed ? "1" : "0"} />
            <input
              name="q"
              defaultValue={q}
              placeholder="Search sender, subject, order or customer"
              className="h-10 w-full rounded-input border border-line bg-canvas pl-9 pr-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-pigment"
            />
          </form>
          {history.suppressedCount > 0 && (
            <Link
              href={`/emails?showSuppressed=${includeSuppressed ? "0" : "1"}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className="inline-flex h-8 items-center rounded-input px-2 text-xs font-medium text-slate hover:bg-canvas hover:text-ink"
            >
              {includeSuppressed ? "Hide" : "Show"} {history.suppressedCount} suppressed
            </Link>
          )}
        </div>
        <div className="divide-y divide-line/70 border-t border-line/70">
          {history.rows.length === 0 ? (
            <p className="px-4 py-4 text-sm text-slate">No mail found.</p>
          ) : (
            history.rows.map((item) => <MailRow key={item.messageId} item={item} businessId={businessId} />)
          )}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-line/70 px-4 pt-3 text-sm">
            <Link
              href={`/emails?q=${encodeURIComponent(q)}&showSuppressed=${includeSuppressed ? "1" : "0"}&page=${Math.max(1, page - 1)}&pageSize=${pageSize}`}
              className={page <= 1 ? "pointer-events-none inline-flex min-h-11 min-w-11 items-center text-slate/50 sm:min-h-0 sm:min-w-0" : "inline-flex min-h-11 min-w-11 items-center justify-center font-medium text-pigment hover:text-ink sm:min-h-0 sm:min-w-0"}
            >
              Previous
            </Link>
            <span className="text-slate">Page {page} of {totalPages}</span>
            <Link
              href={`/emails?q=${encodeURIComponent(q)}&showSuppressed=${includeSuppressed ? "1" : "0"}&page=${Math.min(totalPages, page + 1)}&pageSize=${pageSize}`}
              className={page >= totalPages ? "pointer-events-none inline-flex min-h-11 min-w-11 items-center text-slate/50 sm:min-h-0 sm:min-w-0" : "inline-flex min-h-11 min-w-11 items-center justify-center font-medium text-pigment hover:text-ink sm:min-h-0 sm:min-w-0"}
            >
              Next
            </Link>
          </div>
        )}
      </div>
    </Disclosure>
  );
}

/** The closed "All mail" row while its query streams in. */
export function MailHistoryFallback() {
  return (
    <Disclosure
      summary={<span className="flex items-center gap-2"><Search size={15} className="text-slate" /> All mail</span>}
      hint={<span className="animate-pulse">loading</span>}
    >
      <p className="py-1 text-sm text-slate">Loading mail.</p>
    </Disclosure>
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
        {/* The order number is a fact here; "Open order" below is the one link, a full tap target on a phone. */}
        {item.orderNumber && <span className="font-medium text-ink">· {item.orderNumber}</span>}
      </div>
      {item.preview && <MailBody item={item} />}
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
        {item.orderId && <Link href={`/orders/${item.orderId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-pigment hover:text-ink sm:min-h-0">Open order</Link>}
        {item.customerId && <Link href={`/customers/${item.customerId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-pigment hover:text-ink sm:min-h-0">Open customer</Link>}
        {item.suppressed && (
          <Button type="button" size="sm" variant="ghost" onClick={() => run(() => unsuppressMessage(item.messageId))}>Restore</Button>
        )}
      </div>
    </div>
  );
}

/** Three clamped lines of preview; "Show more" loads the whole message once. */
function MailBody({ item }: { item: MailHistoryItem }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, start] = useTransition();
  const showsAll = open && (full !== null || !item.hasMore);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!item.hasMore || full !== null) return;
    start(async () => {
      const res = await loadMailBody(item.messageId);
      if (res.ok) setFull(res.body);
      else setError(res.message);
    });
  }

  return (
    <div className="mt-2">
      <p className={showsAll ? "whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-slate" : "line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-slate"}>
        {showsAll && full !== null ? full : item.preview}
      </p>
      {error && <p className="mt-1 text-xs text-rose">{error}</p>}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="mt-1 inline-flex min-h-11 items-center text-xs font-medium text-pigment hover:text-ink sm:min-h-0"
      >
        {loading ? "Loading…" : open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
