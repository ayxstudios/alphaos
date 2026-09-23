import { Page, Skeleton } from "@/components/ui";
import { HeaderSkeleton } from "@/components/shell/skeletons";

/** System Health: header with the Selected / All toggle, then the signals and rows. */
export default function HealthLoading() {
  return (
    <Page>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <HeaderSkeleton eyebrow />
        <Skeleton className="h-10 w-52 rounded-input" />
      </div>
      <Skeleton className="h-24 rounded-card" />
      <Skeleton className="h-12 rounded-card" />
      <Skeleton className="h-40 rounded-card" />
      <Skeleton className="h-24 rounded-card" />
    </Page>
  );
}
