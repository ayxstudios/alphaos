import { redirect } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";

import { auth } from "@/lib/auth";
import type { RequestUser } from "@/lib/db";
import { getDesignerBoard } from "@/lib/orders/board-data";
import { getRailDesigners } from "@/lib/designers/roster";
import { DesignerBoard } from "@/components/board/designer-board";
import { DesignerPicker } from "@/components/board/designer-picker";
import { DesignerRail } from "@/components/board/designer-rail";
import { Badge, DataPanel, EmptyState, Page, PageHeader, StatCard } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { Calendar, Columns } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import BoardLoading from "./loading";

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

  // `force-dynamic` + a Suspense boundary keyed on the designer id: Next only
  // re-streams loading.tsx when the SEGMENT changes, not when just the
  // `?designer=` search param changes on this same route — so without this,
  // clicking a different designer in the rail leaves the old board sitting
  // there for however long the query takes, looking frozen. Keying the
  // boundary on targetId forces a fresh Suspense fallback on every switch.
  return (
    <Suspense key={targetId ?? "none"} fallback={<BoardLoading />}>
      <BoardContent user={user} isStaff={isStaff} targetId={targetId} />
    </Suspense>
  );
}

async function BoardContent({
  user,
  isStaff,
  targetId,
}: {
  user: RequestUser;
  isStaff: boolean;
  targetId?: string;
}) {
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
        description={
          isStaff
            ? "Each designer's queue, work in progress and QC."
            : "Your orders, soonest deadline first."
        }
        actions={
          // A column below `sm` (align-items:stretch gives each row a real,
          // definite width — PageHeader's actions slot is flex-shrink-0, so
          // without that a wide row like the two StatCards below just
          // overflows a 390px phone instead of shrinking). Row + wrap once
          // there's room.
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {!isStaff && (
              <Link
                href="/me"
                className={cn(
                  "inline-flex h-9 w-fit items-center gap-1.5 rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas",
                  focusRing,
                )}
              >
                <Calendar size={15} />
                My week
              </Link>
            )}
            {isStaff && (
              // Mobile / narrow screens: the right rail is hidden, so keep a dropdown.
              <div className="lg:hidden">
                <DesignerPicker designers={pickerDesigners} current={targetId} />
              </div>
            )}
            {board && (
              <div className="grid grid-cols-2 gap-2 sm:w-80">
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
          </div>
        }
      />

      <div className="flex gap-4">
        {/* Left-hand designer switcher (staff only). */}
        {isStaff && <DesignerRail designers={designers} current={targetId} />}

        <div className="min-w-0 flex-1">
          {board ? (
            <div className="flex flex-col gap-4">
              <DesignerBoard initial={board.columns} viewerRole={user.role} />
              <DataPanel>
                <div className="border-b border-line px-4 py-3">
                  <h2 className="text-sm font-semibold text-ink">Earnings history</h2>
                </div>
                {board.earningHistory.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-slate">No completed payable orders yet.</p>
                ) : (
                  <div className="divide-y divide-line">
                    {board.earningHistory.map((earning) => (
                      <div key={earning.id} className="grid grid-cols-1 gap-2 px-4 py-3 text-sm md:grid-cols-[1fr_auto_auto_auto_auto] md:items-center">
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
