"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import {
  bulkChangeOrderStatus,
  bulkReassignOrders,
  type BulkActionResult,
} from "@/app/(app)/orders/actions";
import { Badge, Button, InfoBubble, useToast, type OrderStatus } from "@/components/ui";
import { ArrowRight, Columns, X } from "@/components/ui/icons";
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
type ColumnKey = "order" | "customer" | "source" | "status" | "owner" | "ordered" | "due";

type ColumnDef = {
  key: ColumnKey;
  label: string;
  sort?: SortKey;
  width: string;
  /**
   * "core" columns are always on screen (even in the narrowest content width
   * this table has to fit, ~960px, with the sidebar open); "wide" columns
   * only show once there's real room (xl, 1280px+) — otherwise they're the
   * reason a laptop-width screen scrolled sideways to see them.
   */
  priority: "core" | "wide";
  render: (row: OrdersDashboardRow) => React.ReactNode;
};

/** True once the viewport is xl (1280px) or wider. Starts false (matches the
 * server-rendered guess) and updates after mount — the "wide" columns pop in
 * rather than risk a hydration mismatch guessing the real width up front. */
function useIsWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return wide;
}

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
    width: "minmax(6rem,1fr)",
    priority: "core",
    render: (row) => (
      <div className="min-w-0">
        <Link href={`/orders/${row.id}`} className="truncate text-sm font-semibold text-ink hover:text-pigment">
          {row.orderNumber}
        </Link>
        <p className="truncate text-xs text-slate" title={row.itemTitle}>{row.itemTitle}</p>
        {row.itemSummary && <p className="truncate text-xs text-slate" title={row.itemSummary}>{row.itemSummary}</p>}
      </div>
    ),
  },
  {
    key: "customer",
    label: "Customer",
    sort: "customer",
    width: "minmax(5rem,0.8fr)",
    priority: "core",
    render: (row) => (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink" title={row.customer}>{row.customer}</p>
        <p className="truncate text-xs text-slate" title={row.customerEmail ?? "No email"}>{row.customerEmail ?? "No email"}</p>
      </div>
    ),
  },
  {
    key: "source",
    label: "Source",
    sort: "source",
    width: "7rem",
    priority: "wide",
    render: (row) => (
      <div className="min-w-0">
        <p className="truncate text-sm text-ink" title={row.source}>{row.source}</p>
        <p className="truncate text-xs text-slate" title={row.platform}>{row.platform}</p>
      </div>
    ),
  },
  {
    key: "status",
    label: "Status",
    sort: "status",
    width: "minmax(7rem,0.9fr)",
    priority: "core",
    render: (row) => (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Badge variant={statusTone(row)} dot>{row.derivedStatus}</Badge>
          <InfoBubble label={`What "${row.derivedStatus}" means`}>
            <StatusHelp status={row.derivedStatus} reason={row.reviewReason} />
          </InfoBubble>
        </div>
        {row.reviewReason && (
          <p className="truncate text-xs leading-snug text-amber" title={row.reviewReason}>{row.reviewReason}</p>
        )}
      </div>
    ),
  },
  {
    key: "owner",
    label: "Designer",
    sort: "owner",
    width: "7rem",
    priority: "wide",
    render: (row) => <p className="truncate text-sm text-slate" title={row.assignee}>{row.assignee}</p>,
  },
  {
    key: "ordered",
    label: "Ordered",
    sort: "ordered",
    width: "4.5rem",
    priority: "core",
    render: (row) => (
      <div className="min-w-0">
        <p className="truncate text-sm text-slate" title={fmtDateTime(row.placedAt ?? row.createdAt)}>
          {fmtShortDate(row.placedAt ?? row.createdAt)}
        </p>
      </div>
    ),
  },
  {
    // Due date + the stage countdown share one column (two lines) — they're
    // both "when does this need attention" and splitting them was two of the
    // columns pushing this table into a horizontal scroll.
    key: "due",
    label: "Due",
    sort: "due",
    width: "minmax(7rem,0.8fr)",
    priority: "core",
    render: (row) => (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {row.isOverdue && <span className="size-1.5 shrink-0 rounded-full bg-rose" aria-hidden="true" />}
          <span className={cn("truncate text-sm", row.isOverdue ? "font-medium text-rose" : "text-slate")}>
            {row.isOverdue ? `Overdue · ${fmtShortDate(row.dueAt)}` : fmtDate(row.dueAt)}
          </span>
        </div>
        <p
          className={cn("truncate text-xs", row.stageTimer.isOverdue ? "font-medium text-rose" : "text-slate")}
          title={row.stageTimer.followUpLabel ?? row.stageTimer.label}
        >
          {formatStageRemaining(row.stageTimer)} · {row.stageTimer.followUpLabel ?? row.stageTimer.label}
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

function fmtShortDate(value: string | null) {
  if (!value) return "No due date";
  return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short" }).format(new Date(value));
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
        <p className="text-xs font-semibold uppercase tracking-wide text-slate">What it means</p>
        <p className="text-sm leading-snug text-ink">{help.means}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate">What to do</p>
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
  pageSize,
  pageSizes,
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
  pageSize: number;
  pageSizes: number[];
}) {
  const router = useRouter();
  const toast = useToast();
  const isWide = useIsWide();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [designerId, setDesignerId] = useState("");
  const [targetStatus, setTargetStatus] = useState<OrderStatus | "">("");
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [columnPrefsLoaded, setColumnPrefsLoaded] = useState(false);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<ColumnKey[]>(DEFAULT_COLUMN_KEYS);
  const [scrolls, setScrolls] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pending, start] = useTransition();
  const selectedIds = useMemo(() => [...selected], [selected]);
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const visibleColumns = useMemo(() => {
    const selectedKeys = new Set(visibleColumnKeys);
    const columns = ORDER_COLUMNS.filter((column) => selectedKeys.has(column.key));
    return columns.length ? columns : ORDER_COLUMNS;
  }, [visibleColumnKeys]);
  // Source and Designer only earn a track once there's real room (xl+); below
  // that they're exactly the columns that used to force this table to scroll
  // sideways on a laptop with the sidebar open.
  const effectiveColumns = useMemo(
    () => (isWide ? visibleColumns : visibleColumns.filter((column) => column.priority === "core")),
    [visibleColumns, isWide],
  );
  const gridTemplateColumns = useMemo(
    () => ["1.75rem", ...effectiveColumns.map((column) => column.width), "6.5rem"].join(" "),
    [effectiveColumns],
  );

  // The Next action column is only sticky/tinted while the table is actually
  // scrolling sideways — at the widths this table is designed for (960px+
  // content) it fits, so it should read as a normal cell, not a pinned rail.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [effectiveColumns]);

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
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm text-slate">
        <span className="tabular-nums">
          {firstResult}-{lastResult} of {total}
        </span>
        <div className="relative">
          <Button type="button" size="sm" variant="ghost" onClick={() => setColumnMenuOpen((open) => !open)}>
            <Columns size={15} />
            Columns
          </Button>
          {columnMenuOpen && (
            <div className="absolute right-0 top-10 z-30 w-56 rounded-card bg-surface p-2 shadow-lg">
              <div className="flex items-center justify-between gap-2 border-b border-line/60 px-2 pb-2">
                <p className="text-xs font-semibold uppercase text-slate">Visible columns</p>
                <button type="button" onClick={resetColumns} className="text-xs font-medium text-pigment hover:text-ink">
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

      {/* Bulk actions only exist once something is selected: a floating bar
          above the phone tab bar, centred on desktop. */}
      {selected.size > 0 && (
        <div className="pointer-events-none fixed bottom-[5.5rem] left-3 right-[4.75rem] z-40 flex justify-center sm:inset-x-0 sm:bottom-6">
          <div className="pointer-events-auto flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-card bg-ink px-3 py-2.5 text-surface shadow-lg lg:w-auto">
            <span className="text-sm font-medium tabular-nums">{selected.size} selected</span>
            <select
              value={designerId}
              onChange={(event) => setDesignerId(event.currentTarget.value)}
              className="h-9 rounded-input bg-surface/10 px-2 text-sm text-surface outline-none focus-visible:ring-2 focus-visible:ring-surface [&>option]:text-ink"
              aria-label="Choose designer"
            >
              <option value="">Designer…</option>
              {designers.map((designer) => (
                <option key={designer.id} value={designer.id}>{designer.name}</option>
              ))}
            </select>
            <Button size="sm" variant="secondary" disabled={!designerId} loading={pending} onClick={reassign}>
              Reassign
            </Button>
            <select
              value={targetStatus}
              onChange={(event) => setTargetStatus(event.currentTarget.value as OrderStatus)}
              className="h-9 rounded-input bg-surface/10 px-2 text-sm text-surface outline-none focus-visible:ring-2 focus-visible:ring-surface [&>option]:text-ink"
              aria-label="Choose status"
            >
              <option value="">Status…</option>
              {BULK_STATUSES.map((status) => (
                <option key={status.value} value={status.value}>{status.label}</option>
              ))}
            </select>
            <Button size="sm" variant="secondary" disabled={!targetStatus} loading={pending} onClick={changeStatus}>
              Change status
            </Button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              aria-label="Clear selection"
              className="ml-auto inline-flex size-8 items-center justify-center rounded-input text-surface/70 transition-colors hover:bg-surface/10 hover:text-surface"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Desktop: the full operations table, one row per order. Column widths
          are tuned to fit with no horizontal scroll from ~960px of content
          width; overflow-x-auto stays only as a safety net (see `scrolls`) —
          the Next action rail only pins itself if that net is ever needed. */}
      <div ref={scrollRef} className="hidden overflow-x-auto md:block">
        <div
          className="hidden gap-2 border-b border-line/60 bg-surface px-4 py-2 text-xs font-medium text-slate md:grid md:[grid-template-columns:var(--orders-grid)]"
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
          {effectiveColumns.map((column) =>
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
          <span
            className={cn(
              "flex items-center justify-end pl-3 text-right",
              scrolls
                ? "z-20 text-pigment md:sticky md:right-0 md:-my-2.5 md:-mr-4 md:self-stretch md:border-l md:border-pigment/20 md:bg-pigment-soft md:py-2.5 md:pr-4"
                : "text-slate",
            )}
          >
            Next action
          </span>
        </div>

        <div className="divide-y divide-line/60">
          {rows.map((row) => {
            const urgent = row.stageTimer.isOverdue || row.isOverdue;
            const isSelected = selected.has(row.id);
            return (
              <div
                key={row.id}
                className={cn(
                  "group grid gap-2 px-4 py-3.5 transition-colors hover:bg-canvas/70 md:items-center md:[grid-template-columns:var(--orders-grid)]",
                  urgent && "bg-rose/[0.025] hover:bg-rose/[0.05]",
                  isSelected && "bg-pigment-soft/60 hover:bg-pigment-soft/80",
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
                {effectiveColumns.map((column) => (
                  <div key={column.key} className="min-w-0">
                    {column.render(row)}
                  </div>
                ))}
                <div
                  className={cn(
                    "flex items-center justify-end gap-1.5 pl-3",
                    scrolls &&
                      "md:sticky md:right-0 md:z-10 md:-my-3 md:-mr-4 md:self-stretch md:border-l md:border-pigment/20 md:bg-pigment-soft md:py-3 md:pr-4",
                  )}
                >
                  <OrderActions row={row} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Phone: one card per order — the table's columns read as labelled rows
          instead of squeezed into a horizontal scroll. */}
      <ul className="flex flex-col divide-y divide-line/60 md:hidden">
        {rows.map((row) => {
          const urgent = row.stageTimer.isOverdue || row.isOverdue;
          return (
            <li
              key={row.id}
              className={cn("p-4", urgent && "bg-rose/[0.025]", selected.has(row.id) && "bg-pigment-soft/60")}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => toggleOne(row.id)}
                  aria-label={`Select order ${row.orderNumber}`}
                  className="mt-1 size-5 shrink-0 rounded border-line text-pigment focus:ring-pigment"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/orders/${row.id}`} className="text-base font-semibold text-ink hover:text-pigment">
                        {row.orderNumber}
                      </Link>
                      <p className="truncate text-sm text-slate">{row.customer}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={statusTone(row)} dot>{row.derivedStatus}</Badge>
                    </div>
                  </div>
                  {row.reviewReason && <p className="mt-1.5 text-sm leading-snug text-amber">{row.reviewReason}</p>}
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                    <div>
                      <dt className="text-xs text-slate">Source</dt>
                      <dd className="text-ink">{row.source}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate">Designer</dt>
                      <dd className="truncate text-ink">{row.assignee}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate">Due</dt>
                      <dd className="text-ink">
                        {row.isOverdue && (
                          <Badge variant="danger" dot className="mb-1">
                            Overdue
                          </Badge>
                        )}
                        <span className="block">{fmtDate(row.dueAt)}</span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate">Stage time</dt>
                      <dd className={cn("font-medium", row.stageTimer.isOverdue ? "text-rose" : "text-ink")}>
                        {formatStageRemaining(row.stageTimer)}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3">
                    <OrderActions row={row} full />
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/60 px-4 py-2.5 text-sm text-slate">
        <div className="flex items-center gap-1">
          <span className="pr-1 text-xs">Rows</span>
          {pageSizes.map((size) => (
            <Link
              key={size}
              href={pageSizeHref(currentParams, size)}
              aria-current={pageSize === size ? "true" : undefined}
              className={cn(
                "inline-flex h-8 min-w-8 items-center justify-center rounded-input px-1.5 text-xs font-medium tabular-nums transition-colors",
                pageSize === size ? "bg-ink text-surface" : "text-slate hover:bg-canvas hover:text-ink",
              )}
            >
              {size}
            </Link>
          ))}
        </div>
        <Pagination currentParams={currentParams} page={page} totalPages={totalPages} />
      </div>
    </>
  );
}

function pageSizeHref(currentParams: string, size: number) {
  const params = new URLSearchParams(currentParams);
  params.set("pageSize", String(size));
  params.delete("page");
  return `/orders?${params.toString()}`;
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

function OrderActions({ row, full = false }: { row: OrdersDashboardRow; full?: boolean }) {
  // A row is "actionable" when there's a specific task to do; the generic
  // "Open" fallback stays quiet so the eye is drawn only to real work.
  const isTask = row.action.label !== "Open";
  return (
    <Link
      href={row.action.href}
      aria-label={`${row.action.label}, order ${row.orderNumber}`}
      className={cn(
        "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-input px-3 text-sm font-medium transition-[opacity,background-color,border-color] duration-[120ms]",
        full ? "h-11 w-full" : "h-10",
        isTask
          ? "bg-pigment text-surface shadow-sm hover:opacity-90"
          : "bg-canvas text-slate hover:bg-line/60 hover:text-ink",
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
