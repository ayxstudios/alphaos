"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { createManualPrintJob } from "@/app/(app)/queue/print/actions";
import { TrackingCompleteForm } from "@/components/orders/tracking-complete-form";
import { Badge, Button, DataPanel, Disclosure, Select, useToast } from "@/components/ui";
import { AlertTriangle, ArrowRight, Printer, Truck } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { PrintProvider } from "@/lib/print/mapping";

export type ReconcileState =
  | "unchecked"
  | "pending"
  | "matched"
  | "shipped"
  | "delivered"
  | "missing"
  | "problem"
  | "not_configured"
  | string
  | null;

export type PrintQueueItemVM = {
  id: string;
  orderNumber: string;
  source: "etsy" | "shopify" | "manual";
  status: string;
  shopName: string;
  customerName: string;
  placedAt: string | null;
  artworkUrl: string | null;
  defaultProvider: PrintProvider;
  latestPrintJob: {
    provider: PrintProvider;
    status: string | null;
    trackingNumber: string | null;
    trackingCompany?: string | null;
    trackingUrl?: string | null;
    platformSyncError: string | null;
    submittedAt?: string | null;
    providerStatus?: string | null;
    providerStatusReason?: string | null;
    providerCheckedAt?: string | null;
    reconcileState?: ReconcileState;
    reconcileNote?: string | null;
    missingFlaggedAt?: string | null;
  } | null;
};

const PROVIDER_DASHBOARD: Record<PrintProvider, string> = {
  gelato: "https://dashboard.gelato.com/orders",
  lumaprints: "https://dashboard.lumaprints.com/orders",
};

function providerLabel(provider: PrintProvider): string {
  return provider === "lumaprints" ? "Luma Prints" : "Gelato";
}

