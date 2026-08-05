"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";

import { Button, Card, CardContent, Input, Textarea, Select, Badge } from "@/components/ui";
import { XCircle, Camera } from "@/components/ui/icons";
import {
  createManualOrder,
  completeOrderDetails,
  presignReferenceUploads,
  lookupOrderByNumber,
} from "@/app/(app)/orders/new/actions";

export type ShopOption = {
  id: string;
  label: string;
  platform: "etsy" | "shopify";
  turnaroundDays: number;
};

/** Set in "complete" mode: an existing awaiting_details order the VA is filling in. */
export type ExistingOrder = {
  orderId: string;
  shopId: string;
  shopLabel: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  dueAt: string; // yyyy-mm-dd
  rawImport: unknown;
};

type Photo = { kind: "r2"; key: string; previewUrl: string; name: string } | { kind: "url"; url: string };
const MAX_BYTES = 25 * 1024 * 1024;

function newId() {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}
function dueDefault(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function NewOrderForm({
  shops,
  r2Enabled,
  existing,
}: {
  shops: ShopOption[];
  r2Enabled: boolean;
  existing?: ExistingOrder;
}) {
  const mode = existing ? "complete" : "create";
  const [orderId, setOrderId] = useState(() => existing?.orderId ?? newId());
  const [shopId, setShopId] = useState(existing?.shopId ?? shops[0]?.id ?? "");
  const [orderNumber, setOrderNumber] = useState(existing?.orderNumber ?? "");
  const [customerName, setCustomerName] = useState(existing?.customerName ?? "");
  const [customerEmail, setCustomerEmail] = useState(existing?.customerEmail ?? "");
  const [figureCount, setFigureCount] = useState("");
  const [style, setStyle] = useState("");
  const [productType, setProductType] = useState<"physical" | "digital">("physical");
  const [notes, setNotes] = useState("");
  const shop = shops.find((s) => s.id === shopId);
  const [dueAt, setDueAt] = useState(existing?.dueAt ?? dueDefault(shop?.turnaroundDays ?? 3));
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [urlInput, setUrlInput] = useState("");

  const [uploading, setUploading] = useState(false);
  const [submitting, startSubmit] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [dup, setDup] = useState<{ orderId: string; status: string; label: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Case 3: as the number is typed (create mode), look it up and warn on a match.
  useEffect(() => {
    if (mode !== "create") return;
    setDup(null);
    const n = orderNumber.trim();
    if (!n || !shopId) return;
    const t = setTimeout(async () => {
      const res = await lookupOrderByNumber({ shopId, orderNumber: n });
      if (res.found) setDup({ orderId: res.orderId, status: res.status, label: res.platformOrderName ?? n });
    }, 400);
    return () => clearTimeout(t);
  }, [orderNumber, shopId, mode]);

  function onShopChange(id: string) {
    setShopId(id);
    const s = shops.find((x) => x.id === id);
    setDueAt(dueDefault(s?.turnaroundDays ?? 3));
  }

  async function uploadFiles(files: File[]) {
    if (!shopId) return setError("Pick a shop first.");
    const tooBig = files.find((f) => f.size > MAX_BYTES);
    if (tooBig) return setError(`${tooBig.name} is over 25 MB.`);
    setError(null);
    setUploading(true);
    try {
      const res = await presignReferenceUploads({
        shopId,
        orderId,
        files: files.map((f) => ({ filename: f.name, contentType: f.type, size: f.size })),
      });
      if (!res.ok) throw new Error(res.message);
      await Promise.all(
        res.uploads.map(async (u, i) => {
          const put = await fetch(u.uploadUrl, { method: "PUT", headers: { "Content-Type": files[i].type }, body: files[i] });
          if (!put.ok) throw new Error(`Upload failed for ${files[i].name}`);
        }),
      );
      setPhotos((p) => [
        ...p,
        ...res.uploads.map((u, i) => ({ kind: "r2" as const, key: u.key, previewUrl: URL.createObjectURL(files[i]), name: files[i].name })),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function addUrls() {
    const urls = urlInput.split(/[\s,]+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
    if (urls.length) setPhotos((p) => [...p, ...urls.map((url) => ({ kind: "url" as const, url }))]);
    setUrlInput("");
  }

  function resetForNext() {
    setOrderId(newId());
    setOrderNumber("");
    setCustomerName("");
    setCustomerEmail("");
    setFigureCount("");
    setStyle("");
    setNotes("");
    setPhotos([]);
    setUrlInput("");
    setDup(null);
    setDueAt(dueDefault(shop?.turnaroundDays ?? 3));
    firstFieldRef.current?.focus();
  }

  function submit() {
    setError(null);
    setFlash(null);
    const r2Keys = photos.filter((p): p is Extract<Photo, { kind: "r2" }> => p.kind === "r2").map((p) => p.key);
    const photoUrls = photos.filter((p) => p.kind === "url").map((p) => p.url);
    startSubmit(async () => {
      if (mode === "complete" && existing) {
        const res = await completeOrderDetails({
          orderId: existing.orderId,
          figureCount: figureCount ? Number(figureCount) : null,
          style: style || undefined,
          productType,
          notes: notes || undefined,
          dueAt: dueAt || undefined,
          customerName: customerName || undefined,
          customerEmail: customerEmail || undefined,
          r2Keys,
          photoUrls,
        });
        if (res.ok) setFlash(`Completed ${res.orderNumber} → ${photos.length ? "ready to assign" : "awaiting photos"} ✓`);
        else setError(res.message);
        return;
      }
      const res = await createManualOrder({
        orderId,
        shopId,
        orderNumber: orderNumber || undefined,
        customerName: customerName || undefined,
        customerEmail: customerEmail || undefined,
        figureCount: figureCount ? Number(figureCount) : null,
        style: style || undefined,
        productType,
        notes: notes || undefined,
        dueAt: dueAt || undefined,
        r2Keys,
        photoUrls,
      });
      if (res.ok) {
        setFlash(`Created ${res.orderNumber} · ${photos.length ? "ready to assign" : "awaiting photos"} ✓`);
        resetForNext();
      } else {
        setError(res.message);
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
      e.preventDefault();
      if (!submitting && !uploading) submit();
    }
  }

  const done = mode === "complete" && flash;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4" onKeyDown={onKeyDown}>
        {mode === "complete" && existing ? (
          <div className="flex flex-col gap-2 rounded-input bg-canvas p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-ink">Order {existing.orderNumber}</span>
              <Badge variant="neutral">{existing.shopLabel}</Badge>
              <Badge variant="warning" dot>Needs details</Badge>
            </div>
            <details>
              <summary className="cursor-pointer text-xs text-pigment">Raw Etsy payload (personalization, note to seller)</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-input bg-surface p-2 text-[11px] text-ink">
                {JSON.stringify(existing.rawImport, null, 2)}
              </pre>
            </details>
          </div>
        ) : (
          <>
            <Select label="Business & shop" value={shopId} onChange={(e) => onShopChange(e.target.value)}>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </Select>
            <Input
              ref={firstFieldRef}
              label="Order number"
              hint="The real Etsy/Shopify number, so it reconciles on import"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              placeholder="e.g. PC31972"
              autoComplete="off"
            />
            {dup && (
              <p className="text-sm text-amber">
                Order {dup.label} already exists ({dup.status.replace(/_/g, " ")}).{" "}
                <Link
                  href={dup.status === "awaiting_details" ? `/orders/${dup.orderId}/complete` : `/orders/${dup.orderId}`}
                  className="font-medium text-pigment underline"
                >
                  Open it instead →
                </Link>
              </p>
            )}
          </>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Input label="Customer name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} autoComplete="off" />
          <Input label="Customer email" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} autoComplete="off" />
        </div>

        <div className="grid grid-cols-4 gap-3">
          <Input label="Figures" type="number" min={1} value={figureCount} onChange={(e) => setFigureCount(e.target.value)} />
          <Input label="Style" value={style} onChange={(e) => setStyle(e.target.value)} autoComplete="off" />
          <Select label="Product" value={productType} onChange={(e) => setProductType(e.target.value as "physical" | "digital")}>
            <option value="physical">Physical</option>
            <option value="digital">Digital</option>
          </Select>
          <Input label="Due date" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </div>

        <Textarea label="Notes / special requests (shown to the designer)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-ink">Reference photos</span>
          {r2Enabled ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void uploadFiles(Array.from(e.dataTransfer.files));
              }}
              onClick={() => fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-card border border-dashed border-line bg-canvas py-4 text-sm text-slate hover:border-pigment/40"
            >
              <Camera size={18} />
              {uploading ? "Uploading…" : "Drag & drop images here, or click to choose"}
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && void uploadFiles(Array.from(e.target.files))} />
            </div>
          ) : (
            <p className="text-xs text-amber">File upload unavailable (storage not configured) — paste URLs below.</p>
          )}
          <div className="flex items-end gap-2">
            <Input
              label="…or paste image URLs (Etsy/CDN — not downloaded)"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://i.etsystatic.com/…"
              autoComplete="off"
              className="flex-1"
            />
            <Button type="button" variant="secondary" size="sm" onClick={addUrls}>Add URL</Button>
          </div>
          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <span key={i} className="relative inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.kind === "r2" ? p.previewUrl : p.url} alt="" className="size-14 rounded-input border border-line object-cover" />
                  <button type="button" onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))} className="absolute -right-1.5 -top-1.5 rounded-full bg-surface text-slate hover:text-rose" aria-label="Remove photo">
                    <XCircle size={16} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <Button onClick={submit} loading={submitting} disabled={uploading || !shopId || !!done}>
            {mode === "complete" ? "Complete & send to pipeline" : "Create order"}
          </Button>
          <span className="text-xs text-slate">
            {photos.length > 0 ? "Lands in ready-to-assign & auto-assigns" : "No photos → lands in awaiting-photos"} · never emails the customer
          </span>
          {flash && <Badge variant="success" dot>{flash}</Badge>}
          {error && <span className="text-sm text-rose">{error}</span>}
          {done && (
            <Link href="/queue" className="text-sm font-medium text-pigment underline">Back to queue →</Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
