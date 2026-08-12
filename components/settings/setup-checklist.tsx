import Link from "next/link";

import { Badge, DataPanel } from "@/components/ui";
import { AlertTriangle, CheckCircle } from "@/components/ui/icons";

export type SetupChecklistItem = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  href: string;
  action: string;
};

export function SetupChecklist({
  businessName,
  items,
}: {
  businessName: string;
  items: SetupChecklistItem[];
}) {
  const remaining = items.filter((item) => !item.ok).length;

  return (
    <DataPanel className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{businessName} live setup</h2>
          <p className="text-sm text-slate">
            {remaining === 0 ? "Ready to operate." : `${remaining} item${remaining === 1 ? "" : "s"} left.`}
          </p>
        </div>
        <Badge variant={remaining === 0 ? "success" : "warning"} dot>
          {remaining === 0 ? "Ready" : "Needs setup"}
        </Badge>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="rounded-input border border-line bg-canvas px-3 py-2 transition-colors hover:border-slate/40 hover:bg-surface"
          >
            <div className="flex items-start gap-2">
              {item.ok ? (
                <CheckCircle size={16} className="mt-0.5 shrink-0 text-sage" />
              ) : (
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber" />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{item.label}</p>
                <p className="truncate text-xs text-slate">{item.ok ? item.detail : item.action}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </DataPanel>
  );
}
