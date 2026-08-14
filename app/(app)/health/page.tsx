import Link from "next/link";
import { redirect } from "next/navigation";

import { anthropicFeaturesEnabled } from "@/lib/ai/anthropic";
import { auth } from "@/lib/auth";
import { loadHealthMetrics, type CountLink, type GmailMailboxHealth, type JobRunHealth, type ShopSyncHealth } from "@/lib/health/daily-report";
import { loadDailyNarrative } from "@/lib/health/narrative";
import { loadShellData } from "@/lib/shell/context";
import { Badge, DataPanel, EmptyState, Page, PageHeader, SectionHeader } from "@/components/ui";
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

function metricClass(tone: CountLink["tone"]) {
  return {
    neutral: "border-line hover:border-slate/40",
    success: "border-sage/20 hover:border-sage/35",
    warning: "border-amber/25 hover:border-amber/40",
    danger: "border-rose/20 hover:border-rose/40",
  }[tone];
}

function badgeVariant(tone: CountLink["tone"]) {
  return tone === "neutral" ? "neutral" : tone;
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
        description="Pipeline integrity, sync health, and the daily operations briefing."
        eyebrow={metrics.scopeLabel}
        actions={
          <div className="inline-flex rounded-input border border-line bg-surface p-1 text-sm shadow-sm">
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

      <DataPanel className="p-4">
        <SectionHeader
          title="Pipeline integrity"
          description="Signals that the system itself is capturing, sending, and syncing correctly."
        />
        <MetricGrid metrics={metrics.links.pipeline} />
      </DataPanel>

      <DataPanel id="background-jobs" className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <SectionHeader
            title="Background jobs"
            description="Each scheduled job should keep producing successful ledger rows."
          />
        </div>
        <div className="divide-y divide-line">
          {metrics.pipeline.jobs.map((job) => (
            <JobRunRow key={job.key} job={job} />
          ))}
        </div>
      </DataPanel>

      <DataPanel className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <SectionHeader
            title="Shop syncs"
            description="Each connected shop should sync successfully at least once per hour."
          />
        </div>
        {metrics.pipeline.shops.length === 0 ? (
          <EmptyState
            icon={Grid}
            headline="No connected shops"
            body="Connected Etsy and Shopify shops will appear here with their last successful sync time."
          />
        ) : (
          <div className="divide-y divide-line">
            {metrics.pipeline.shops.map((shop) => (
              <ShopSyncRow key={shop.id} shop={shop} />
            ))}
          </div>
        )}
      </DataPanel>

      <DataPanel className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <SectionHeader
            title="Mailbox polls"
            description="Each connected mailbox should advance whenever Gmail has newer history."
          />
        </div>
        {metrics.pipeline.gmailMailboxes.length === 0 ? (
          <EmptyState
            icon={Grid}
            headline="No connected mailboxes"
            body="Connected Gmail mailboxes will appear here with their last successful poll time."
          />
        ) : (
          <div className="divide-y divide-line">
            {metrics.pipeline.gmailMailboxes.map((mailbox) => (
              <MailboxPollRow key={mailbox.businessId} mailbox={mailbox} />
            ))}
          </div>
        )}
      </DataPanel>
    </Page>
  );
}

function MetricGrid({ metrics }: { metrics: CountLink[] }) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
      {metrics.map((metric) => (
        <Link
          key={metric.label}
          href={metric.href}
          className={cn(
            "block rounded-card border bg-surface p-3 transition-colors hover:bg-canvas",
            metricClass(metric.tone),
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate">{metric.label}</p>
            <Badge variant={badgeVariant(metric.tone)} dot={metric.tone !== "neutral"}>
              {metric.count}
            </Badge>
          </div>
          {metric.detail && <p className="mt-3 text-xs leading-5 text-slate">{metric.detail}</p>}
        </Link>
      ))}
    </div>
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
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
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
    <Link href="/settings" className="grid gap-2 px-4 py-3 transition-colors hover:bg-canvas sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
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
