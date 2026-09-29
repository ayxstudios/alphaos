import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { Badge, DataPanel, SectionHeader } from "@/components/ui";
import { AlertTriangle, Package, Truck } from "@/components/ui/icons";
import { withUserContext, type RequestUser } from "@/lib/db";
import { printJobs } from "@/lib/db/schema";
import { sizedImageUrl } from "@/lib/images";
import { probePrintFileSize } from "@/lib/print/file-probe";
import type { PrintProvider } from "@/lib/print/mapping";
import { preparePrintOrder, PROVIDER_LABEL, type PrintPlan } from "@/lib/print/prepare";
import { routingReasonLabel } from "@/lib/print/routing";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import { formatAt } from "@/lib/time";
import { PrintSubmitButton } from "./print-submit-button";

/**
 * "Print and ship" (docs/AGENT_FIRST.md 3.2). On an approved physical order the
 * agent's prepared print order in one glance (file, product + size, provider,
 * cost, address) with one Submit tap; once a print job exists, where it is
 * (provider status, provider order number, tracking).
 */

// A job in one of these no longer holds the order (lib/print/submit.ts).
const INACTIVE = ["submit_failed", "rejected", "failed", "canceled", "cancelled"];

function money(amount: number | null, currency: string | null): string | null {
  if (amount == null) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ""}`.trim();
  }
}

function fmtDateTime(date: Date | null) {
  return date ? formatAt(date, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
}

function statusLabel(value: string | null): string {
  if (!value) return "Waiting for the provider";
  return value.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
}

async function thumbnailUrl(plan: PrintPlan): Promise<string | null> {
  const file = plan.file;
  if (!file) return null;
  if (file.storage === "cdn" && file.url) return sizedImageUrl(file.url, 240);
  if (file.r2Key && isR2Configured()) return presignGet(file.r2Key).catch(() => null);
  return null;
}

export async function PrintShipCard({
  user,
  orderId,
  orderStatus,
  requestedProvider,
}: {
  user: RequestUser;
  orderId: string;
  orderStatus: string;
  requestedProvider: PrintProvider | null;
}) {
  const [jobs, plan] = await Promise.all([
    withUserContext(user, (tx) =>
      tx
        .select({
          id: printJobs.id,
          provider: printJobs.provider,
          method: printJobs.method,
          status: printJobs.status,
          providerStatus: printJobs.providerStatus,
          providerOrderId: printJobs.providerOrderId,
          providerOrderNumber: printJobs.providerOrderNumber,
          trackingNumber: printJobs.trackingNumber,
          trackingCompany: printJobs.trackingCompany,
          trackingUrl: printJobs.trackingUrl,
          error: printJobs.error,
          rejectedAt: printJobs.rejectedAt,
          submittedAt: printJobs.submittedAt,
          shippedAt: printJobs.shippedAt,
        })
        .from(printJobs)
        .where(eq(printJobs.orderId, orderId))
        .orderBy(desc(printJobs.createdAt)),
    ),
    orderStatus === "approved"
      ? withUserContext(user, (tx) => preparePrintOrder(orderId, { tx, provider: requestedProvider }))
      : Promise.resolve(null),
  ]);

  const active = jobs.find((job) => !job.rejectedAt && !INACTIVE.includes(job.status ?? "")) ?? null;
  const failed = !active ? (jobs.find((job) => job.rejectedAt || INACTIVE.includes(job.status ?? "")) ?? null) : null;

  if (active) {
    const shipped = Boolean(active.trackingNumber);
    return (
      <DataPanel id="print" className="scroll-mt-20 p-4">
        <SectionHeader
          title="Print and ship"
          actions={<Badge variant={shipped ? "success" : "info"} dot>{shipped ? "Shipped" : "At the printer"}</Badge>}
        />
        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs font-medium text-slate">Provider</dt>
            <dd className="mt-0.5 break-words font-medium text-ink">
              {PROVIDER_LABEL[active.provider]}
              {active.method !== "api" && <span className="font-normal text-slate"> · {active.method}</span>}
            </dd>
            {active.submittedAt && <p className="mt-0.5 text-xs text-slate">Sent {fmtDateTime(active.submittedAt)}</p>}
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium text-slate">Provider order</dt>
            <dd className="mt-0.5 break-all font-medium text-ink">
              {active.providerOrderNumber ?? active.providerOrderId ?? "Not assigned yet"}
            </dd>
            <p className="mt-0.5 text-xs text-slate">{statusLabel(active.providerStatus ?? active.status)}</p>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium text-slate">Tracking</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 break-all font-medium text-ink">
              <Truck size={14} className="shrink-0 text-slate" />
              {active.trackingNumber ?? "Not shipped yet"}
            </dd>
            {active.trackingCompany && <p className="mt-0.5 text-xs text-slate">{active.trackingCompany}</p>}
            {active.trackingUrl && (
              <a
                href={active.trackingUrl}
                target="_blank"
                rel="noreferrer"
                className="-my-2 inline-flex min-h-11 items-center text-xs font-medium text-pigment hover:text-ink sm:my-0 sm:min-h-0"
              >
                Open tracking
              </a>
            )}
          </div>
        </dl>
        {!shipped && (
          <p className="mt-3 text-xs text-slate">
            Tracking is checked automatically; the order moves to shipped and the customer gets the shipped email when it lands.
          </p>
        )}
      </DataPanel>
    );
  }

  if (!plan) return null;

  const [thumb, size] = await Promise.all([thumbnailUrl(plan), probePrintFileSize(plan.file)]);
  const provider = plan.provider;
  const other = plan.availableProviders.find((p) => p !== provider) ?? null;
  const item = plan.items[0] ?? null;
  const cost = money(plan.totalCost, plan.currency);
  const costReason = plan.items.find((i) => i.unitCost == null)?.costReason ?? null;
  const address = plan.address;
  const reason = plan.requestedProvider ? "picked by you" : routingReasonLabel(plan.routingReason);

  return (
    <DataPanel id="print" className="scroll-mt-20 p-4">
      <SectionHeader title="Print and ship" description="Prepared by the agent. Check it, then send it in one tap." />

      {failed && (
        <p className="mt-3 rounded-input bg-rose/10 p-3 text-sm text-rose">
          Last attempt with {PROVIDER_LABEL[failed.provider]} did not go through{failed.error ? `: ${failed.error}` : "."}
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* File */}
        <div className="flex min-w-0 items-start gap-3 rounded-input bg-canvas p-3">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumb}
              alt="Print file"
              loading="lazy"
              decoding="async"
              className="size-16 shrink-0 rounded-input object-cover shadow-card"
            />
          ) : (
            <span className="inline-flex size-16 shrink-0 items-center justify-center rounded-input bg-surface text-slate shadow-card">
              <Package size={18} />
            </span>
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate">Print file</p>
            <p className="mt-0.5 break-all text-sm font-medium text-ink">{plan.file?.name ?? "No final file"}</p>
            <p className="mt-0.5 text-xs text-slate">
              {plan.file ? (size ? `${size.width} x ${size.height} px` : "Resolution not readable") : "Upload the final file first"}
            </p>
          </div>
        </div>

        {/* Product, provider, cost */}
        <div className="min-w-0 rounded-input bg-canvas p-3">
          <p className="text-xs font-medium text-slate">Product</p>
          <p className="mt-0.5 break-words text-sm font-medium text-ink">
            {item?.product ?? "Nothing to print"}
            {plan.items.length > 1 && <span className="font-normal text-slate"> + {plan.items.length - 1} more</span>}
          </p>
          <p className="mt-0.5 break-words text-xs text-slate">
            {[item?.size, item?.variant].filter(Boolean).join(" · ") || "Size not set"}
            {item?.providerSku ? ` · SKU ${item.providerSku}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="info">{PROVIDER_LABEL[provider]}</Badge>
            <span className="text-xs text-slate">{reason}</span>
          </div>
          <p className={cost ? "mt-2 text-sm font-semibold text-ink" : "mt-2 text-sm text-slate"} title={costReason ?? undefined}>
            {cost ? `${cost} cost` : "Cost unavailable"}
          </p>
        </div>

        {/* Address */}
        <div className="min-w-0 rounded-input bg-canvas p-3 sm:col-span-2">
          <p className="text-xs font-medium text-slate">Ship to</p>
          {address ? (
            <address className="mt-0.5 break-words text-sm not-italic text-ink">
              <span className="font-medium">
                {address.name || [address.firstName, address.lastName].filter(Boolean).join(" ") || "No name"}
              </span>
              {address.company && <>, {address.company}</>}
              <br />
              {[address.addressLine1, address.addressLine2].filter(Boolean).join(", ")}
              <br />
              {[address.city, address.state, address.postalCode].filter(Boolean).join(" ")}
              {address.countryCode && <>, {address.countryCode}</>}
            </address>
          ) : (
            <p className="mt-0.5 text-sm text-slate">No shipping address yet.</p>
          )}
        </div>
      </div>

      {plan.blockers.length > 0 && (
        <div className="mt-3 rounded-input bg-amber/10 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-amber">
            <AlertTriangle size={14} className="shrink-0" />
            Fix before sending
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-ink">
            {plan.blockers.map((blocker, index) => (
              <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {other && (
          <Link
            href={`/orders/${orderId}?printProvider=${other}#print`}
            className="inline-flex min-h-11 items-center justify-center text-sm font-medium text-pigment hover:text-ink sm:min-h-0 sm:px-2"
          >
            Use {PROVIDER_LABEL[other]}
          </Link>
        )}
        <PrintSubmitButton
          orderId={orderId}
          provider={provider}
          requested={plan.requestedProvider != null}
          label={`Submit to ${PROVIDER_LABEL[provider]}`}
          disabled={!plan.ready}
        />
      </div>
    </DataPanel>
  );
}
