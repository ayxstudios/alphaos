import { Badge } from "@/components/ui/badge";
import type { QcChangeRequest, QcChangeRequestKind } from "@/lib/qc/change-requests";
import { formatAt } from "@/lib/time";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<QcChangeRequestKind, string> = {
  customer_email: "Customer email",
  proof_revision: "Customer, proof page",
  qc_send_back: "QC send-back",
  revision_note: "Revision note",
  team_note: "Team note",
};

// Chip colours follow the board: rose for a QC fail, pigment for the customer's own ticks. The rose chip keeps its tint and
// border but reads in ink: rose text on the tint is under 4.5:1 on the panel's canvas.
const CHIP_VARIANT: Partial<Record<QcChangeRequestKind, "danger" | "info">> = {
  qc_send_back: "danger",
  proof_revision: "info",
};

export const CHANGE_REQUESTS_ID = "changes-asked-for";

function when(iso: string): string {
  return formatAt(iso, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Phone only: one 44px tap that jumps past the portrait to the panel. */
export function ChangeRequestsJump({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <a
      href={`#${CHANGE_REQUESTS_ID}`}
      data-testid="change-requests-jump"
      className="inline-flex min-h-11 items-center justify-between gap-2 rounded-input border border-pigment/20 bg-pigment-soft px-4 text-sm font-semibold text-pigment xl:hidden"
    >
      {count} {count === 1 ? "change" : "changes"} asked for
      <span aria-hidden="true">↓</span>
    </a>
  );
}

/**
 * "Changes asked for": what the customer, QC or the team asked to change on this
 * order, newest first, so the person checking sees the latest ask before the
 * portrait. Shows nothing at all when nothing was asked.
 */
export function ChangeRequestsPanel({ requests, older }: { requests: QcChangeRequest[]; older: number }) {
  if (requests.length === 0) return null;
  return (
    <section id={CHANGE_REQUESTS_ID} aria-label="Changes asked for" className="mb-4 scroll-mt-20 rounded-input bg-canvas p-3" data-testid="change-requests">
      <h2 className="font-display text-base font-semibold text-ink">Changes asked for</h2>
      {/* Fade edges (background-attachment: local) show there is more to scroll to, only while there is. */}
      <ul
        className="mt-2 flex max-h-64 flex-col gap-3 overflow-y-auto pr-1"
        style={{
          background:
            "linear-gradient(var(--color-canvas) 30%, transparent) top / 100% 24px no-repeat local, linear-gradient(transparent, var(--color-canvas) 70%) bottom / 100% 24px no-repeat local, linear-gradient(rgba(0,0,0,.14), transparent) top / 100% 8px no-repeat scroll, linear-gradient(transparent, rgba(0,0,0,.14)) bottom / 100% 8px no-repeat scroll",
        }}
        tabIndex={0}
        aria-label="Changes asked for, newest first"
      >
        {requests.map((r, i) => {
          const label = KIND_LABEL[r.kind];
          // "Customer email · Customer" would say it twice.
          const who = r.who && !label.startsWith(r.who) ? r.who : null;
          return (
            <li key={`${r.at}-${i}`} className={cn("border-l-2 pl-2.5", i === 0 ? "border-pigment" : "border-line")}>
              <p className="break-words text-xs text-slate">{[label, who, when(r.at)].filter(Boolean).join(" · ")}</p>
              {r.text ? <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink">{r.text}</p> : null}
              {r.items.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {r.items.map((item, j) => (
                    <Badge key={`${item}-${j}`} variant={CHIP_VARIANT[r.kind] ?? "neutral"} className={cn("max-w-full", r.kind === "qc_send_back" && "text-ink!")}>
                      {item}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
        {older > 0 ? <li className="text-xs text-slate">{older} older</li> : null}
      </ul>
    </section>
  );
}
