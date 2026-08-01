"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "./styles";
import {
  Info,
  CheckCircle,
  AlertTriangle,
  XCircle,
  X,
  Undo,
  type IconProps,
} from "./icons";

type ToastVariant = "info" | "success" | "warning" | "danger";

export type ToastOptions = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Optional action, e.g. undo. Invoking it also dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss delay in ms (default 4000). */
  duration?: number;
};

type ToastItem = ToastOptions & { id: number };

const MAX_VISIBLE = 3;
const DEFAULT_DURATION = 4000;

const ToastContext = createContext<((opts: ToastOptions) => void) | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const meta: Record<
  ToastVariant,
  { icon: (p: IconProps) => React.ReactElement; color: string }
> = {
  info: { icon: Info, color: "text-pigment" },
  success: { icon: CheckCircle, color: "text-sage" },
  warning: { icon: AlertTriangle, color: "text-amber" },
  danger: { icon: XCircle, color: "text-rose" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (opts: ToastOptions) => {
      const id = ++idRef.current;
      setToasts((prev) => {
        const next = [...prev, { ...opts, id }];
        // Stack to a maximum of 3 — drop the oldest beyond that.
        return next.slice(-MAX_VISIBLE);
      });
      const timer = setTimeout(
        () => dismiss(id),
        opts.duration ?? DEFAULT_DURATION,
      );
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((t) => {
          const { icon: Glyph, color } = meta[t.variant ?? "info"];
          return (
            <div
              key={t.id}
              role="status"
              className="pointer-events-auto flex items-start gap-3 rounded-card border border-line bg-surface p-3 shadow-lg [animation:alpha-toast-in_220ms_var(--ease-standard)]"
            >
              <span className={cn("mt-0.5 shrink-0", color)}>
                <Glyph size={18} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-sm font-medium text-ink">{t.title}</p>
                {t.description && (
                  <p className="text-xs text-slate">{t.description}</p>
                )}
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      t.action!.onClick();
                      dismiss(t.id);
                    }}
                    className={cn(
                      "mt-1.5 inline-flex w-fit items-center gap-1.5 rounded-input px-2 py-1 text-xs font-semibold text-pigment",
                      "transition-colors motion-hover hover:bg-pigment-soft",
                      focusRing,
                    )}
                  >
                    <Undo size={13} />
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className={cn(
                  "-mr-1 -mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-input text-slate",
                  "transition-colors motion-hover hover:bg-canvas hover:text-ink",
                  focusRing,
                )}
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
