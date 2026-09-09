import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { getQcQueue } from "@/lib/qc/data";
import { formatAge } from "@/lib/orders/today-queue";
import { setBusiness } from "@/app/(app)/actions";
import { Badge, DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { ShopBadge } from "@/components/ui/shop-badge";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, ChevronRight, Eye, CheckCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * QC: the portraits waiting for a quality check, soonest due first. One
 * big button starts at the top of the queue; every row opens that order's
 * review screen. When this workspace is clear but another is not, the empty
 * state says so and switches with one tap.
 */
export default async function QcQueuePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const { selected, options } = await loadShellData(user);
  const rows = await getQcQueue(user, selected.id);
  const now = Date.now();

  // Other workspaces with something waiting (only looked up when this one is clear).
  const elsewhere: { id: string; name: string; n: number }[] = [];
  if (rows.length === 0 && options.length > 1) {
    const all = await getQcQueue(user, null);
    for (const o of options) {
      if (o.id === selected.id) continue;
      const n = all.filter((r) => r.businessId === o.id).length;
      if (n > 0) elsewhere.push({ id: o.id, name: o.name, n });
    }
  }

  return (
    <Page className="max-w-3xl">
      <PageHeader
        eyebrow={selected.name}
        title="QC"
        description={rows.length ? `${rows.length} portrait${rows.length === 1 ? "" : "s"} waiting, soonest due first.` : undefined}
        actions={
          rows.length > 0 ? (
            <Link
              href={`/qc/${rows[0].id}`}
              className={cn("inline-flex h-11 items-center gap-2 rounded-input bg-pigment px-5 text-base font-semibold text-surface hover:opacity-90", focusRing)}
            >
              <Eye size={18} /> Start QC
            </Link>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <DataPanel>
          <EmptyState
            icon={CheckCircle}
            headline={elsewhere.length ? `Nothing here for ${selected.name}.` : "Nothing waiting for QC"}
            body={
              elsewhere.length
                ? elsewhere.map((e) => `${e.name} has ${e.n}.`).join(" ")
                : "When a designer submits a portrait it lands here."
            }
            action={
              elsewhere.length ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {elsewhere.map((e) => (
                    <form
                      key={e.id}
                      action={async () => {
                        "use server";
                        await setBusiness(e.id);
                        redirect("/qc");
                      }}
                    >
                      <button
                        type="submit"
                        className={cn("inline-flex h-10 items-center gap-2 rounded-input bg-pigment px-4 text-sm font-medium text-surface hover:opacity-90", focusRing)}
                      >
                        Check {e.name} <ArrowRight size={14} />
                      </button>
                    </form>
                  ))}
                </div>
              ) : (
                <Link href="/board" className={cn("inline-flex h-10 items-center gap-2 rounded-input bg-canvas px-4 text-sm font-medium text-ink hover:bg-pigment-soft/60", focusRing)}>
                  Designer boards <ArrowRight size={14} />
                </Link>
              )
            }
          />
        </DataPanel>
      ) : (
        <DataPanel>
          <ul className="divide-y divide-line/70">
            {rows.map((r) => {
              const due = r.dueAt ? new Date(r.dueAt) : null;
              const late = due ? due.getTime() < now : false;
              return (
                <li key={r.id}>
                  <Link
                    href={`/qc/${r.id}`}
                    className={cn("flex items-center gap-3 px-3 py-2.5 hover:bg-canvas/70 sm:px-4", focusRing)}
                  >
                    <span className="size-12 shrink-0 overflow-hidden rounded-input bg-canvas">
                      {r.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
                      ) : (
                        <span className="flex size-full items-center justify-center text-slate">
                          <Eye size={16} />
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="text-sm font-semibold text-ink">{r.orderNumber}</span>
                        <ShopBadge platform={r.platform} name={r.shopName} className="hidden text-xs sm:inline-flex" />
                        {late && <Badge variant="danger">Late</Badge>}
                      </div>
                      <p className="truncate text-sm text-slate">
                        {r.designerName ?? "Unassigned"}
                        {" · "}
                        {r.figureCount} figure{r.figureCount === 1 ? "" : "s"}
                        {r.style ? ` · ${r.style}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-slate">
                      {formatAge(now - new Date(r.waitingSince).getTime())}
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-slate/70" />
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
