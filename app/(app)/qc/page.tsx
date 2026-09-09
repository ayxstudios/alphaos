import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { getQcQueue } from "@/lib/qc/data";
import { formatAge } from "@/lib/orders/today-queue";
import { Badge, DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { ShopBadge } from "@/components/ui/shop-badge";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, Eye, CheckCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * QC: the queue of portraits waiting for a quality check, one screen with
 * one obvious button. Each row opens the review screen for that order; the
 * big button starts at the top of the queue.
 */
export default async function QcQueuePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const { selected } = await loadShellData(user);
  const rows = await getQcQueue(user, selected.id);
  const now = Date.now();

  return (
    <Page className="max-w-4xl">
      <PageHeader
        eyebrow={selected.name}
        title="QC"
        description="Portraits waiting for a quality check, soonest due first. Every check is signed with your name."
        actions={
          rows.length > 0 ? (
            <Link
              href={`/qc/${rows[0].id}`}
              className={cn("inline-flex h-11 items-center gap-2 rounded-input bg-pigment px-5 text-base font-semibold text-surface hover:opacity-90", focusRing)}
            >
              <Eye size={18} /> Start QC ({rows.length})
            </Link>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <DataPanel>
          <EmptyState
            icon={CheckCircle}
            headline="Nothing waiting for QC"
            body="When a designer submits a portrait it lands here. You will also see it on Home under What is waiting."
            action={
              <Link href="/board" className={cn("inline-flex h-10 items-center gap-2 rounded-input border border-line bg-surface px-4 text-sm font-medium text-ink hover:bg-canvas", focusRing)}>
                Designer boards <ArrowRight size={14} />
              </Link>
            }
          />
        </DataPanel>
      ) : (
        <DataPanel>
          <ul className="divide-y divide-line">
            {rows.map((r, i) => {
              const due = r.dueAt ? new Date(r.dueAt) : null;
              const late = due ? due.getTime() < now : false;
              return (
                <li key={r.id}>
                  <Link
                    href={`/qc/${r.id}`}
                    className={cn("flex items-center gap-3 px-4 py-3 hover:bg-canvas", focusRing)}
                  >
                    <span className="hidden w-7 shrink-0 text-center text-xs tabular-nums text-slate sm:block">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate">
                        <ShopBadge platform={r.platform} name={r.shopName} className="text-xs" />
                        <span className="font-semibold text-ink">{r.orderNumber}</span>
                        {late && <Badge variant="danger">Late</Badge>}
                      </div>
                      <p className="truncate text-sm text-ink">
                        {r.designerName ?? "Unassigned"}
                        <span className="text-slate">
                          {" "}· {r.figureCount} figure{r.figureCount === 1 ? "" : "s"}
                          {r.style ? ` · ${r.style}` : ""}
                        </span>
                      </p>
                    </div>
                    <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-slate">
                      in QC {formatAge(now - new Date(r.waitingSince).getTime())}
                    </span>
                    <span className={cn("hidden h-9 shrink-0 items-center gap-1 rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink sm:inline-flex")}>
                      Review <ArrowRight size={14} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </DataPanel>
      )}
    </Page>
  );
}
