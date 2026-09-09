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
import { Badge, DataPanel, Disclosure, EmptyState, Page, PageHeader } from "@/components/ui";
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
  // Staff land on a board, never on a picker: with no ?designer= the first
  // designer in the rail (rank order) is opened. The rail switches.
  const designers = isStaff ? await getRailDesigners(user) : [];
  const resolvedId = targetId ?? (isStaff ? designers[0]?.id : undefined);
  const board = resolvedId ? await getDesignerBoard(user, resolvedId) : null;
  targetId = resolvedId;

  const pickerDesigners = designers.map((d) => ({ id: d.id, name: d.name }));

  return (
    <Page className="max-w-none">
      <PageHeader
        title={isStaff ? "Designers" : "My board"}
        description={isStaff ? undefined : "Soonest deadline first."}
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
              <div className="flex items-center gap-4 rounded-card bg-surface px-4 py-2 text-sm shadow-card">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-xs text-slate">Today</span>
                  <span className="font-semibold tabular-nums text-ink">${board.dailyEarnings.toFixed(2)}</span>
                </span>
                <span className="h-4 w-px bg-line" aria-hidden="true" />
                <span className="flex items-baseline gap-1.5">
                  <span className="text-xs text-slate">This month</span>
                  <span className="font-semibold tabular-nums text-ink">${board.periodEarnings.toFixed(2)}</span>
                </span>
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
              <Disclosure
                summary="Earnings history"
                hint={board.earningHistory.length ? `${board.earningHistory.length} paid order${board.earningHistory.length === 1 ? "" : "s"}` : "nothing yet"}
              >
                {board.earningHistory.length === 0 ? (
                  <p className="py-1 text-sm text-slate">No completed payable orders yet.</p>
                ) : (
                  <div className="-mx-4 divide-y divide-line/70">
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
              </Disclosure>
            </div>
          ) : (
            <DataPanel>
              <EmptyState
                icon={Columns}
                headline="No designers yet"
                body="Add a designer in the roster and their board appears here."
              />
            </DataPanel>
          )}
        </div>
      </div>
    </Page>
  );
}
