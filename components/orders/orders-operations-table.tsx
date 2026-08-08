"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import {
  bulkChangeOrderStatus,
  bulkReassignOrders,
  type BulkActionResult,
} from "@/app/(app)/orders/actions";
import { Badge, Button, InfoBubble, useToast, type OrderStatus } from "@/components/ui";
import { ArrowRight, Columns } from "@/components/ui/icons";
import { formatStageRemaining, type StageTimer } from "@/lib/orders/stage-timers";
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
  reviewReason: string | null;
  sourceType: "etsy" | "shopify" | "manual";
  assignee: string;
  assigneeId: string | null;
  dueAt: string | null;
  placedAt: string | null;
  createdAt: string | null;
  stageTimer: StageTimer;
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
type SortKey = "created" | "order" | "customer" | "source" | "status" | "owner" | "ordered" | "due";
type SortDir = "asc" | "desc";
type ColumnKey = "order" | "customer" | "source" | "status" | "owner" | "ordered" | "due" | "stage";

type ColumnDef = {
  key: ColumnKey;
  label: string;
  sort?: SortKey;
  width: string;
  render: (row: OrdersDashboardRow) => React.ReactNode;
};

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

const COLUMN_STORAGE_KEY = "orders_table_columns";

const ORDER_COLUMNS: ColumnDef[] = [
  {
    key: "order",
    label: "Order",
    sort: "order",
    width: "minmax(13rem,1.15fr)",
    render: (row) => (
      <div className="min-w-0">
        <Link href={`/orders/${row.id}`} className="truncate text-sm font-semibold text-ink hover:text-pigment">
          {row.orderNumber}
        </Link>
        <p className="truncate text-xs text-slate">{row.itemTitle}</p>
        {row.itemSummary && <p className="truncate text-xs text-slate">{row.itemSummary}</p>}
      </div>
    ),
  },
  {
    key: "customer",
    label: "Customer",
    sort: "customer",
    width: "minmax(12rem,0.95fr)",
    render: (row) => (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">{row.customer}</p>
        <p className="truncate text-xs text-slate">{row.customerEmail ?? "No email"}</p>
      </div>
    ),
  },
  {
    key: "source",
    label: "Source",
    sort: "source",
    width: "minmax(9rem,0.75fr)",
    render: (row) => (
      <div className="min-w-0">
        <p className="truncate text-sm text-ink">{row.source}</p>
        <p className="text-xs text-slate">{row.platform}</p>
      </div>
    ),
  },
  {
    key: "status",
    label: "Status",
    sort: "status",
    width: "minmax(11rem,0.9fr)",
    render: (row) => (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Badge variant={statusTone(row)} dot>{row.derivedStatus}</Badge>
          <InfoBubble label={`What "${row.derivedStatus}" means`}>
            <StatusHelp status={row.derivedStatus} reason={row.reviewReason} />
          </InfoBubble>
        </div>
        {row.reviewReason && (
          <p className="text-xs leading-snug text-amber">{row.reviewReason}</p>
        )}
      </div>
    ),
  },
  {
    key: "owner",
    label: "Designer",
    sort: "owner",
    width: "9rem",
    render: (row) => <p className="truncate text-sm text-slate">{row.assignee}</p>,
  },
  {
    key: "ordered",
    label: "Ordered",
    sort: "ordered",
    width: "8rem",
    render: (row) => (
      <div className="min-w-0">
        <p className="text-sm text-slate">{fmtDateTime(row.placedAt ?? row.createdAt)}</p>
      </div>
    ),
  },
  {
    key: "due",
    label: "Due",
    sort: "due",
    width: "8.5rem",
    render: (row) => (
      <div className="flex flex-wrap items-center gap-2">
        {row.isOverdue && <Badge variant="danger" dot>Overdue</Badge>}
        <span className="text-sm text-slate">{fmtDate(row.dueAt)}</span>
      </div>
    ),
  },
  {
    key: "stage",
    label: "Stage time",
    width: "9rem",
    render: (row) => (
      <div className="min-w-0">
        <p className={cn("text-sm font-medium", row.stageTimer.isOverdue ? "text-rose" : "text-ink")}>
          {formatStageRemaining(row.stageTimer)}
        </p>
        <p className="truncate text-xs text-slate">
          {row.stageTimer.followUpLabel ?? row.stageTimer.label}
        </p>
      </div>
    ),
  },
];

const DEFAULT_COLUMN_KEYS = ORDER_COLUMNS.map((column) => column.key);

function fmtDate(value: string | null) {
  if (!value) return "No due date";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function fmtDateTime(value: string | null) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
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
  if (row.derivedStatus === "Awaiting Designer QC Fix" || row.isOverdue || row.stageTimer.isOverdue) return "danger";
  if (
    row.derivedStatus === "Awaiting Designer Revision" ||
    row.derivedStatus === "Awaiting VA QC" ||
    row.derivedStatus === "Awaiting Customer Approval" ||
    row.derivedStatus === "Needs VA Review" ||
    row.needsReview
  ) {
    return "warning";
  }
  if (row.trackingNumber || row.status === "complete" || row.status === "delivered") return "success";
  if (row.derivedStatus === "Ready to Ship") return "info";
  return "neutral";
}

