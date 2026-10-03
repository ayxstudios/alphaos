import { redirect } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";

import { auth } from "@/lib/auth";
import type { RequestUser } from "@/lib/db";
import { getDesignerBoard, type BoardCard, type DesignerBoard as BoardData } from "@/lib/orders/board-data";
import { getRailDesigners } from "@/lib/designers/roster";
import { loadShellData } from "@/lib/shell/context";
import { DesignerBoard } from "@/components/board/designer-board";
import { BoardSwitcher } from "@/components/board/board-switcher";
import { EarningsHistory } from "@/components/board/earnings-history";
import { ShareBoard } from "@/components/board/share-board";
import { DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import { Calendar, Columns, Search } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import BoardLoading from "./loading";

export const dynamic = "force-dynamic";

/** A card matches a designer's search on its number, title, first name, style or options. */
function cardMatches(card: BoardCard, needle: string): boolean {
  const hay = [card.orderNumber, card.title, card.customerName, card.style, ...card.options.map((o) => o.value)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

function filterColumns(cols: BoardData["columns"], q: string): BoardData["columns"] {
  const needle = q.toLowerCase();
  const out = { ...cols };
  for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] = out[k].filter((c) => cardMatches(c, needle));
  return out;
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
  const isStaff = user.role === "admin" || user.role === "va";
  // Designer search (top bar) lands here: filter their own cards. Staff search
  // goes to /orders, so a stray ?q= on a staff board is ignored.
  const q = !isStaff && typeof sp.q === "string" ? sp.q.trim().slice(0, 100) : "";
  // ?open=<orderId> (a deadline tapped on Home or My Week) opens that card.
  const openId = typeof sp.open === "string" ? sp.open : undefined;

  // Designers can only ever see their own board; staff pick one from the
  // right-hand rail (app shell) or the mobile dropdown below.
  // A teammate (helper) works their designer's board: same view, no pay.
  const targetId = isStaff ? designerParam : user.role === "helper" ? (session.user.helperFor ?? undefined) : user.id;

  // Staff: the boundary is keyed once (the BoardSwitcher keeps its own cache
  // and switches designers on the client, so a refresh must not remount it).
  // Designer: `force-dynamic` + a Suspense boundary keyed on the designer id: Next only
  // re-streams loading.tsx when the SEGMENT changes, not when just the
  // `?designer=` search param changes on this same route — so without this,
  // clicking a different designer in the rail leaves the old board sitting
  // there for however long the query takes, looking frozen. Keying the
  // boundary on targetId forces a fresh Suspense fallback on every switch.
  return (
    <Suspense key={isStaff ? "staff" : `${targetId ?? "none"}:${q}`} fallback={<BoardLoading />}>
      <BoardContent user={user} helperFor={session.user.helperFor ?? null} isStaff={isStaff} targetId={targetId} q={q} openId={openId} />
    </Suspense>
  );
}

async function BoardContent({
  user,
  helperFor,
  isStaff,
  targetId,
  q,
  openId,
}: {
  user: RequestUser;
  helperFor: string | null;
  isStaff: boolean;
  targetId?: string;
  q: string;
  openId?: string;
}) {
  // Staff land on a board, never on a picker: with no ?designer= the first
  // designer in the rail (rank order) is opened. The rail switches.
  // Staff only see the selected business's designers and, on each board,
  // only that business's orders (Yousif 2026-10-01). A ?designer= link from
  // another business falls back to this business's first designer.
  const selectedBusiness = isStaff ? (await loadShellData(user)).selected : undefined;
  const businessId = selectedBusiness?.id || undefined;
  // "AI Studio (Northlight Portraits)": inside that business the suffix only
  // says what the page header already says, and it truncated in the rail.
  const suffix = selectedBusiness?.name ? ` (${selectedBusiness.name})` : "";
  const designers = (isStaff ? await getRailDesigners(user, businessId) : []).map((d) => ({
    ...d,
    name: suffix && d.name.endsWith(suffix) ? d.name.slice(0, -suffix.length) : d.name,
  }));
  const resolvedId = isStaff
    ? (designers.find((d) => d.id === targetId) ?? designers[0])?.id
    : targetId;
  const board = resolvedId ? await getDesignerBoard(user, resolvedId, businessId, { helperFor }) : null;
  targetId = resolvedId;

  // Staff: one client component owns the header, the rail and the board, so
  // picking a designer is a client-side switch from a cache (docs/PERF.md).
  if (isStaff) {
    return (
      <BoardSwitcher
        key={businessId ?? "all"}
        designers={designers}
        initialId={resolvedId}
        initialBoard={board}
        viewerRole={user.role === "admin" ? "admin" : "va"}
        openId={openId}
      />
    );
  }

  const count = (cols: BoardData["columns"]) => Object.values(cols).reduce((n, list) => n + list.length, 0);
  const columns = board ? (q ? filterColumns(board.columns, q) : board.columns) : null;
  const matched = columns ? count(columns) : 0;
  const isHelper = user.role === "helper";

  return (
    <Page className="max-w-none">
      <PageHeader
        title="My Board"
        tourId="page:board"
        description="Soonest deadline first."
        actions={
          // A column below `sm` (align-items:stretch gives each row a real,
          // definite width — PageHeader's actions slot is flex-shrink-0, so
          // without that a wide row like the two StatCards below just
          // overflows a 390px phone instead of shrinking). Row + wrap once
          // there's room.
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {!isHelper && <ShareBoard />}
            {!isHelper && (
              <Link
                href="/me"
                className={cn(
                  "inline-flex h-11 w-fit items-center gap-1.5 rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas lg:h-9",
                  focusRing,
                )}
              >
                <Calendar size={15} />
                My Week
              </Link>
            )}
            {board && !isHelper && (
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
        <div className="min-w-0 flex-1">
          {board && columns ? (
            <div className="flex flex-col gap-4">
              {q && (
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-surface px-4 py-2.5 text-sm shadow-card"
                >
                  <Search size={15} className="shrink-0 text-slate" />
                  <span className="min-w-0 text-ink">
                    {matched === 0
                      ? <>None of your cards match &ldquo;{q}&rdquo;.</>
                      : <>{matched} of your {count(board.columns)} cards match &ldquo;{q}&rdquo;.</>}
                  </span>
                  <Link
                    href="/board"
                    className={cn("inline-flex min-h-11 items-center font-medium text-pigment hover:text-ink lg:min-h-0", focusRing)}
                  >
                    Clear search
                  </Link>
                </div>
              )}
              <DesignerBoard initial={columns} viewerRole="designer" timeZone={board.timeZone} openId={openId} />
              {!isHelper && <EarningsHistory history={board.earningHistory} />}
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
