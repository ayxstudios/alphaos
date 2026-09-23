import { Page } from "@/components/ui";
import { HeaderSkeleton, RowsSkeleton } from "@/components/shell/skeletons";

/** QC: header, then the waiting list. */
export default function QcLoading() {
  return (
    <Page className="max-w-3xl">
      <HeaderSkeleton eyebrow />
      <RowsSkeleton rows={6} rowClassName="h-10" />
    </Page>
  );
}
