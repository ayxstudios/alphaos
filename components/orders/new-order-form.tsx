"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";

import { Button, Card, CardContent, Input, Textarea, Select, Badge } from "@/components/ui";
import { XCircle, Camera, AlertTriangle, CheckCircle, Plus } from "@/components/ui/icons";
import {
  createManualOrder,
  completeOrderDetails,
  presignReferenceUploads,
  lookupOrderByNumber,
} from "@/app/(app)/orders/new/actions";
import {
  missingReviewFields,
  parseEtsyReceiptReview,
  reviewDefaults,
  type EtsyReceiptReview,
} from "@/lib/integrations/etsy/receipt-review";

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
  status: string;
  customerName: string;
  customerEmail: string;
  dueAt: string; // yyyy-mm-dd
  dueAtIso: string | null;
  dueDateSource: "internal_sla" | "etsy_expected_ship_date" | "manual" | "unknown";
  placedAtIso: string | null;
  savedProductTitle: string;
  savedFigureCount: number | null;
  savedStyle: string;
  savedProductType: "physical" | "digital" | null;
  savedNotes: string;
  photoCount: number;
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
function formatDate(iso: string | null | undefined) {
  if (!iso) return "Unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", year: "numeric" }).format(date);
}
function isOverdue(iso: string | null | undefined) {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(date);
  due.setHours(0, 0, 0, 0);
  return due < today;
}
function dueSourceLabel(source: ExistingOrder["dueDateSource"]) {
  if (source === "internal_sla") return "Internal SLA";
  if (source === "etsy_expected_ship_date") return "Etsy expected ship date";
  if (source === "manual") return "Manual";
  return "Unknown";
}
function usefulVariations(tx: EtsyReceiptReview["transactions"][number]) {
  return tx.variations.filter((v) => v.label.toLowerCase() !== "personalization");
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
  const etsyReview = useMemo(
    () => parseEtsyReceiptReview(existing?.rawImport),
    [existing?.rawImport],
  );
  const initial = useMemo(
    () =>
      existing
        ? reviewDefaults(etsyReview, {
            customerName: existing.customerName,
            customerEmail: existing.customerEmail,
            figureCount: existing.savedFigureCount,
            style: existing.savedStyle,
            productTitle: existing.savedProductTitle,
            productType: existing.savedProductType,
            notes: existing.savedNotes,
            photoCount: existing.photoCount,
          })
        : null,
    [etsyReview, existing],
  );
  const [orderId, setOrderId] = useState(() => existing?.orderId ?? newId());
  const [shopId, setShopId] = useState(existing?.shopId ?? shops[0]?.id ?? "");
  const [orderNumber, setOrderNumber] = useState(existing?.orderNumber ?? "");
  const [customerName, setCustomerName] = useState(initial?.customerName ?? existing?.customerName ?? "");
  const [customerEmail, setCustomerEmail] = useState(initial?.customerEmail ?? existing?.customerEmail ?? "");
  const [figureCount, setFigureCount] = useState(initial?.figureCount ?? "");
  const [style, setStyle] = useState(initial?.style ?? "");
  const [productTitle, setProductTitle] = useState(initial?.productTitle ?? "");
  const [productType, setProductType] = useState<"physical" | "digital">(initial?.productType ?? "physical");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const shop = shops.find((s) => s.id === shopId);
  const [dueAt, setDueAt] = useState(existing?.dueAt ?? dueDefault(shop?.turnaroundDays ?? 3));
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [submitting, startSubmit] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [dup, setDup] = useState<{ orderId: string; status: string; label: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const effectivePhotoCount = (existing?.photoCount ?? 0) + photos.length;
  const missing = mode === "complete"
    ? missingReviewFields({ customerEmail, style, photoCount: effectivePhotoCount })
    : [];

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
    setProductTitle("");
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
          productTitle: productTitle || undefined,
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
        productTitle: productTitle || undefined,
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
  const completeAction = photos.length > 0 ? "Save & send to production" : "Save details → Awaiting photos";

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4" onKeyDown={onKeyDown}>
        {mode === "complete" && existing ? (
          <>
            <section className="flex flex-col gap-3 rounded-input border border-line bg-canvas p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-ink">Imported from Etsy</h2>
                  <p className="text-xs text-slate">Review the Etsy data, then fill only what is still missing.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="neutral">{existing.shopLabel}</Badge>
                  {isOverdue(existing.dueAtIso) && <Badge variant="danger" dot>Overdue</Badge>}
                </div>
              </div>

              <div className="grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <div className="text-xs font-medium text-slate">Buyer</div>
                  <div className="font-medium text-ink">{etsyReview.buyerName ?? "Unknown"}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-slate">Order date</div>
                  <div className="font-medium text-ink">{formatDate(etsyReview.orderDateIso ?? existing.placedAtIso)}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-slate">Due date</div>
                  <div className="font-medium text-ink">{formatDate(existing.dueAtIso)}</div>
                  <div className="text-xs text-slate">{dueSourceLabel(existing.dueDateSource)}</div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {etsyReview.transactions.length === 0 ? (
                  <p className="text-sm text-amber">No Etsy line items were found in the imported payload.</p>
                ) : (
                  etsyReview.transactions.map((tx, i) => (
                    <div key={tx.id ?? i} className="rounded-input border border-line bg-surface p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-ink">{tx.title ?? "Untitled listing"}</div>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {tx.quantity != null && <Badge variant="neutral">Qty {tx.quantity}</Badge>}
                            {tx.fulfillment && <Badge variant={tx.fulfillment === "physical" ? "info" : "success"}>{tx.fulfillment === "physical" ? "Physical fulfilment" : "Digital fulfilment"}</Badge>}
                            {tx.productCategory && <Badge variant="neutral">{tx.productCategory}</Badge>}
                          </div>
                        </div>
                      </div>
                      {usefulVariations(tx).length > 0 && (
                        <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                          {usefulVariations(tx).map((variation) => (
                            <div key={`${variation.label}-${variation.value}`} className="flex gap-2">
                              <dt className="shrink-0 text-slate">{variation.label}:</dt>
                              <dd className="font-medium text-ink">{variation.value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {tx.personalization && (
                        <div className="mt-2 rounded-input bg-pigment-soft p-2">
                          <div className="text-xs font-medium text-pigment">Personalisation / customer request</div>
                          <p className="whitespace-pre-wrap text-sm text-ink">{tx.personalization}</p>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {etsyReview.buyerNote && (
                <div className="rounded-input border border-line bg-surface p-3">
                  <div className="text-xs font-medium text-slate">Buyer note</div>
                  <p className="whitespace-pre-wrap text-sm text-ink">{etsyReview.buyerNote}</p>
                </div>
              )}
            </section>

            <section className="rounded-input border border-line bg-surface p-3">
              <div className="mb-2 flex items-center gap-2">
                {missing.length ? <AlertTriangle size={16} className="text-amber" /> : <CheckCircle size={16} className="text-sage" />}
                <h2 className="text-sm font-semibold text-ink">Still needed</h2>
              </div>
              {missing.length ? (
                <div className="flex flex-wrap gap-2">
                  {missing.map((field) => <Badge key={field} variant="warning" dot>{field}</Badge>)}
                </div>
              ) : (
                <p className="text-sm text-sage">All required review details are present.</p>
              )}
            </section>
          </>
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

        <div className="grid gap-3 sm:grid-cols-5">
          <Input label="Figures" type="number" min={1} value={figureCount} onChange={(e) => setFigureCount(e.target.value)} />
          <Input label="Style" value={style} onChange={(e) => setStyle(e.target.value)} autoComplete="off" />
          <Input label="Product/category" value={productTitle} onChange={(e) => setProductTitle(e.target.value)} autoComplete="off" />
          <Select label="Fulfilment" value={productType} onChange={(e) => setProductType(e.target.value as "physical" | "digital")}>
            <option value="physical">Physical</option>
            <option value="digital">Digital</option>
          </Select>
          <Input label="Due date" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </div>

        <Textarea label="Notes / special requests (shown to the designer)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />

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
              className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-card border border-dashed border-line bg-canvas py-5 text-sm text-slate hover:border-pigment/40"
            >
              <Camera size={18} />
              {uploading ? "Uploading…" : "Drag & drop images here, or click to choose"}
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && void uploadFiles(Array.from(e.target.files))} />
            </div>
          ) : (
            <p className="text-xs text-amber">File upload unavailable (storage not configured) — paste URLs below.</p>
          )}
          {!showUrlInput ? (
            <Button type="button" variant="secondary" size="sm" className="w-fit" onClick={() => setShowUrlInput(true)}>
              <Plus size={14} /> Add image URL
            </Button>
          ) : (
            <div className="flex items-end gap-2">
              <Input
                label="Image URLs (Etsy/CDN - not downloaded)"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://i.etsystatic.com/..."
                autoComplete="off"
                className="flex-1"
              />
              <Button type="button" variant="secondary" size="sm" onClick={addUrls}>Add URL</Button>
            </div>
          )}
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
            {mode === "complete" ? completeAction : "Create order"}
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

        {mode === "complete" && existing && (
          <details className="border-t border-line pt-3">
            <summary className="cursor-pointer text-xs font-medium text-slate">Developer data</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-input bg-canvas p-2 text-[11px] text-ink">
              {JSON.stringify(existing.rawImport, null, 2)}
            </pre>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
