import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getOverview } from "@/lib/agent/overview";
import { DataPanel, Page, PageHeader } from "@/components/ui";
import { OverviewTable } from "@/components/overview/overview-table";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const data = await getOverview(user);

  return (
    <Page>
      <PageHeader
        title="Overview"
        description="Every open order, most delayed first. Delayed means over the time that stage should take."
      />

      <DataPanel className="p-0">
        <ul className="divide-y divide-line/70" aria-label="Today by business">
          {data.digest.map((d) => (
            <li key={d.businessId} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-6">
              <span className="text-sm font-medium text-ink sm:w-48 sm:shrink-0">{d.businessName}</span>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:flex sm:flex-wrap">
                <div className="flex gap-1.5"><dt className="text-slate">In today</dt><dd className="font-medium tabular-nums text-ink">{d.inToday}</dd></div>
                <div className="flex gap-1.5"><dt className="text-slate">Out today</dt><dd className="font-medium tabular-nums text-ink">{d.outToday}</dd></div>
                <div className="flex gap-1.5"><dt className="text-slate">Overdue</dt><dd className={`font-medium tabular-nums ${d.overdue ? "text-rose" : "text-ink"}`}>{d.overdue}</dd></div>
                <div className="flex gap-1.5"><dt className="text-slate">Exceptions waiting</dt><dd className={`font-medium tabular-nums ${d.exceptionsWaiting ? "text-amber" : "text-ink"}`}>{d.exceptionsWaiting}</dd></div>
              </dl>
            </li>
          ))}
        </ul>
      </DataPanel>

      <OverviewTable rows={data.rows} businesses={data.businesses} stages={data.stages} />
    </Page>
  );
}
