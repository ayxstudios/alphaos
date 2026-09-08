"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { createManualPrintJob } from "@/app/(app)/queue/print/actions";
import { TrackingCompleteForm } from "@/components/orders/tracking-complete-form";
import { Badge, Button, DataPanel, Select, useToast } from "@/components/ui";
import { AlertTriangle, ArrowRight, Printer, Truck } from "@/components/ui/icons";
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

  return (
    <DataPanel className={isTrouble ? "overflow-hidden border-rose/40" : "overflow-hidden"}>
      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold text-ink">Order {order.orderNumber}</h3>
                <Badge variant={chip.variant} dot>
                  {chip.label}
                </Badge>
                {age && <span className="text-xs text-slate">{age} old</span>}
              </div>
              <p className="text-sm text-slate">
                {order.shopName} · {order.source} · {order.customerName} · ordered {fmtDate(order.placedAt)}
              </p>
            </div>
            <Link href={`/orders/${order.id}`} className="text-sm font-medium text-pigment hover:text-ink">
              Open order
            </Link>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <Info label="Platform order" value={order.orderNumber} />
            <Info label="Shop" value={order.shopName} />
            <Info label="Customer" value={order.customerName} />
          </div>

          {job && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Info label="Provider" value={providerLabel(job.provider)} />
              <Info label="Provider status" value={job.providerStatus ?? "Not checked yet"} />
            </div>
          )}

          {job?.trackingNumber && (
            <div className="flex items-center gap-2 rounded-input border border-line bg-canvas px-3 py-2 text-sm">
              <Truck size={14} className="text-slate" />
              <span className="font-medium text-ink">{job.trackingNumber}</span>
              {job.trackingCompany && <span className="text-slate">via {job.trackingCompany}</span>}
              {job.trackingUrl && (
                <a href={job.trackingUrl} target="_blank" rel="noreferrer" className="ml-auto text-pigment hover:text-ink">
                  Track
                </a>
              )}
            </div>
          )}

          {order.artworkUrl && (
            <a
              href={order.artworkUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-pigment hover:text-ink"
            >
              Open latest portrait <ArrowRight size={14} />
            </a>
          )}
          {job?.platformSyncError && (
            <div className="rounded-input border border-rose/25 bg-rose/10 p-3 text-sm text-rose">
              Platform writeback failed: {job.platformSyncError}
            </div>
          )}

          {isTrouble && (
            <div className="flex flex-col gap-2 rounded-input border border-rose/30 bg-rose/5 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-rose">
                    {chip.label === "Missing at provider"
                      ? "No matching order was found at the provider."
                      : "The provider reported a problem with this order."}
                  </p>
                  <p className="mt-0.5 text-sm text-rose/90">
                    {job?.reconcileNote ?? job?.providerStatusReason ?? "Check the provider dashboard directly."}
                  </p>
                </div>
              </div>
              <a
                href={PROVIDER_DASHBOARD[job?.provider ?? order.defaultProvider]}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1 rounded-input border border-rose/40 bg-surface px-3 py-1.5 text-sm font-medium text-rose hover:bg-rose/10"
              >
                Open {providerLabel(job?.provider ?? order.defaultProvider)} dashboard <ArrowRight size={14} />
              </a>
            </div>
          )}
        </div>

        <div className="space-y-4 rounded-input border border-line bg-canvas p-4">
          <div className="flex items-center gap-2 font-medium text-ink">
            {inPrint ? <Truck size={16} /> : <Printer size={16} />}
            Print fulfilment
          </div>
          {canStart ? (
            <>
              <Select
                label="Provider"
                value={provider}
                disabled={pending}
                onChange={(e) => setProvider(e.currentTarget.value as PrintProvider)}
              >
                <option value="lumaprints">Luma Prints</option>
                <option value="gelato">Gelato</option>
              </Select>
              <Button type="button" disabled={pending} loading={pending} onClick={runStart}>
                <Printer size={15} />
                Sent to print
              </Button>
            </>
          ) : null}
          {inPrint && (
            <TrackingCompleteForm orderId={order.id} source={order.source} provider={activeProvider} />
          )}
        </div>
      </div>
    </DataPanel>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-input border border-line bg-canvas px-3 py-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-ink">{value}</p>
    </div>
  );
}
