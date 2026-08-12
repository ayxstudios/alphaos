import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadHealthMetrics, type CountLink, type DesignerCapacity, type ShopSyncHealth } from "@/lib/health/daily-report";
import { loadDailyNarrative } from "@/lib/health/narrative";
import { loadShellData } from "@/lib/shell/context";
import {
  Badge,
  DataPanel,
  EmptyState,
  Page,
  PageHeader,
  SectionHeader,
} from "@/components/ui";
import { AlertTriangle, Grid, ListChecks } from "@/components/ui/icons";
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

function pct(value: number | null) {
  return value == null ? "No data" : `${value}%`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const { selected } = await loadShellData(user);
  const sp = await searchParams;
  const allBusinesses = user.role === "admin" && sp.scope === "all";
  const scope = allBusinesses
    ? ({ kind: "all" } as const)
    : ({ kind: "business", businessId: selected.id, businessName: selected.name } as const);

  const metrics = await loadHealthMetrics(user, scope);
  const narrative = await loadDailyNarrative(user, metrics);

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        description="Daily health report for pipeline integrity and operational movement."
        eyebrow={metrics.scopeLabel}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {user.role === "admin" && (
              <div className="inline-flex rounded-input border border-line bg-surface p-1 text-sm shadow-sm">
                <Link
                  href="/dashboard"
                  className={cn(
                    "rounded-[6px] px-3 py-1.5 font-medium text-slate",
                    !allBusinesses && "bg-pigment-soft text-pigment",
                  )}
                >
                  Selected
                </Link>
                <Link
                  href="/dashboard?scope=all"
                  className={cn(
                    "rounded-[6px] px-3 py-1.5 font-medium text-slate",
                    allBusinesses && "bg-pigment-soft text-pigment",
                  )}
                >
                  All Businesses
                </Link>
              </div>
            )}
            <Link
              href="/orders"
              className="inline-flex h-10 items-center rounded-input bg-pigment px-3 text-sm font-medium text-surface transition-opacity hover:opacity-90"
            >
              View orders
            </Link>
          </div>
        }
      />

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

      <div className="grid gap-5 xl:grid-cols-2">
        <DataPanel className="p-4">
          <SectionHeader
            title="Pipeline integrity"
            description="Signals that the system itself is capturing, sending, and syncing correctly."
          />
          <MetricGrid metrics={metrics.links.pipeline} />
        </DataPanel>

        <DataPanel className="p-4">
          <SectionHeader
            title="Operational state"
            description="Signals that the work is moving through the business."
          />
          <MetricGrid metrics={metrics.links.operations} />
        </DataPanel>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
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

        <DataPanel className="p-4">
          <SectionHeader title="Quality and capacity" />
          <div className="mt-4 space-y-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate">Delivery</p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <MiniMetric label="On time yesterday" value={pct(metrics.operations.yesterday.onTimeRate)} />
                <MiniMetric label="On time 7 days" value={pct(metrics.operations.trailing7.onTimeRate)} />
              </div>
            </div>

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate">QC</p>
              <div className="mt-2 rounded-card border border-line p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate">Fail rate</span>
                  <span className="text-sm font-semibold text-ink">{pct(metrics.operations.trailing7.qcFailRate)}</span>
                </div>
                <p className="mt-2 text-xs text-slate">
                  {metrics.operations.topFailedChecklistItem
                    ? `Most failed: ${metrics.operations.topFailedChecklistItem.label} (${metrics.operations.topFailedChecklistItem.count})`
                    : "No failed checklist items in the trailing 7 days."}
                </p>
              </div>
            </div>

            <CapacityList
              title="Over capacity"
              empty="No designers are over capacity."
              designers={metrics.operations.designersOverCapacity}
              tone="warning"
            />
            <CapacityList
              title="Idle designers"
              empty="No idle designers with a configured capacity."
              designers={metrics.operations.designersIdle}
              tone="neutral"
            />
          </div>
        </DataPanel>
      </div>
    </Page>
  );
}

function MetricGrid({ metrics }: { metrics: CountLink[] }) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
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

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line p-3">
      <p className="text-xs text-slate">{label}</p>
      <p className="mt-1 text-base font-semibold text-ink">{value}</p>
    </div>
  );
}

function CapacityList({
  title,
  empty,
  designers,
  tone,
}: {
  title: string;
  empty: string;
  designers: DesignerCapacity[];
  tone: "neutral" | "warning";
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        {tone === "warning" ? (
          <AlertTriangle size={15} className="text-amber" />
        ) : (
          <ListChecks size={15} className="text-slate" />
        )}
        <p className="text-xs font-medium uppercase tracking-wide text-slate">{title}</p>
      </div>
      {designers.length === 0 ? (
        <p className="mt-2 text-sm text-slate">{empty}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {designers.map((designer) => (
            <Link
              key={`${title}-${designer.businessName}-${designer.designerId}`}
              href="/designers"
              className="block rounded-card border border-line p-3 text-sm transition-colors hover:bg-canvas"
            >
              <span className="font-semibold text-ink">{designer.name}</span>
              <span className="text-slate"> · {designer.businessName}</span>
              <span className="block text-xs text-slate">
                {designer.activeWork} active / {designer.dailyCapacity} daily capacity
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
