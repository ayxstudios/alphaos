import { Badge } from "@/components/ui/badge";

/** The label an archived order carries on every screen: grey, so it never reads as work to do. */
export function ArchivedBadge() {
  return (
    <Badge variant="neutral" title="Old order, kept for history. Request a revision on it to bring it back." className="shrink-0 whitespace-nowrap text-ink!">
      Archived
    </Badge>
  );
}