/**
 * Plain-English help for every operational status, written for VAs with limited
 * English: short words, one clear next step. `means` = what the status is;
 * `todo` = what to do about it. Keys match the derived status labels exactly.
 */
const STATUS_HELP: Record<string, { means: string; todo: string }> = {
  "Needs VA Review": {
    means: "This order cannot move forward on its own. A VA must check it.",
    todo: "Open the order and fix what is missing.",
  },
  "Awaiting VA Details": {
    means: "The order came in without all its details.",
    todo: "Open it and fill in the missing details.",
  },
  "Awaiting Customer Photos": {
    means: "We are waiting for the customer to send their photos.",
    todo: "Nothing to do yet. We wait for the customer.",
  },
  "Assigned - Not Started": {
    means: "A designer has this order but has not started it yet.",
    todo: "Nothing to do. Wait for the designer to start.",
  },
  "With Designer": {
    means: "A designer is working on this order right now.",
    todo: "Nothing to do. Wait for the designer to finish.",
  },
  "Awaiting Designer Revision": {
    means: "The customer asked for changes. The designer is redoing it.",
    todo: "Nothing to do. Wait for the new version.",
  },
  "Awaiting Designer QC Fix": {
    means: "QC found a problem. The designer is fixing it now.",
    todo: "Nothing to do. Wait for the fix, then check it again.",
  },
  "Awaiting VA QC": {
    means: "The design is done and needs a quality check.",
    todo: "Open QC and check the design against the list.",
  },
  "Awaiting Customer Approval": {
    means: "We sent the proof to the customer. We are waiting for their yes.",
    todo: "If it has been a few days, send a friendly follow up.",
  },
  Approved: {
    means: "The customer said yes to the design.",
    todo: "Move it to printing or fulfilment.",
  },
  "Ready to Ship": {
    means: "Approved and ready, but the print job has not started.",
    todo: "Start the print and ship job.",
  },
  "In Print": {
    means: "The order is being printed.",
    todo: "Nothing to do. Wait for it to ship.",
  },
  "Shipped - Awaiting Tracking": {
    means: "It has shipped but has no tracking number yet.",
    todo: "Add the tracking number to the order.",
  },
  Shipped: {
    means: "The order is on its way to the customer.",
    todo: "Nothing to do. Wait for delivery.",
  },
  "Completed With Tracking": {
    means: "Shipped with a tracking number saved.",
    todo: "Nothing to do.",
  },
  Delivered: {
    means: "The customer has received the order.",
    todo: "Close the order when everything is done.",
  },
  Complete: {
    means: "This order is finished.",
    todo: "Nothing to do.",
  },
  "On Hold": {
    means: "This order is paused for now.",
    todo: "Open it to see why, and resume it when ready.",
  },
  Cancelled: {
    means: "This order was cancelled.",
    todo: "Nothing to do.",
  },
  "Fulfilment Only": {
    means: "No design needed. It just needs to be sent.",
    todo: "Fulfil the order.",
  },
};

const DEFAULT_HELP = {
  means: "The current stage of this order.",
  todo: "Open the order to see the next step.",
};

