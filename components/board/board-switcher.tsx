"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { fetchDesignerBoard } from "@/app/(app)/board/switch-actions";
import { DesignerBoard } from "@/components/board/designer-board";
import { DesignerPicker } from "@/components/board/designer-picker";
import { DesignerRail } from "@/components/board/designer-rail";
import { BoardColumnsSkeleton } from "@/components/board/board-skeleton";
import { EarningsHistory } from "@/components/board/earnings-history";
import { EarningsPill } from "@/components/board/earnings-pill";
import { Button, DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { Columns } from "@/components/ui/icons";
import type { RailDesigner } from "@/lib/designers/roster";
import type { DesignerBoard as BoardData } from "@/lib/orders/board-data";

type Entry = { data: BoardData; at: number };

/** A board fetched this recently is not asked for again on selection. */
const FRESH_MS = 3_000;
/** Warm-up: first wait for the page to settle, then one board at a time. */
const WARM_START_MS = 1_500;
const WARM_GAP_MS = 150;
const WARM_MAX = 24;
/** Re-check the open board while the tab is in use (cards move on other screens). */
const REVALIDATE_MS = 60_000;

/**
 * The staff board: header, designer rail and the selected designer's board in
 * one client component, so picking a designer paints from memory at once
 * (docs/PERF.md). A click used to be a full server render of /board; now the
 * first render comes from the server, every other board is fetched by the
 * `fetchDesignerBoard` action, cached here, and shown stale-while-revalidate:
 *  - cached board: paints in the same frame, then refreshes in the background;
 *  - uncached board: the column skeleton shows in the pane while it loads.
 * After first paint the other designers' boards load in idle time, and hovering
 * or focusing a rail item loads that board ahead of the click. Next runs server
 * actions one at a time, so the warm-up goes one board per step and stops when
 * a click needs the queue.
 */
export function BoardSwitcher({
  designers,
  initialId,
  initialBoard,
  viewerRole,
  openId,
}: {
  designers: RailDesigner[];
  initialId: string | undefined;
  initialBoard: BoardData | null;
  viewerRole: "admin" | "va";
  /** ?open= card to open on the first board. */
  openId?: string;
}) {
  const [selected, setSelected] = useState(initialId);
  const [open, setOpen] = useState(openId);
  const [failed, setFailed] = useState<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const cache = useRef(new Map<string, Entry>());
  const inflight = useRef(new Map<string, Promise<void>>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const clickWaiting = useRef(false);

  // The server's copy of the first board is the freshest there is: seed it, and
  // take every later server render (router.refresh after a card move) too.
  if (initialId && initialBoard && cache.current.get(initialId)?.data !== initialBoard) {
    cache.current.set(initialId, { data: initialBoard, at: Date.now() });
  }

  const load = useCallback((id: string): Promise<void> => {
    const running = inflight.current.get(id);
    if (running) return running;
    const p = fetchDesignerBoard(id)
      .then((data) => {
        if (data) {
          cache.current.set(id, { data, at: Date.now() });
          if (selectedRef.current === id) {
            setFailed(null);
            bump();
          }
        } else if (selectedRef.current === id && !cache.current.has(id)) setFailed(id);
      })
      .catch(() => {
        if (selectedRef.current === id && !cache.current.has(id)) setFailed(id);
      })
      .finally(() => inflight.current.delete(id));
    inflight.current.set(id, p);
    return p;
  }, []);

  const select = useCallback(
    (id: string) => {
      if (id === selectedRef.current) return;
      selectedRef.current = id;
      setSelected(id);
      setOpen(undefined);
      setFailed(null);
      const url = new URL(window.location.href);
      url.searchParams.set("designer", id);
      url.searchParams.delete("open");
      window.history.replaceState(window.history.state, "", url.pathname + url.search);
      const entry = cache.current.get(id);
      if (!entry || Date.now() - entry.at > FRESH_MS) {
        clickWaiting.current = !entry;
        void load(id).finally(() => {
          clickWaiting.current = false;
        });
      }
    },
    [load],
  );

  const warm = useCallback(
    (id: string) => {
      if (!cache.current.has(id)) void load(id);
    },
    [load],
  );

  // After first paint, in idle time: every other rail designer's board, one by one.
  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    let cancelled = false;
    const queue = designers.map((d) => d.id).slice(0, WARM_MAX);
    const step = async () => {
      for (const id of queue) {
        if (cancelled) return;
        while (!cancelled && (clickWaiting.current || document.visibilityState !== "visible")) {
          await new Promise((r) => setTimeout(r, 400));
        }
        if (cancelled) return;
        if (!cache.current.has(id)) await load(id);
        await new Promise((r) => setTimeout(r, WARM_GAP_MS));
      }
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const t = setTimeout(() => {
      if (w.requestIdleCallback) w.requestIdleCallback(() => void step(), { timeout: 3_000 });
      else void step();
    }, WARM_START_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [designers, load]);

  // The open board is re-checked now and then, and when the tab comes back.
  useEffect(() => {
    const refresh = () => {
      const id = selectedRef.current;
      const entry = id ? cache.current.get(id) : undefined;
      if (id && document.visibilityState === "visible" && (!entry || Date.now() - entry.at > REVALIDATE_MS)) void load(id);
    };
    const timer = setInterval(refresh, REVALIDATE_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const entry = selected ? cache.current.get(selected) : undefined;
  const board = entry?.data ?? null;
  const pickerDesigners = designers.map((d) => ({ id: d.id, name: d.name }));

  return (
    <Page className="max-w-none">
      <PageHeader
        title="Boards"
        tourId="page:designers"
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {/* Mobile / narrow screens: the right rail is hidden, so keep a dropdown. */}
            <div className="lg:hidden">
              <DesignerPicker designers={pickerDesigners} current={selected} onSelect={select} />
            </div>
            {board && selected && (
              <EarningsPill designerId={selected} today={board.dailyEarnings} month={board.periodEarnings} />
            )}
          </div>
        }
      />

      <div className="flex gap-4">
        {/* Left-hand designer switcher. */}
        <DesignerRail designers={designers} current={selected} onSelect={select} onWarm={warm} />

        <div className="min-w-0 flex-1">
          {board ? (
            <div className="flex flex-col gap-4">
              <DesignerBoard
                key={selected}
                initial={board.columns}
                viewerRole={viewerRole}
                timeZone={board.timeZone}
                openId={open}
              />
              <EarningsHistory history={board.earningHistory} />
            </div>
          ) : failed && failed === selected ? (
            <DataPanel>
              <EmptyState
                icon={Columns}
                headline="That board did not load"
                body="Check your connection and try again."
                action={<Button onClick={() => selected && (setFailed(null), void load(selected))}>Try again</Button>}
              />
            </DataPanel>
          ) : selected ? (
            <BoardColumnsSkeleton />
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
