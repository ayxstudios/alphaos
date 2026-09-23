import { Page } from "@/components/ui";
import { CardsSkeleton, HeaderSkeleton, RowsSkeleton } from "@/components/shell/skeletons";

/** Quick guide: header, the steps checklist, then the questions. */
export default function HelpLoading() {
  return (
    <Page className="max-w-2xl">
      <HeaderSkeleton actions={1} />
      <RowsSkeleton rows={6} rowClassName="h-9" />
      <CardsSkeleton count={4} className="h-12" />
    </Page>
  );
}
