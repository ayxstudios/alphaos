import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { getQcQueue } from "@/lib/qc/data";
import { formatAge } from "@/lib/orders/today-queue";
import { setBusiness } from "@/app/(app)/actions";
import { Badge, DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { ArrowRight, Eye, CheckCircle } from "@/components/ui/icons";
import { cn, styleLabel } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Awaiting QC: the portraits waiting for a check, soonest due first. Each
 * card shows the portrait, who it is for, the style, the designer, how long
 * it has waited, and a photo badge when the customer sent more than one
 * photo. One obvious button per card: Check. When this workspace is clear but
 * another is not, the empty state says so and switches with one tap.
 */
export default async function QcQueuePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer" || user.role === "helper") redirect("/board");

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
        title="Awaiting QC"
        tourId="page:qc"
        description={
          rows.length
            ? `${rows.length} portrait${rows.length === 1 ? "" : "s"} to check, most urgent first.`
            : "Check each portrait before the customer sees it."
        }
        actions={
          rows.length > 1 ? (
            <Link
              href={`/qc/${rows[0].id}`}
              className={cn("inline-flex h-11 items-center gap-2 rounded-input bg-pigment px-5 text-base font-semibold text-surface hover:opacity-90", focusRing)}
            >
              <Eye size={18} /> Start with the first
            </Link>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <DataPanel>
          <EmptyState
            icon={CheckCircle}
            headline={elsewhere.length ? `Nothing here for ${selected.name}.` : "Nothing to check"}
            body={
              elsewhere.length
                ? elsewhere.map((e) => `${e.name} has ${e.n}.`).join(" ")
                : "When a designer finishes a portrait, it shows up here."
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
                        className={cn("inline-flex h-11 items-center gap-2 rounded-input bg-pigment px-4 text-sm font-medium text-surface hover:opacity-90", focusRing)}
                      >
                        Check {e.name} <ArrowRight size={14} />
                      </button>
                    </form>
                  ))}
                </div>
              ) : (
                <Link href="/board" className={cn("inline-flex h-11 items-center gap-2 rounded-input bg-canvas px-4 text-sm font-medium text-ink hover:bg-pigment-soft/60", focusRing)}>
                  Designer boards <ArrowRight size={14} />
                </Link>
              )
            }
          />
        </DataPanel>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => {
            const due = r.dueAt ? new Date(r.dueAt) : null;
            const late = due ? due.getTime() < now : false;
            const who = r.customerFirstName ? `${r.orderNumber} · ${r.customerFirstName}` : r.orderNumber;
            return (
              <li key={r.id} className="flex items-center gap-3 rounded-card bg-surface p-3 shadow-card sm:gap-4 sm:p-4">
                <Link href={`/qc/${r.id}`} tabIndex={-1} aria-hidden className="size-16 shrink-0 overflow-hidden rounded-input bg-canvas sm:size-20">
                  {r.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
                  ) : (
                    <span className="flex size-full items-center justify-center text-slate">
                      <Eye size={20} />
                    </span>
                  )}
                </Link>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-semibold text-ink">{who}</p>
                  <p className="break-words text-sm text-slate">
                    {r.style ? styleLabel(r.style) : "Style not set"}
                    {" · "}
                    {r.designerName ?? "Unassigned"}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className={cn("text-sm", late ? "font-medium text-rose" : "text-slate")}>
                      {late ? "Late, waiting " : "Waiting "}
                      {formatAge(now - new Date(r.waitingSince).getTime())}
                    </span>
                    {r.photoCount > 1 && <Badge variant="info">{r.photoCount} photos</Badge>}
                  </div>
                </div>
                <Link
                  href={`/qc/${r.id}`}
                  className={cn("inline-flex h-11 min-w-[5.5rem] shrink-0 items-center justify-center gap-1.5 rounded-input bg-pigment px-4 text-sm font-semibold text-surface hover:opacity-90", focusRing)}
                  aria-label={`Check order ${r.orderNumber}`}
                >
                  Check <ArrowRight size={14} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
