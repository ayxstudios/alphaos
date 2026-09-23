import { Page } from "@/components/ui";
import { CardsSkeleton, HeaderSkeleton, TilesSkeleton } from "@/components/shell/skeletons";

/** My week: greeting, the week's numbers, then the day list. */
export default function MyWeekLoading() {
  return (
    <Page className="max-w-xl">
      <HeaderSkeleton />
      <TilesSkeleton count={2} className="lg:grid-cols-2" />
      <CardsSkeleton count={4} className="h-14" />
    </Page>
  );
}
