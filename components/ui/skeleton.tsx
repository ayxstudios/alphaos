import { cn } from "@/lib/utils";

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/** Loading placeholder. Pulses via opacity (collapses to static on reduced motion). */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-input bg-line/70", className)}
      {...props}
    />
  );
}
