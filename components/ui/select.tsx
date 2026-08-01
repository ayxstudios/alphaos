"use client";

import { useId, forwardRef } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "./styles";
import { ChevronDown } from "./icons";
import {
  FieldLabel,
  FieldMessage,
  controlBase,
  controlBorder,
} from "./field";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, label, hint, error, id, children, ...props },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const msgId = `${selectId}-msg`;
  return (
    <div className="flex flex-col gap-1.5">
      {label && <FieldLabel htmlFor={selectId}>{label}</FieldLabel>}
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? msgId : undefined}
          className={cn(
            controlBase,
            controlBorder(!!error),
            "h-10 appearance-none pl-3 pr-9",
            focusRing,
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate"
        />
      </div>
      <FieldMessage id={msgId} hint={hint} error={error} />
    </div>
  );
});
