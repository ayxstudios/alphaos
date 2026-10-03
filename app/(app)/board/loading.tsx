import { Page, Skeleton } from "@/components/ui";
import { BoardColumnsSkeleton } from "@/components/board/board-skeleton";

/**
 * Board skeleton — shown instantly on navigation (and cached by Link prefetch)
 * while the columns load, so switching to the board never feels frozen.
 */
export default function BoardLoading() {
  return (
    <Page className="max-w-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-14 w-36 rounded-card" />
      </div>

      <BoardColumnsSkeleton />
    </Page>
  );
}
