import { Page } from "@/components/ui";
import { HeaderSkeleton, RowsSkeleton } from "@/components/shell/skeletons";

/** Designers: header with Add designer, the ranked roster, then the team panel. */
export default function DesignersLoading() {
  return (
    <Page>
      <HeaderSkeleton actions={1} />
      <RowsSkeleton rows={6} rowClassName="h-10" />
      <RowsSkeleton rows={3} />
    </Page>
  );
}
