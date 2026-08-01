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

export type TextareaProps =
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    label?: string;
    hint?: string;
    error?: string;
  };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, label, hint, error, id, rows = 4, ...props }, ref) {
    const autoId = useId();
    const textareaId = id ?? autoId;
    const msgId = `${textareaId}-msg`;
    return (
      <div className="flex flex-col gap-1.5">
        {label && <FieldLabel htmlFor={textareaId}>{label}</FieldLabel>}
        <textarea
          ref={ref}
          id={textareaId}
          rows={rows}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? msgId : undefined}
          className={cn(
            controlBase,
            controlBorder(!!error),
            "resize-y px-3 py-2 leading-relaxed",
            focusRing,
            className,
          )}
          {...props}
        />
        <FieldMessage id={msgId} hint={hint} error={error} />
      </div>
    );
  },
);
