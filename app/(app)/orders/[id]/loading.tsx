import { DataPanel, Page, Skeleton } from "@/components/ui";
import { HeaderSkeleton, PanelSkeleton, RowsSkeleton } from "@/components/shell/skeletons";

/**
 * One order: header (shop, number, status, actions), the facts strip, then
 * items and messages on the left with the side cards on the right. Also what
 * a row click on the Orders list shows while the order streams in.
 */
export default function OrderLoading() {
  return (
    <Page className="max-w-6xl">
      <HeaderSkeleton eyebrow actions={2} />
      <DataPanel className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </DataPanel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.4fr)_22rem]">
        <div className="flex flex-col gap-4">
          <RowsSkeleton rows={2} rowClassName="h-16" />
          <PanelSkeleton lines={4} />
          <RowsSkeleton rows={3} />
        </div>
        <aside className="flex flex-col gap-4">
          <PanelSkeleton lines={2} />
          <PanelSkeleton lines={3} />
          <PanelSkeleton lines={2} />
        </aside>
      </div>
    </Page>
  );
}
