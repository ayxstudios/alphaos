import { cn } from "@/lib/utils";

type AvatarSize = "sm" | "md" | "lg";

export type AvatarProps = {
  name: string;
  src?: string;
  size?: AvatarSize;
  className?: string;
};

const sizes: Record<AvatarSize, string> = {
  sm: "size-7 text-xs",
  md: "size-9 text-sm",
  lg: "size-12 text-base",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, src, size = "md", className }: AvatarProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
        "bg-pigment-soft font-medium text-pigment select-none",
        sizes[size],
        className,
      )}
      role="img"
      aria-label={name}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="size-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
}
