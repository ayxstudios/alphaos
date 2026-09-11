// The narrative may come through the Alpha relay (up to 20 s); see lib/health/narrative.ts.
export const maxDuration = 30;

import Link from "next/link";
import { redirect } from "next/navigation";

import { anthropicFeaturesEnabled } from "@/lib/ai/anthropic";
import { auth } from "@/lib/auth";
import { loadHealthMetrics, type CountLink, type GmailMailboxHealth, type JobRunHealth, type ShopSyncHealth } from "@/lib/health/daily-report";
import { loadDailyNarrative } from "@/lib/health/narrative";
import { loadShellData } from "@/lib/shell/context";
import { Badge, DataPanel, Disclosure, EmptyState, Page, PageHeader, SectionHeader } from "@/components/ui";
import { Grid } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ scope?: string }>;

function formatDateTime(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatGenerated(value: string | null) {
  if (!value) return "Metrics current";
  return `Narrative cached ${formatDateTime(value)}`;
}

const TONE_DOT: Record<CountLink["tone"], string> = {
  neutral: "bg-slate/40",
  success: "bg-sage",
  warning: "bg-amber",
  danger: "bg-rose",
};

/** A signal is "clear" when it is green or a neutral zero. */
function isClear(metric: CountLink) {
  return metric.tone === "success" || (metric.tone === "neutral" && metric.count === 0);
}


export default async function HealthPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role !== "admin") redirect("/dashboard");

  const { selected } = await loadShellData(user);
  const sp = await searchParams;
  const allBusinesses = sp.scope === "all";
  const scope = allBusinesses
    ? ({ kind: "all" } as const)
    : ({ kind: "business", businessId: selected.id, businessName: selected.name } as const);

  const metrics = await loadHealthMetrics(user, scope);
  const showAiFeatures = anthropicFeaturesEnabled();
  const narrative = showAiFeatures ? await loadDailyNarrative(user, metrics) : null;

  return (
    <Page>
      <PageHeader
        title="System Health"
        description="What needs a look, then everything that is fine."
        eyebrow={metrics.scopeLabel}
        actions={
          <div className="inline-flex rounded-input bg-surface p-1 text-sm shadow-card">
            <Link
              href="/health"
              className={cn(
                "rounded-[6px] px-3 py-1.5 font-medium text-slate",
                !allBusinesses && "bg-pigment-soft text-pigment",
              )}
            >
              Selected
            </Link>
            <Link
              href="/health?scope=all"
              className={cn(
                "rounded-[6px] px-3 py-1.5 font-medium text-slate",
                allBusinesses && "bg-pigment-soft text-pigment",
              )}
            >
              All Businesses
            </Link>
          </div>
        }
      />

      {narrative && (
        <DataPanel className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-4xl">
              <p className="text-sm font-semibold text-ink">Daily briefing</p>
              <p className="mt-2 text-sm leading-6 text-slate">{narrative.text}</p>
            </div>
            <Badge variant={metrics.healthy ? "success" : "warning"} dot>
              {metrics.healthy ? "Healthy" : "Needs attention"}
            </Badge>
          </div>
          <p className="mt-3 text-xs text-slate">{formatGenerated(narrative.generatedAt)}</p>
        </DataPanel>
      )}

      <PipelineSignals metrics={metrics.links.pipeline} />

      <RowSection
        id="background-jobs"
        title="Background jobs"
        noun="job"
        items={metrics.pipeline.jobs.map((job) => ({ key: job.key, ok: jobBadge(job).variant === "success", node: <JobRunRow job={job} /> }))}
        empty={null}
      />

      <RowSection
        title="Shop syncs"
        noun="shop"
        items={metrics.pipeline.shops.map((shop) => ({ key: shop.id, ok: !shop.stale, node: <ShopSyncRow shop={shop} /> }))}
        empty={
          <EmptyState
            icon={Grid}
            headline="No connected shops"
            body="Connected Etsy and Shopify shops will appear here with their last successful sync time."
          />
        }
      />

      <RowSection
        title="Mailbox polls"
        noun="mailbox"
        items={metrics.pipeline.gmailMailboxes.map((mailbox) => ({ key: mailbox.businessId, ok: !mailbox.stalled, node: <MailboxPollRow mailbox={mailbox} /> }))}
        empty={
          <EmptyState
            icon={Grid}
            headline="No connected mailboxes"
            body="Connected Gmail mailboxes will appear here with their last successful poll time."
          />
        }
      />
    </Page>
  );
}

/**
 * Pipeline signals: the ones that need a look sit up top as cards; every
 * clear signal folds into one line so green never shouts.
 */
