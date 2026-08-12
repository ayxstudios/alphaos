"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { createManualPrintJob } from "@/app/(app)/queue/print/actions";
import { TrackingCompleteForm } from "@/components/orders/tracking-complete-form";
import { Badge, Button, DataPanel, Select, useToast } from "@/components/ui";
import { ArrowRight, Printer, Truck } from "@/components/ui/icons";
import type { PrintProvider } from "@/lib/print/mapping";

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
    platformSyncError: string | null;
  } | null;
};

function fmtDate(value: string | null): string {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function PrintQueue({ orders }: { orders: PrintQueueItemVM[] }) {
  const ready = orders.filter((order) => order.status === "approved");
  const inPrint = orders.filter((order) => order.status === "printing");
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
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink">Ready to print</h2>
        {ready.length ? ready.map((order) => <PrintOrderCard key={order.id} order={order} />) : (
          <DataPanel className="p-4 text-sm text-slate">No approved physical orders waiting for print.</DataPanel>
        )}
      </section>
      {inPrint.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-ink">In print / tracking</h2>
          {inPrint.map((order) => <PrintOrderCard key={order.id} order={order} />)}
        </section>
      )}
    </div>
  );
}

function PrintOrderCard({ order }: { order: PrintQueueItemVM }) {
  const [provider, setProvider] = useState<PrintProvider>(order.defaultProvider);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const canStart = order.status === "approved";

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
    <DataPanel className="overflow-hidden">
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold text-ink">Order {order.orderNumber}</h3>
                <Badge variant={order.status === "printing" ? "info" : "success"}>
                  {order.status === "printing" ? "In print" : "Ready"}
                </Badge>
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
          {order.latestPrintJob?.platformSyncError && (
            <div className="rounded-input border border-rose/25 bg-rose/10 p-3 text-sm text-rose">
              Platform writeback failed: {order.latestPrintJob.platformSyncError}
            </div>
          )}
        </div>

        <div className="space-y-4 rounded-input border border-line bg-canvas p-4">
          <div className="flex items-center gap-2 font-medium text-ink">
            <Printer size={16} />
            Print signal
          </div>
          <Select label="Provider" value={provider} disabled={pending || !canStart} onChange={(e) => setProvider(e.currentTarget.value as PrintProvider)}>
            <option value="lumaprints">Luma Prints</option>
            <option value="gelato">Gelato</option>
          </Select>
          <Button type="button" disabled={pending || !canStart} loading={pending} onClick={runStart}>
            <Printer size={15} />
            Sent to print
          </Button>
          {order.status === "printing" && (
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                <Truck size={15} />
                Tracking
              </div>
              <TrackingCompleteForm orderId={order.id} source={order.source} />
            </div>
          )}
        </div>
      </div>
    </DataPanel>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-input border border-line bg-canvas px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-ink">{value}</p>
    </div>
  );
}
