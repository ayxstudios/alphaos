import { Page } from "@/components/ui";
import { HeaderSkeleton, PanelSkeleton, RowsSkeleton } from "@/components/shell/skeletons";

/** Portrait Styles: header, the unrecognised-products panel, then the styles list. */
export default function StylesLoading() {
  return (
    <Page>
      <HeaderSkeleton />
      <PanelSkeleton lines={2} />
      <RowsSkeleton rows={6} rowClassName="h-8" />
    </Page>
  );
}
