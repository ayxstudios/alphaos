"use client";

import { useId, forwardRef } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "./styles";
import {
  FieldLabel,
  FieldMessage,
  controlBase,
  controlBorder,
} from "./field";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, hint, error, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const msgId = `${inputId}-msg`;
  return (
    <div className="flex flex-col gap-1.5">
      {label && <FieldLabel htmlFor={inputId}>{label}</FieldLabel>}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? msgId : undefined}
        className={cn(
          controlBase,
          controlBorder(!!error),
          "h-10 px-3",
          focusRing,
          className,
        )}
        {...props}
      />
      <FieldMessage id={msgId} hint={hint} error={error} />
    </div>
  );
});
