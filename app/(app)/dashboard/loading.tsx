import { Page, Skeleton } from "@/components/ui";
import { SectionSkeleton, TileSkeleton } from "@/components/home/primitives";

/** Home: the greeting, then the same tiles and chart blocks the page streams into. */
export default function HomeLoading() {
  return (
    <Page className="max-w-6xl">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-56" />
      </div>
      <div className="flex flex-col gap-5">
        <TileSkeleton />
        <SectionSkeleton h={260} />
        <SectionSkeleton h={260} />
      </div>
    </Page>
  );
}
