import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getDesignerBoard } from "@/lib/orders/board-data";
import { getRailDesigners } from "@/lib/designers/roster";
import { DesignerBoard } from "@/components/board/designer-board";
import { DesignerPicker } from "@/components/board/designer-picker";
import { DesignerRail } from "@/components/board/designer-rail";
import { Badge, DataPanel, EmptyState, Page, PageHeader, StatCard } from "@/components/ui";
import { Columns } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

function money(value: string | null): string {
  return value == null ? "Needs rate" : `$${Number(value).toFixed(2)}`;
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const sp = await searchParams;
  const designerParam = typeof sp.designer === "string" ? sp.designer : undefined;
  const isStaff = user.role !== "designer";

  // Designers can only ever see their own board; staff pick one from the
  // right-hand rail (app shell) or the mobile dropdown below.
  const targetId = isStaff ? designerParam : user.id;

  const [board, designers] = await Promise.all([
    targetId ? getDesignerBoard(user, targetId) : Promise.resolve(null),
    // Only needed for the mobile picker (the rail lives in the shell); cached,
    // so this shares the layout's query.
    isStaff ? getRailDesigners(user) : Promise.resolve([]),
  ]);

  const pickerDesigners = designers.map((d) => ({ id: d.id, name: d.name }));

  return (
    <Page className="max-w-none">
      <PageHeader
        title={isStaff ? "Designer boards" : "My board"}
        description="Move work across queue, design, and QC for each designer."
        actions={
          <>
            {isStaff && (
              // Mobile / narrow screens: the right rail is hidden, so keep a dropdown.
              <div className="lg:hidden">
                <DesignerPicker designers={pickerDesigners} current={targetId} />
              </div>
            )}
            {board && (
              <div className="grid w-80 grid-cols-2 gap-2">
                <StatCard
                  label="Earned today"
                  value={`$${board.dailyEarnings.toFixed(2)}`}
                  tone="success"
                />
                <StatCard
                  label="This month"
                  value={`$${board.periodEarnings.toFixed(2)}`}
                  tone="info"
                />
              </div>
            )}
          </>
        }
      />

      <div className="flex gap-4">
        {/* Left-hand designer switcher (staff only). */}
        {isStaff && <DesignerRail designers={designers} current={targetId} />}

        <div className="min-w-0 flex-1">
          {board ? (
            <div className="flex flex-col gap-4">
              <DesignerBoard initial={board.columns} />
              <DataPanel>
                <div className="border-b border-line px-4 py-3">
                  <h2 className="text-sm font-semibold text-ink">Earnings history</h2>
                </div>
                {board.earningHistory.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-slate">No completed payable orders yet.</p>
                ) : (
                  <div className="divide-y divide-line">
                    {board.earningHistory.map((earning) => (
                      <div key={earning.id} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[1fr_auto_auto_auto_auto] md:items-center">
                        <div className="min-w-0">
                          <a href={`/orders/${earning.orderId}`} className="font-medium text-ink hover:text-pigment">
                            {earning.orderNumber}
                          </a>
                          <p className="truncate text-xs text-slate">{earning.style}</p>
                        </div>
                        <span className="text-slate">{earning.figureCount} figure{earning.figureCount === 1 ? "" : "s"}</span>
                        <span className="text-slate">{earning.rate ? `$${Number(earning.rate).toFixed(2)}/fig` : "Mixed or missing rate"}</span>
                        <span className="font-semibold text-ink">{money(earning.amount)}</span>
                        <div className="flex items-center justify-between gap-2 md:justify-end">
                          <Badge variant={earning.status === "blocked" ? "warning" : earning.status === "voided" ? "danger" : earning.status === "paid" ? "success" : "neutral"}>
                            {earning.status}
                          </Badge>
                          <span className="text-xs text-slate">{shortDate(earning.createdAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </DataPanel>
            </div>
          ) : (
            <div className="rounded-card border border-line bg-surface shadow-sm">
              <EmptyState
                icon={Columns}
                headline="Select a designer"
                body="Pick a designer from the list on the left to view and manage their board."
              />
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
