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

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="flex min-w-0 items-center gap-1.5 rounded-input py-1 text-sm transition-colors hover:text-pigment"
          >
            {item.ok ? (
              <CheckCircle size={15} className="shrink-0 text-sage" />
            ) : (
              <AlertTriangle size={15} className="shrink-0 text-amber" />
            )}
            <span className={item.ok ? "text-ink" : "font-medium text-ink"}>{item.label}</span>
            <span className="truncate text-xs text-slate">{item.ok ? item.detail : item.action}</span>
          </Link>
        ))}
      </div>
    </DataPanel>
  );
}
