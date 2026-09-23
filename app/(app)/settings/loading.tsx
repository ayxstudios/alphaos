import { Page, Skeleton } from "@/components/ui";
import { HeaderSkeleton, PanelSkeleton } from "@/components/shell/skeletons";

/** Settings: the section list on the left, header + setup checklist + section panels on the right. */
export default function SettingsLoading() {
  return (
    <Page className="grid grid-cols-1 gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
      <aside className="flex gap-1 overflow-hidden lg:flex-col">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24 shrink-0 rounded-input lg:w-full" />
        ))}
      </aside>
      <div className="flex min-w-0 flex-col gap-6">
        <HeaderSkeleton description={false} />
        <PanelSkeleton lines={3} />
        <PanelSkeleton lines={4} />
        <PanelSkeleton lines={4} />
      </div>
    </Page>
  );
}
