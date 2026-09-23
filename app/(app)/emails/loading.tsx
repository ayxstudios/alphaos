import { Page, Skeleton } from "@/components/ui";
import { HeaderSkeleton, RowsSkeleton } from "@/components/shell/skeletons";

/** Messages: header with New email, the workspace tabs, then the mail list. */
export default function EmailsLoading() {
  return (
    <Page className="max-w-none">
      <HeaderSkeleton eyebrow actions={1} />
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 shrink-0 rounded-full" />
        ))}
      </div>
      <RowsSkeleton rows={8} rowClassName="h-10" />
    </Page>
  );
}
