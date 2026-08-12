"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { createManualPrintJob, saveOrderShippingAddress } from "@/app/(app)/queue/print/actions";
import { TrackingCompleteForm } from "@/components/orders/tracking-complete-form";
import { Badge, Button, DataPanel, Input, Select, useToast } from "@/components/ui";
import { AlertTriangle, ArrowRight, Printer, Truck } from "@/components/ui/icons";
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
  finalArtworkLabel: string;
  defaultProvider: PrintProvider;
  shippingAddress: {
    complete: boolean;
    source: string | null;
    name: string | null;
    company: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    countryCode: string | null;
    phone: string | null;
    email: string | null;
    lines: string[];
  };
  items: {
    id: string;
    sku: string | null;
    title: string | null;
    variation: string | null;
    quantity: number | null;
    mappings: Record<PrintProvider, { id: string; label: string; providerProductId: string } | null>;
  }[];
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
  if (!orders.length) {
    return (
      <DataPanel className="p-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <Printer size={28} className="text-slate" />
          <p className="font-medium text-ink">No physical orders are ready for print</p>
          <p className="max-w-md text-sm text-slate">
            Approved physical work will appear here with artwork, address, mapping, and tracking controls.
          </p>
        </div>
      </DataPanel>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {orders.map((order) => (
        <PrintOrderCard key={order.id} order={order} />
      ))}
    </div>
  );
}

function PrintOrderCard({ order }: { order: PrintQueueItemVM }) {
  const [provider, setProvider] = useState<PrintProvider>(order.defaultProvider);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const unmapped = useMemo(
    () => order.items.filter((item) => !item.mappings[provider]),
    [order.items, provider],
  );
  const blockers = [
    !order.shippingAddress.complete ? "Shipping address needed" : null,
    !order.artworkUrl ? "Final artwork needed" : null,
    unmapped.length ? `${unmapped.length} product mapping${unmapped.length === 1 ? "" : "s"} needed` : null,
  ].filter((blocker): blocker is string => !!blocker);
  const canStart = order.status === "approved" || order.status === "fulfillment_only";

  function runStart() {
    const formData = new FormData();
    formData.set("orderId", order.id);
    formData.set("provider", provider);
    start(async () => {
      const res = await createManualPrintJob(formData);
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? "Print job started" : "Print job blocked",
        description: res.message,
      });
      if (res.ok) router.refresh();
    });
  }

  return (
    <DataPanel className="overflow-hidden">
      <div className="grid gap-4 p-4 xl:grid-cols-[14rem_minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          <div className="aspect-[4/3] overflow-hidden rounded-input border border-line bg-canvas">
            {order.artworkUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={order.artworkUrl} alt="" className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate">No artwork</div>
            )}
          </div>
          {order.artworkUrl && (
            <a
              href={order.artworkUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-pigment hover:text-ink"
            >
              Open artwork <ArrowRight size={14} />
            </a>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-ink">Order {order.orderNumber}</h2>
                <Badge variant={order.status === "printing" ? "info" : blockers.length ? "warning" : "success"}>
                  {order.status === "printing" ? "In print" : blockers.length ? "Blocked" : "Ready to print"}
                </Badge>
              </div>
              <p className="text-sm text-slate">
                {order.shopName} · {order.source} · {order.customerName} · {fmtDate(order.placedAt)}
              </p>
            </div>
            <Link href={`/orders/${order.id}`} className="text-sm font-medium text-pigment hover:text-ink">
              Open order
            </Link>
          </div>

          {blockers.length > 0 && (
            <div className="rounded-input border border-amber/25 bg-amber/10 p-3 text-sm text-ink">
              <div className="mb-2 flex items-center gap-2 font-medium">
                <AlertTriangle size={15} />
                Blocked before print
              </div>
              <ul className="space-y-1 text-slate">
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {order.items.map((item) => {
              const mapping = item.mappings[provider];
              return (
                <div key={item.id} className="rounded-input border border-line p-3">
                  <p className="font-medium text-ink">{item.title ?? "Untitled product"}</p>
                  <p className="mt-1 text-xs text-slate">{item.variation || "No variant details"}</p>
                  <p className="mt-1 text-xs text-slate">SKU: {item.sku || "None"}</p>
                  <div className="mt-2">
                    {mapping ? (
                      <Badge variant="success">{mapping.label}</Badge>
                    ) : (
                      <Badge variant="warning">No {provider} mapping</Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <AddressForm order={order} />
        </div>

        <div className="space-y-4 rounded-input border border-line bg-canvas p-4">
          <div className="flex items-center gap-2 font-medium text-ink">
            <Printer size={16} />
            Print controls
          </div>
          <Select label="Provider" value={provider} disabled={pending || order.status === "printing"} onChange={(e) => setProvider(e.currentTarget.value as PrintProvider)}>
            <option value="lumaprints">Luma Prints</option>
            <option value="gelato">Gelato</option>
          </Select>
          <Button
            type="button"
            disabled={pending || !canStart || blockers.length > 0 || order.status === "printing"}
            loading={pending}
            onClick={runStart}
          >
            <Printer size={15} />
            Start manual print
          </Button>
          {order.latestPrintJob?.platformSyncError && (
            <div className="rounded-input border border-rose/25 bg-rose/10 p-3 text-sm text-rose">
              Platform writeback failed: {order.latestPrintJob.platformSyncError}
            </div>
          )}
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

function AddressForm({ order }: { order: PrintQueueItemVM }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const a = order.shippingAddress;

  function save(formData: FormData) {
    formData.set("orderId", order.id);
    start(async () => {
      const res = await saveOrderShippingAddress(formData);
      toast({
        variant: res.ok ? "success" : "danger",
        title: res.ok ? "Address saved" : "Address not saved",
        description: res.message,
      });
      if (res.ok) router.refresh();
    });
  }

  return (
    <form action={save} className="rounded-input border border-line p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-ink">Shipping address</p>
          <p className="text-xs text-slate">
            {a.complete ? `Complete · ${a.source ?? "unknown"}` : "Required before print"}
          </p>
        </div>
        {a.lines.length > 0 && (
          <div className="text-right text-xs text-slate">
            {a.lines.slice(0, 3).map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Input name="name" label="Name" defaultValue={a.name ?? ""} disabled={pending} />
        <Input name="company" label="Company" defaultValue={a.company ?? ""} disabled={pending} />
        <Input name="addressLine1" label="Address line 1" defaultValue={a.addressLine1 ?? ""} disabled={pending} />
        <Input name="addressLine2" label="Address line 2" defaultValue={a.addressLine2 ?? ""} disabled={pending} />
        <Input name="city" label="City" defaultValue={a.city ?? ""} disabled={pending} />
        <Input name="state" label="State" defaultValue={a.state ?? ""} disabled={pending} />
        <Input name="postalCode" label="Postal code" defaultValue={a.postalCode ?? ""} disabled={pending} />
        <Input name="countryCode" label="Country" defaultValue={a.countryCode ?? ""} disabled={pending} />
        <Input name="phone" label="Phone" defaultValue={a.phone ?? ""} disabled={pending} />
        <Input name="email" label="Email" defaultValue={a.email ?? ""} disabled={pending} />
      </div>
      <Button type="submit" size="sm" className="mt-3" loading={pending} disabled={pending}>
        Save address
      </Button>
    </form>
  );
}