function StatusHelp({ status, reason }: { status: string; reason: string | null }) {
  const help = STATUS_HELP[status] ?? DEFAULT_HELP;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold text-ink">{status}</p>
      <div className="flex flex-col gap-0.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate">What it means</p>
        <p className="text-sm leading-snug text-ink">{help.means}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate">What to do</p>
        <p className="text-sm leading-snug text-ink">{reason ?? help.todo}</p>
      </div>
    </div>
  );
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
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [columnPrefsLoaded, setColumnPrefsLoaded] = useState(false);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<ColumnKey[]>(DEFAULT_COLUMN_KEYS);
  const [pending, start] = useTransition();
  const selectedIds = useMemo(() => [...selected], [selected]);
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const visibleColumns = useMemo(() => {
    const selectedKeys = new Set(visibleColumnKeys);
    const columns = ORDER_COLUMNS.filter((column) => selectedKeys.has(column.key));
    return columns.length ? columns : ORDER_COLUMNS;
  }, [visibleColumnKeys]);
  const gridTemplateColumns = useMemo(
    () => ["2.25rem", ...visibleColumns.map((column) => column.width), "13.5rem"].join(" "),
    [visibleColumns],
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const valid = parsed.filter((key): key is ColumnKey =>
            DEFAULT_COLUMN_KEYS.includes(key as ColumnKey),
          );
          if (valid.length) setVisibleColumnKeys(valid);
        }
      }
    } catch {
      // Ignore corrupted local preferences and fall back to the default set.
    } finally {
      setColumnPrefsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!columnPrefsLoaded) return;
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibleColumnKeys));
  }, [columnPrefsLoaded, visibleColumnKeys]);

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

  function toggleColumn(key: ColumnKey) {
    setVisibleColumnKeys((current) => {
      if (current.includes(key)) {
        return current.length === 1 ? current : current.filter((columnKey) => columnKey !== key);
      }
      return DEFAULT_COLUMN_KEYS.filter((columnKey) => columnKey === key || current.includes(columnKey));
    });
  }

  function resetColumns() {
    setVisibleColumnKeys(DEFAULT_COLUMN_KEYS);
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
          <div className="relative ml-auto">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setColumnMenuOpen((open) => !open)}
            >
              <Columns size={15} />
              Columns
            </Button>
            {columnMenuOpen && (
              <div className="absolute right-0 top-10 z-30 w-56 rounded-card border border-line bg-surface p-2 shadow-lg">
                <div className="flex items-center justify-between gap-2 border-b border-line px-2 pb-2">
                  <p className="text-xs font-semibold uppercase text-slate">Visible columns</p>
                  <button
                    type="button"
                    onClick={resetColumns}
                    className="text-xs font-medium text-pigment hover:text-ink"
                  >
                    Reset
                  </button>
                </div>
                <div className="mt-2 flex flex-col gap-1">
                  {ORDER_COLUMNS.map((column) => (
                    <label
                      key={column.key}
                      className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 text-sm text-ink hover:bg-canvas"
                    >
                      <input
                        type="checkbox"
                        checked={visibleColumnKeys.includes(column.key)}
                        onChange={() => toggleColumn(column.key)}
                        className="size-4 rounded border-line text-pigment focus:ring-pigment"
                      />
                      {column.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="md:min-w-[76rem]">
          <div
            className="hidden gap-3 border-b border-line bg-surface px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-slate md:grid md:[grid-template-columns:var(--orders-grid)]"
            style={{ "--orders-grid": gridTemplateColumns } as React.CSSProperties}
          >
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="Select all visible orders"
                className="size-4 rounded border-line text-pigment focus:ring-pigment"
              />
            </label>
            {visibleColumns.map((column) =>
              column.sort ? (
                <SortableHeader
                  key={column.key}
                  currentParams={currentParams}
                  sort={column.sort}
                  activeSort={sort}
                  dir={dir}
                >
                  {column.label}
                </SortableHeader>
              ) : (
                <span key={column.key}>{column.label}</span>
              ),
            )}
            <span className="z-20 flex items-center justify-end pl-3 text-right text-pigment md:sticky md:right-0 md:-my-2.5 md:-mr-4 md:self-stretch md:border-l md:border-pigment/20 md:bg-pigment-soft md:py-2.5 md:pr-4">
              Next action
            </span>
          </div>

          <div className="divide-y divide-line">
            {rows.map((row) => {
              const urgent = row.stageTimer.isOverdue || row.isOverdue;
              const dueSoon = !urgent && row.stageTimer.followUpDue;
              return (
                <div
                  key={row.id}
                  className={cn(
                    "group grid gap-3 border-l-2 border-transparent px-4 py-3.5 transition-colors hover:bg-canvas/70 md:items-center md:[grid-template-columns:var(--orders-grid)]",
                    urgent && "border-rose/60 bg-rose/[0.04] hover:bg-rose/[0.07]",
                    dueSoon && "border-amber/50",
                  )}
                  style={{ "--orders-grid": gridTemplateColumns } as React.CSSProperties}
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
                  {visibleColumns.map((column) => (
                    <div key={column.key} className="min-w-0">
                      {column.render(row)}
                    </div>
                  ))}
                  <div
                    className={cn(
                      "flex items-center justify-end gap-1.5 pl-3",
                      "md:sticky md:right-0 md:z-10 md:-my-3.5 md:-mr-4 md:self-stretch md:py-3.5 md:pr-4",
                      "md:border-l md:border-pigment/20 md:bg-pigment-soft",
                    )}
                  >
                    <OrderActions row={row} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
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

function OrderActions({ row }: { row: OrdersDashboardRow }) {
  // A row is "actionable" when there's a specific task to do; the generic
  // "Open" fallback stays quiet so the eye is drawn only to real work.
  const isTask = row.action.label !== "Open";
  return (
    <Link
      href={row.action.href}
      aria-label={`${row.action.label} — order ${row.orderNumber}`}
      className={cn(
        "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-input px-3 text-sm font-medium transition-[opacity,background-color,border-color] duration-[120ms]",
        isTask
          ? "bg-pigment text-surface shadow-sm hover:opacity-90"
          : "border border-line bg-surface text-slate hover:border-slate/40 hover:text-ink",
      )}
    >
      <span className="truncate">{row.action.label}</span>
      {isTask && <ArrowRight size={14} className="shrink-0" />}
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
