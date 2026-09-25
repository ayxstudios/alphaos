"use client";

import { useState, useTransition } from "react";

import { addTrackingAndCompleteOrder } from "@/app/(app)/orders/actions";
import { Button, Input, Select, useToast } from "@/components/ui";
import { CheckCircle, Truck } from "@/components/ui/icons";
import type { PrintProvider } from "@/lib/print/mapping";

function providerLabel(provider: PrintProvider): string {
  return provider === "lumaprints" ? "Luma Prints" : "Gelato";
}

export function TrackingCompleteForm({
  orderId,
  source,
  provider,
  disabled = false,
  bare = false,
  onCancel,
}: {
  orderId: string;
  source: "etsy" | "shopify" | "manual";
  provider?: PrintProvider;
  disabled?: boolean;
  /** No top rule or margin: the caller already frames the form (the Print card). */
  bare?: boolean;
  /** Shows a Cancel button that closes the form without saving. */
  onCancel?: () => void;
}) {
  const toast = useToast();
  const [selectedProvider, setSelectedProvider] = useState<PrintProvider>(provider ?? "gelato");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingCompany, setTrackingCompany] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [showTrackingUrl, setShowTrackingUrl] = useState(false);
  const [notifyCustomer, setNotifyCustomer] = useState(source === "shopify");
  const [pending, start] = useTransition();
  const isShopify = source === "shopify";
  const activeProvider = provider ?? selectedProvider;
  const providerLocked = Boolean(provider);

  function submit() {
    start(async () => {
      const res = await addTrackingAndCompleteOrder({
        orderId,
        provider: activeProvider,
        trackingNumber,
        trackingCompany,
        trackingUrl,
        notifyCustomer,
      });
      if (!res.ok) {
        toast({ variant: "danger", title: "Tracking not saved", description: res.message });
        return;
      }
      toast({
        variant: res.closeWarning ? "warning" : "success",
        title: res.closeWarning ? "Tracking saved, but check Shopify" : "Tracking saved",
        description: res.closeWarning ?? res.message,
      });
      setTrackingNumber("");
      setTrackingCompany("");
      setTrackingUrl("");
      setShowTrackingUrl(false);
    });
  }

  return (
    <div className={bare ? undefined : "mt-4 border-t border-line/60 pt-4"}>
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <Truck size={16} />
        Add shipping tracking
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {providerLocked ? (
          <div className="rounded-input bg-canvas px-3 py-2">
            <p className="text-xs font-medium text-slate">Print provider</p>
            <p className="mt-1 text-sm font-medium text-ink">{providerLabel(activeProvider)}</p>
          </div>
        ) : (
          <Select
            label="Print provider"
            value={selectedProvider}
            disabled={disabled || pending}
            onChange={(event) => setSelectedProvider(event.currentTarget.value as PrintProvider)}
          >
            <option value="gelato">Gelato</option>
            <option value="lumaprints">Luma Prints</option>
          </Select>
        )}
        <Input
          label="Tracking number"
          value={trackingNumber}
          disabled={disabled || pending}
          onChange={(event) => setTrackingNumber(event.currentTarget.value)}
        />
        <Input
          label="Carrier"
          value={trackingCompany}
          disabled={disabled || pending}
          placeholder="USPS, UPS, FedEx..."
          onChange={(event) => setTrackingCompany(event.currentTarget.value)}
        />
        {showTrackingUrl ? (
          <Input
            label="Tracking link"
            type="url"
            value={trackingUrl}
            disabled={disabled || pending}
            placeholder="https://..."
            onChange={(event) => setTrackingUrl(event.currentTarget.value)}
          />
        ) : (
          <button
            type="button"
            className="inline-flex min-h-11 w-fit items-center text-sm font-medium text-pigment transition-colors hover:text-ink disabled:opacity-50 sm:min-h-0"
            disabled={disabled || pending}
            onClick={() => setShowTrackingUrl(true)}
          >
            Add a tracking link
          </button>
        )}
        {isShopify && (
          <label className="flex items-start gap-2 rounded-input bg-canvas p-3 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-1 size-4 rounded border-line"
              checked={notifyCustomer}
              disabled={disabled || pending}
              onChange={(event) => setNotifyCustomer(event.currentTarget.checked)}
            />
            <span>Email the customer their tracking from Shopify</span>
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            loading={pending}
            disabled={disabled || !trackingNumber.trim()}
            onClick={submit}
          >
            <CheckCircle size={15} />
            Save tracking and mark shipped
          </Button>
          {onCancel && (
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
