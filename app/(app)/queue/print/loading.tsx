import { Page } from "@/components/ui";
import { CardsSkeleton, HeaderSkeleton } from "@/components/shell/skeletons";

/** Ready to Print: header, then the print cards. */
export default function PrintQueueLoading() {
  return (
    <Page>
      <HeaderSkeleton eyebrow />
      <CardsSkeleton count={4} className="h-28" />
    </Page>
  );
}
