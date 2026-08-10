import type { ComponentType } from "react";

import { cn } from "@/lib/utils";
import type { IconProps } from "./icons";

export type EmptyStateProps = {
  icon: ComponentType<IconProps>;
  headline: string;
  body?: string;
  action?: React.ReactNode;
  className?: string;
};

export function EmptyState({
  icon: Glyph,
  headline,
  body,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-pigment-soft text-pigment">
        <Glyph size={24} />
      </span>
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-lg text-ink">
          {headline}
        </h3>
        {body && <p className="max-w-sm text-sm text-slate">{body}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
