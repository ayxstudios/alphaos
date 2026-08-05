"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  bulkChangeOrderStatus,
  bulkReassignOrders,
  type BulkActionResult,
} from "@/app/(app)/orders/actions";
import { Badge, Button, useToast, type OrderStatus } from "@/components/ui";
import { cn } from "@/lib/utils";

export type OrdersDashboardRow = {
  id: string;
  orderNumber: string;
  customer: string;
  customerEmail: string | null;
  source: string;
  platform: string;
  status: string;
  derivedStatus: string;
  sourceType: "etsy" | "shopify" | "manual";
  assignee: string;
  assigneeId: string | null;
  dueAt: string | null;
  placedAt: string | null;
  createdAt: string | null;
  itemTitle: string;
  itemSummary: string;
  isOverdue: boolean;
  needsReview: boolean;
  revisionCount: number;
  latestQcResult: string | null;
  latestQcReason: string | null;
  hasPrintJob: boolean;
  trackingNumber: string | null;
  action: { href: string; label: string };
};

type DesignerOption = { id: string; name: string };
type SortKey = "created" | "order" | "customer" | "source" | "status" | "owner" | "due";
type SortDir = "asc" | "desc";

const BULK_STATUSES: { value: OrderStatus; label: string }[] = [
  { value: "awaiting_photos", label: "Awaiting photos" },
  { value: "ready_to_assign", label: "Ready to assign" },
  { value: "in_design", label: "In design" },
  { value: "awaiting_qc", label: "Awaiting QC" },
  { value: "awaiting_approval", label: "Awaiting customer" },
  { value: "approved", label: "Approved" },
  { value: "printing", label: "Printing" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "complete", label: "Complete" },
  { value: "on_hold", label: "On hold" },
  { value: "cancelled", label: "Cancelled" },
];

