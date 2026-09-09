import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense, cache } from "react";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { getTodayQueue } from "@/lib/orders/today-queue";
import { getEmailNeedsActionCounts } from "@/lib/email/outbox";
import { Page, PageHeader, Skeleton } from "@/components/ui";
import { ArrowRight, Mail } from "@/components/ui/icons";
import { TodayQueueList } from "@/components/today/today-queue";

export const dynamic = "force-dynamic";

type U = { id: string; role: "admin" | "va" | "designer" };

// Both the summary line and the list read the same queue; one query per request.
const queueFor = cache((userId: string, role: U["role"], businessId: string) => getTodayQueue({ id: userId, role }, businessId));

/**
 * Today: the full ranked queue across every shop in the workspace, sorted by
 * what hurts most. Home shows the top five; this is the whole list.
 */
export default async function TodayPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user: U = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const { selected } = await loadShellData(user);

  return (
    <Page className="max-w-4xl">
      <PageHeader
        eyebrow={selected.name}
        title="Today"
        description="Everything waiting on you, most urgent first."
      />
      <Suspense fallback={<Skeleton className="h-5 w-64" />}>
        <Summary user={user} businessId={selected.id} />
      </Suspense>
      <Suspense fallback={<QueueFallback />}>
        <Queue user={user} businessId={selected.id} />
      </Suspense>
      <Suspense fallback={null}>
        <MailStrip user={user} businessId={selected.id} />
      </Suspense>
    </Page>
  );
}

async function Summary({ user, businessId }: { user: U; businessId: string }) {
  const q = await queueFor(user.id, user.role, businessId);
  if (q.counts.total === 0) return null;
  const bits = [
    q.counts.now ? `${q.counts.now} need${q.counts.now === 1 ? "s" : ""} you now` : null,
    q.counts.today ? `${q.counts.today} for today` : null,
    q.counts.soon ? `${q.counts.soon} soon` : null,
  ].filter(Boolean);
  return (
    <p className="text-base text-slate">
      {bits.join(", ")}
      {q.shops > 1 ? ` across ${q.shops} shops.` : "."}
    </p>
  );
}

async function Queue({ user, businessId }: { user: U; businessId: string }) {
  const q = await queueFor(user.id, user.role, businessId);
  return <TodayQueueList groups={q.groups} />;
}

async function MailStrip({ user, businessId }: { user: U; businessId: string }) {
  const counts = await getEmailNeedsActionCounts(user, { businessId }).catch(() => ({ unmatched: 0, failed: 0 }));
  const n = counts.unmatched + counts.failed;
  if (!n) return null;
  return (
    <Link href="/emails" className="flex min-h-14 items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-sm hover:bg-canvas">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-input bg-pigment-soft text-pigment">
        <Mail size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium text-ink">
          {n} message{n === 1 ? "" : "s"} not matched to an order
        </span>
        <span className="block text-sm text-slate">Open Messages to link {n === 1 ? "it" : "them"} to the right order.</span>
      </span>
      <ArrowRight size={18} className="shrink-0 text-slate" />
    </Link>
  );
}

function QueueFallback() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-16 rounded-card" />
      ))}
    </div>
  );
}