function PipelineSignals({ metrics }: { metrics: CountLink[] }) {
  const attention = metrics.filter((m) => !isClear(m));
  const clear = metrics.filter(isClear);
  return (
    <div className="flex flex-col gap-3">
      {attention.length > 0 && (
        <DataPanel className="p-4">
          <SectionHeader title="Needs a look" description={`${attention.length} signal${attention.length === 1 ? "" : "s"} outside the normal range`} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {attention.map((metric) => (
              <MetricCard key={metric.label} metric={metric} />
            ))}
          </div>
        </DataPanel>
      )}
      {clear.length > 0 && (
        <Disclosure
          summary={
            <span className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-sage" />
              {attention.length === 0 ? "Everything is clear" : `${clear.length} check${clear.length === 1 ? "" : "s"} clear`}
            </span>
          }
          hint={attention.length === 0 ? `${clear.length} pipeline signals in range` : undefined}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {clear.map((metric) => (
              <MetricCard key={metric.label} metric={metric} />
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

function MetricCard({ metric }: { metric: CountLink }) {
  return (
    <Link
      href={metric.href}
      className="block rounded-input bg-canvas/70 p-3 transition-colors hover:bg-pigment-soft"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[metric.tone])} />
          {metric.label}
        </p>
        <span className="font-display text-lg font-semibold tabular-nums text-ink">{metric.count}</span>
      </div>
      {metric.detail && <p className="mt-1 text-xs leading-5 text-slate">{metric.detail}</p>}
    </Link>
  );
}

/**
 * A list of health rows: anything unhealthy is shown open, the healthy rest
 * folds into one calm line.
 */
function RowSection({
  id,
  title,
  noun,
  items,
  empty,
}: {
  id?: string;
  title: string;
  noun: string;
  items: { key: string; ok: boolean; node: React.ReactNode }[];
  empty: React.ReactNode;
}) {
  const bad = items.filter((i) => !i.ok);
  const good = items.filter((i) => i.ok);
  return (
    <DataPanel id={id} className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {items.length > 0 && (
          <Badge variant={bad.length ? "danger" : "success"} dot>
            {bad.length ? `${bad.length} need${bad.length === 1 ? "s" : ""} a look` : "All healthy"}
          </Badge>
        )}
      </div>
      {items.length === 0 ? (
        empty
      ) : (
        <>
          {bad.length > 0 && (
            <div className="divide-y divide-line/70 border-t border-line/70">
              {bad.map((i) => (
                <div key={i.key}>{i.node}</div>
              ))}
            </div>
          )}
          {good.length > 0 && (
            <details className="group border-t border-line/70">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-slate hover:text-ink [&::-webkit-details-marker]:hidden">
                <span className="size-1.5 rounded-full bg-sage" />
                {good.length} {noun}{good.length === 1 ? "" : "s"} healthy
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ml-auto transition-transform group-open:rotate-90">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </summary>
              <div className="divide-y divide-line/70 border-t border-line/70">
                {good.map((i) => (
                  <div key={i.key}>{i.node}</div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </DataPanel>
  );
}

function jobBadge(job: JobRunHealth) {
  if (job.status === "missing") return { variant: "danger" as const, label: "Missing" };
  if (job.stale) return { variant: "danger" as const, label: "Stale" };
  if (job.status === "failed") return { variant: "danger" as const, label: "Failed" };
  if (job.status === "partial") return { variant: "warning" as const, label: "Partial" };
  if (job.status === "running") return { variant: "warning" as const, label: "Running" };
  return { variant: "success" as const, label: "Healthy" };
}

function failureDetail(job: JobRunHealth) {
  const failedOrders = Array.isArray(job.metadata?.failedOrders) ? job.metadata.failedOrders : null;
  const failedReceipts = Array.isArray(job.metadata?.failedReceipts) ? job.metadata.failedReceipts : null;
  const failed = failedOrders ?? failedReceipts;
  if (!failed?.length) return null;
  return failed
    .slice(0, 5)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const value = "platformOrderId" in entry ? entry.platformOrderId : "receiptId" in entry ? entry.receiptId : null;
      return value ? String(value) : null;
    })
    .filter(Boolean)
    .join(", ");
}

function JobRunRow({ job }: { job: JobRunHealth }) {
  const badge = jobBadge(job);
  const failedIds = failureDetail(job);
  return (
    <div className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink">{job.label}</p>
        <p className="text-xs text-slate">
          Last run {formatDateTime(job.lastRunAt)}
          {job.expectedIntervalMinutes ? ` · expected every ${job.expectedIntervalMinutes >= 1440 ? "24h" : `${job.expectedIntervalMinutes}m`}` : ""}
          {job.itemsProcessed || job.itemsFailed ? ` · ${job.itemsProcessed} processed, ${job.itemsFailed} failed` : ""}
        </p>
        {job.error && <p className="mt-1 text-xs text-rose">{job.error}</p>}
        {failedIds && <p className="mt-1 text-xs text-slate">Failed IDs: {failedIds}</p>}
      </div>
      <Badge variant={badge.variant} dot>
        {badge.label}
      </Badge>
    </div>
  );
}

function ShopSyncRow({ shop }: { shop: ShopSyncHealth }) {
  return (
    <Link href="/settings" className="grid grid-cols-1 gap-2 px-4 py-3 transition-colors hover:bg-canvas sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink">{shop.name}</p>
        <p className="text-xs text-slate">
          {shop.businessName} · {shop.platform === "shopify" ? "Shopify" : "Etsy"} · last successful sync{" "}
          {formatDateTime(shop.lastSyncAt)}
        </p>
      </div>
      <Badge variant={shop.stale ? "danger" : "success"} dot>
        {shop.stale ? "Stale" : "Healthy"}
      </Badge>
    </Link>
  );
}

function MailboxPollRow({ mailbox }: { mailbox: GmailMailboxHealth }) {
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink">{mailbox.businessName}</p>
        <p className="text-xs text-slate">
          {mailbox.gmailAddress ?? "Gmail mailbox"} · last successful poll {formatDateTime(mailbox.lastPolledAt)}
        </p>
        {mailbox.stalled && (
          <p className="mt-1 text-xs text-slate">
            AlphaOS cursor {mailbox.dbHistoryId}; Gmail current {mailbox.gmailHistoryId}
          </p>
        )}
      </div>
      <Badge variant={mailbox.stalled ? "danger" : "success"} dot>
        {mailbox.stalled ? `Stalled${mailbox.ageHours != null ? ` ${mailbox.ageHours}h` : ""}` : "Healthy"}
      </Badge>
    </div>
  );
}