function fmtDate(value: string | null) {
  if (!value) return "No due date";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function resultText(result: BulkActionResult) {
  if (!result.ok) return result.message;
  const skipped = result.skipped.length ? `, ${result.skipped.length} skipped` : "";
  return `${result.changed} updated${skipped}`;
}

function sortHref(currentParams: string, sort: SortKey, activeSort: SortKey, dir: SortDir) {
  const params = new URLSearchParams(currentParams);
  const nextDir = activeSort === sort && dir === "asc" ? "desc" : "asc";
  params.set("sort", sort);
  params.set("dir", nextDir);
  params.delete("page");
  return `/orders?${params.toString()}`;
}

function pageHref(currentParams: string, page: number) {
  const params = new URLSearchParams(currentParams);
  if (page > 1) params.set("page", String(page));
  else params.delete("page");
  return `/orders?${params.toString()}`;
}

function statusTone(row: OrdersDashboardRow) {
  if (row.derivedStatus === "Failed QC" || row.isOverdue) return "danger";
  if (
    row.derivedStatus === "Revision" ||
    row.derivedStatus === "Awaiting Qc" ||
    row.derivedStatus === "Awaiting Customer" ||
    row.derivedStatus === "Needs Review" ||
    row.needsReview
  ) {
    return "warning";
  }
  if (row.trackingNumber || row.status === "complete" || row.status === "delivered") return "success";
  if (row.derivedStatus === "Ready to Ship") return "info";
  return "neutral";
}

export function OrdersOperationsTable({
  rows,
  designers,
  sort,
  dir,
  currentParams,
  page,
  totalPages,
  firstResult,
  lastResult,
  total,
}: {
  rows: OrdersDashboardRow[];
  designers: DesignerOption[];
  sort: SortKey;
  dir: SortDir;
  currentParams: string;
  page: number;
  totalPages: number;
  firstResult: number;
  lastResult: number;
  total: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [designerId, setDesignerId] = useState("");
  const [targetStatus, setTargetStatus] = useState<OrderStatus | "">("");
  const [pending, start] = useTransition();
  const selectedIds = useMemo(() => [...selected], [selected]);
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) rows.forEach((row) => next.delete(row.id));
      else rows.forEach((row) => next.add(row.id));
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleResult(result: BulkActionResult) {
    if (!result.ok) {
      toast({ variant: "danger", title: "Bulk action failed", description: result.message });
      return;
    }
    toast({
      variant: result.skipped.length ? "warning" : "success",
      title: "Bulk action complete",
      description: resultText(result),
    });
    setSelected(new Set());
    router.refresh();
  }

  function reassign() {
    start(async () => {
      handleResult(await bulkReassignOrders(selectedIds, designerId));
    });
  }

  function changeStatus() {
    if (!targetStatus) return;
    start(async () => {
      handleResult(await bulkChangeOrderStatus(selectedIds, targetStatus));
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-sm text-slate">
        <span>
          Showing {firstResult}-{lastResult} of {total}
        </span>
        <Pagination currentParams={currentParams} page={page} totalPages={totalPages} />
      </div>

      <div className="border-b border-line bg-canvas/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{selected.size} selected</span>
          <select
            value={designerId}
            onChange={(event) => setDesignerId(event.currentTarget.value)}
            className="h-9 rounded-input border border-line bg-surface px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-pigment"
          >
            <option value="">Choose designer</option>
            {designers.map((designer) => (
              <option key={designer.id} value={designer.id}>{designer.name}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!selected.size || !designerId}
            loading={pending}
            onClick={reassign}
          >
            Bulk reassign
          </Button>
          <select
            value={targetStatus}
            onChange={(event) => setTargetStatus(event.currentTarget.value as OrderStatus)}
            className="h-9 rounded-input border border-line bg-surface px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-pigment"
          >
            <option value="">Choose status</option>
            {BULK_STATUSES.map((status) => (
              <option key={status.value} value={status.value}>{status.label}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!selected.size || !targetStatus}
            loading={pending}
            onClick={changeStatus}
          >
            Bulk status change
          </Button>
          <p className="text-xs text-slate">
            Illegal moves are skipped and reported.
          </p>
        </div>
      </div>

      <div className="hidden grid-cols-[2.25rem_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,0.9fr)_9rem_9rem_8rem_8rem] gap-4 border-b border-line px-4 py-2 text-xs font-medium uppercase text-slate lg:grid">
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            aria-label="Select all visible orders"
            className="size-4 rounded border-line text-pigment focus:ring-pigment"
          />
        </label>
        <SortableHeader currentParams={currentParams} sort="order" activeSort={sort} dir={dir}>Order</SortableHeader>
        <SortableHeader currentParams={currentParams} sort="customer" activeSort={sort} dir={dir}>Customer</SortableHeader>
        <SortableHeader currentParams={currentParams} sort="source" activeSort={sort} dir={dir}>Source</SortableHeader>
        <SortableHeader currentParams={currentParams} sort="status" activeSort={sort} dir={dir}>Status</SortableHeader>
        <SortableHeader currentParams={currentParams} sort="owner" activeSort={sort} dir={dir}>Owner</SortableHeader>
        <SortableHeader currentParams={currentParams} sort="due" activeSort={sort} dir={dir}>Due</SortableHeader>
        <span>Action</span>
      </div>

      <div className="divide-y divide-line">
        {rows.map((row) => (
          <div
            key={row.id}
            className="grid gap-3 px-4 py-3 transition-colors hover:bg-canvas lg:grid-cols-[2.25rem_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,0.9fr)_9rem_9rem_8rem_8rem] lg:items-center lg:gap-4"
          >
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={selected.has(row.id)}
                onChange={() => toggleOne(row.id)}
                aria-label={`Select order ${row.orderNumber}`}
                className="size-4 rounded border-line text-pigment focus:ring-pigment"
              />
            </label>
            <div className="min-w-0">
              <Link href={`/orders/${row.id}`} className="truncate text-sm font-semibold text-ink hover:text-pigment">
                {row.orderNumber}
              </Link>
              <p className="truncate text-xs text-slate">{row.itemTitle}</p>
              {row.itemSummary && <p className="truncate text-xs text-slate">{row.itemSummary}</p>}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{row.customer}</p>
              <p className="truncate text-xs text-slate">{row.customerEmail ?? "No email"}</p>
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm text-ink">{row.source}</p>
              <p className="text-xs text-slate">{row.platform}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusTone(row)} dot>{row.derivedStatus}</Badge>
            </div>
            <p className="truncate text-sm text-slate">{row.assignee}</p>
            <div className="flex flex-wrap items-center gap-2">
              {row.isOverdue && <Badge variant="danger" dot>Overdue</Badge>}
              <span className="text-sm text-slate">{fmtDate(row.dueAt)}</span>
            </div>
            <Link
              href={row.action.href}
              className={cn(
                "inline-flex h-8 items-center justify-center rounded-input px-2 text-sm font-medium transition-colors",
                row.action.label === "Open"
                  ? "text-pigment hover:bg-pigment-soft"
                  : "bg-pigment text-surface hover:opacity-90",
              )}
            >
              {row.action.label}
            </Link>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-sm text-slate">
        <span>
          Showing {firstResult}-{lastResult} of {total}
        </span>
        <Pagination currentParams={currentParams} page={page} totalPages={totalPages} />
      </div>
    </>
  );
}

function SortableHeader({
  currentParams,
  sort,
  activeSort,
  dir,
  children,
}: {
  currentParams: string;
  sort: SortKey;
  activeSort: SortKey;
  dir: SortDir;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={sortHref(currentParams, sort, activeSort, dir)}
      className="inline-flex items-center gap-1 text-left transition-colors hover:text-ink"
    >
      {children}
      {activeSort === sort && <span>{dir === "asc" ? "↑" : "↓"}</span>}
    </Link>
  );
}

function Pagination({
  currentParams,
  page,
  totalPages,
}: {
  currentParams: string;
  page: number;
  totalPages: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <Link
        href={pageHref(currentParams, page - 1)}
        aria-disabled={page <= 1}
        className={cn(
          "inline-flex h-8 items-center rounded-input px-2 text-sm font-medium transition-colors",
          page <= 1 ? "pointer-events-none text-slate/40" : "text-pigment hover:bg-pigment-soft",
        )}
      >
        Previous
      </Link>
      <span className="text-xs tabular-nums text-slate">
        Page {page} of {totalPages}
      </span>
      <Link
        href={pageHref(currentParams, page + 1)}
        aria-disabled={page >= totalPages}
        className={cn(
          "inline-flex h-8 items-center rounded-input px-2 text-sm font-medium transition-colors",
          page >= totalPages ? "pointer-events-none text-slate/40" : "text-pigment hover:bg-pigment-soft",
        )}
      >
        Next
      </Link>
    </div>
  );
}
