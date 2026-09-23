"use client";

import { useActionState, useEffect, useRef } from "react";

import { Button } from "@/components/ui";
import { Input } from "@/components/ui";
import { Card } from "@/components/ui";
import { AlertTriangle } from "@/components/ui/icons";
import { loginAction, type LoginState } from "./actions";

const initialState: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const passwordRef = useRef<HTMLInputElement>(null);

  // A wrong password keeps the email and puts the cursor back in Password.
  useEffect(() => {
    if (state.error && state.email) passwordRef.current?.focus();
  }, [state]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-10 items-center justify-center rounded-card bg-pigment text-surface font-display text-lg font-bold">
          A
        </div>
        <h1 className="font-display text-2xl font-semibold text-ink">
          Sign in to AlphaOS
        </h1>
        <p className="text-sm text-slate">Use the email and password you were given.</p>
      </div>

      <Card className="p-6">
        <form action={formAction} className="flex flex-col gap-4">
          {state.error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-input border border-rose/30 bg-rose/10 px-3 py-2 text-sm text-rose"
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{state.error}</span>
            </div>
          )}

          <Input
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            defaultValue={state.email}
            required
            autoFocus
          />
          <Input
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            required
            ref={passwordRef}
          />

          <Button type="submit" size="lg" loading={pending} className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
      <p className="text-center text-sm text-slate">Forgot your password? Ask your admin.</p>
    </div>
  );
}