function fmtDate(value: string | null): string {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function fmtAge(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 0) return null;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "under an hour";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

type ChipInfo = { label: string; variant: "neutral" | "info" | "success" | "warning" | "danger" };

function deriveChip(order: PrintQueueItemVM): ChipInfo {
  const job = order.latestPrintJob;
  const state = job?.reconcileState ?? null;
  if (order.status === "approved" && !job) return { label: "Needs sending", variant: "neutral" };
  if (state === "missing") return { label: "Missing at provider", variant: "danger" };
  if (state === "problem") return { label: "Problem at provider", variant: "danger" };
  if (state === "shipped" || state === "delivered") return { label: "Shipped", variant: "success" };
  if (order.status === "approved") return { label: "Needs sending", variant: "neutral" };
  return { label: "Sent, waiting", variant: "info" };
}

export function PrintQueue({ orders }: { orders: PrintQueueItemVM[] }) {
  if (!orders.length) {
    return (
      <DataPanel className="p-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <Printer size={28} className="text-slate" />
          <p className="font-medium text-ink">No physical orders are ready for print</p>
          <p className="max-w-md text-sm text-slate">
            Approved physical work will appear here when it needs a VA to trigger printing in Gelato or Luma Prints.
          </p>
        </div>
      </DataPanel>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {orders.map((order) => <PrintOrderCard key={order.id} order={order} />)}
    </div>
  );
}

function PrintOrderCard({ order }: { order: PrintQueueItemVM }) {
  const activeProvider = order.latestPrintJob?.provider ?? order.defaultProvider;
  const [provider, setProvider] = useState<PrintProvider>(activeProvider);
  const [trackingOpen, setTrackingOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const canStart = order.status === "approved";
  const inPrint = order.status === "printing";
  const job = order.latestPrintJob;
  const chip = deriveChip(order);
  const isTrouble = chip.variant === "danger";
  const age = fmtAge(job?.submittedAt ?? order.placedAt ?? null);

  function runStart() {
    const formData = new FormData();
    formData.set("orderId", order.id);
    formData.set("provider", provider);
    start(async () => {
      const res = await createManualPrintJob(formData);
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? "Sent to print" : "Print signal not recorded",
        description: res.message,
      });
      if (res.ok) router.refresh();
    });
  }

  const providerName = providerLabel(job?.provider ?? order.defaultProvider);
  const statusLine = job
    ? `${providerName} · ${job.providerStatus ?? "not checked yet"}`
    : `Not sent yet · will go to ${providerLabel(provider)}`;

  return (
    <DataPanel className="overflow-hidden">
      <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:gap-6">
        {/* Who and what, one line each. */}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/orders/${order.id}`} className="text-base font-semibold text-ink hover:text-pigment">
              {order.orderNumber}
            </Link>
            <Badge variant={chip.variant} dot={isTrouble}>{chip.label}</Badge>
            {age && <span className="text-xs text-slate">{age}</span>}
          </div>
          <p className="truncate text-sm text-slate">
            {order.customerName} · {order.shopName} · ordered {fmtDate(order.placedAt)}
          </p>
          <p className={cn("flex items-center gap-1.5 text-sm", isTrouble ? "text-rose" : "text-ink")}>
            {isTrouble ? <AlertTriangle size={14} className="shrink-0" /> : inPrint ? <Truck size={14} className="shrink-0 text-slate" /> : <Printer size={14} className="shrink-0 text-slate" />}
            <span className="truncate">{statusLine}</span>
          </p>

          {isTrouble && (
            <p className="text-sm text-rose/90">
              {chip.label === "Missing at provider" ? "No matching order at the provider. " : "The provider reported a problem. "}
              {job?.reconcileNote ?? job?.providerStatusReason ?? ""}
            </p>
          )}

          {job?.trackingNumber && (
            <p className="flex items-center gap-2 text-sm">
              <Truck size={14} className="text-slate" />
              <span className="font-medium text-ink">{job.trackingNumber}</span>
              {job.trackingCompany && <span className="text-slate">via {job.trackingCompany}</span>}
              {job.trackingUrl && (
                <a href={job.trackingUrl} target="_blank" rel="noreferrer" className="text-pigment hover:text-ink">Track</a>
              )}
            </p>
          )}

          {job?.platformSyncError && (
            <p className="text-sm text-rose">Platform writeback failed: {job.platformSyncError}</p>
          )}
        </div>

        {/* The one thing to do. */}
        <div className="w-full shrink-0 lg:w-72">
          {canStart && (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Select label="Provider" value={provider} disabled={pending} onChange={(e) => setProvider(e.currentTarget.value as PrintProvider)}>
                  <option value="lumaprints">Luma Prints</option>
                  <option value="gelato">Gelato</option>
                </Select>
              </div>
              <Button type="button" disabled={pending} loading={pending} onClick={runStart}>
                <Printer size={15} />
                Sent to print
              </Button>
            </div>
          )}
          {inPrint && !trackingOpen && (
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => setTrackingOpen(true)}>
                <Truck size={15} />
                Add tracking
              </Button>
            </div>
          )}
          {inPrint && trackingOpen && <TrackingCompleteForm orderId={order.id} source={order.source} provider={activeProvider} />}
        </div>
      </div>

      <Disclosure summary="Details" className="rounded-none shadow-none border-t border-line/70">
        <div className="grid gap-2 sm:grid-cols-3">
          <Info label="Platform order" value={order.orderNumber} />
          <Info label="Shop" value={order.shopName} />
          <Info label="Customer" value={order.customerName} />
          <Info label="Source" value={order.source} />
          <Info label="Provider" value={job ? providerLabel(job.provider) : providerLabel(provider)} />
          <Info label="Provider status" value={job?.providerStatus ?? "Not checked yet"} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          {order.artworkUrl && (
            <a href={order.artworkUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-pigment hover:text-ink">
              Open latest portrait <ArrowRight size={14} />
            </a>
          )}
          <a
            href={PROVIDER_DASHBOARD[job?.provider ?? order.defaultProvider]}
            target="_blank"
            rel="noreferrer"
            className={cn("inline-flex items-center gap-1 font-medium hover:text-ink", isTrouble ? "text-rose" : "text-pigment")}
          >
            Open {providerName} dashboard <ArrowRight size={14} />
          </a>
          <Link href={`/orders/${order.id}`} className="font-medium text-pigment hover:text-ink">Open order</Link>
        </div>
      </Disclosure>
    </DataPanel>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-input bg-canvas px-3 py-2">
      <p className="text-xs text-slate">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium text-ink">{value}</p>
    </div>
  );
}
