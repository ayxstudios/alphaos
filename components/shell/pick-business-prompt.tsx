import { EmptyState, Page, PageHeader } from "@/components/ui";
import { Building } from "@/components/ui/icons";

/**
 * Shown on pages that are inherently scoped to one business (shop
 * credentials, portrait style catalogue, designer roster, customer list,
 * manual order entry) when the workspace switcher is set to "All
 * Businesses". Dashboard and Orders aggregate across businesses instead;
 * everything else asks the user to pick one specific business first
 * rather than silently querying with an invalid id.
 */
export function PickBusinessPrompt({ title }: { title: string }) {
  return (
    <Page>
      <PageHeader title={title} />
      <EmptyState
        icon={Building}
        headline="Pick a business first"
        body="This page works on one business at a time. Choose one from the workspace switcher at the top left, then come back."
      />
    </Page>
  );
}
