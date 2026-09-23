"use client";

import { signIn } from "next-auth/react";
import { useEffect, useRef, useState } from "react";

import { Card } from "@/components/ui";
import { AlertTriangle, Spinner } from "@/components/ui/icons";
import { focusRing } from "@/components/ui/styles";
import { cn } from "@/lib/utils";

type Phase = "signing" | "failed" | "locked";

/**
 * Signs in with the "link" provider as soon as the page loads, then lands on
 * /dashboard with a full navigation (fresh server render with the new cookie).
 * A link that does not work (revoked, expired, replaced, or the person was
 * deactivated) shows a calm card with the way back to the normal sign-in.
 */
export function LinkSignIn({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>("signing");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev
    started.current = true;
    (async () => {
      try {
        const res = await signIn("link", { token, redirect: false, redirectTo: "/dashboard" });
        if (res?.ok && !res.error) {
          window.location.replace("/dashboard");
          return;
        }
        setPhase(res?.code === "locked" ? "locked" : "failed");
      } catch {
        setPhase("failed");
      }
    })();
  }, [token]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-10 items-center justify-center rounded-card bg-pigment text-surface font-display text-lg font-bold">
          A
        </div>
        <h1 className="font-display text-2xl font-semibold text-ink">AlphaOS</h1>
      </div>

      <Card className="p-6" data-testid="link-sign-in" data-phase={phase}>
        {phase === "signing" ? (
          <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-2 text-center">
            <Spinner size={20} className="text-pigment" />
            <p className="text-base font-medium text-ink">Signing you in</p>
            <p className="text-sm text-slate">This takes a moment.</p>
          </div>
        ) : (
          <div role="alert" className="flex flex-col gap-4">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-1 shrink-0 text-amber" />
              <div className="flex flex-col gap-1">
                <p className="text-base font-medium text-ink">
                  {phase === "locked" ? "Too many tries from here" : "This link no longer works"}
                </p>
                <p className="text-sm text-slate">
                  {phase === "locked"
                    ? "Wait 15 minutes, then open your link again, or sign in with your password."
                    : "It may have expired or been replaced. Sign in with your password, or ask your admin for a new link."}
                </p>
              </div>
            </div>
            <a
              href="/login"
              className={cn(
                "inline-flex h-12 w-full items-center justify-center rounded-input bg-pigment px-5 text-base font-medium text-surface",
                "transition-opacity duration-[120ms] hover:opacity-90",
                focusRing,
              )}
            >
              Go to sign in
            </a>
          </div>
        )}
      </Card>
    </div>
  );
}
