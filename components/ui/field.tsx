import { cn } from "@/lib/utils";

/** Shared label / hint / error scaffolding for form controls. */
export function FieldLabel({
  htmlFor,
  children,
  className,
}: {
  htmlFor: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("text-sm font-medium text-ink", className)}
    >
      {children}
    </label>
  );
}

export function FieldMessage({
  id,
  hint,
  error,
}: {
  id: string;
  hint?: string;
  error?: string;
}) {
  if (error) {
    return (
      <p id={id} className="text-xs text-rose" role="alert">
        {error}
      </p>
    );
  }
  if (hint) {
    return (
      <p id={id} className="text-xs text-slate">
        {hint}
      </p>
    );
  }
  return null;
}

/** Base control classes shared by Input / Textarea / Select. */
export const controlBase =
  "w-full rounded-input border bg-surface text-sm text-ink " +
  "placeholder:text-slate/70 transition-[border-color,box-shadow] motion-hover " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-canvas";

// Focus ring is always 2px --pigment (per design rules); error shows as a rose
// border + message, not a differently-coloured ring.
export function controlBorder(error?: boolean) {
  return error ? "border-rose" : "border-line hover:border-slate/50";
}
