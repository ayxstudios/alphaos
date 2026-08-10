"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui";
import { Input } from "@/components/ui";
import { Card } from "@/components/ui";
import { AlertTriangle } from "@/components/ui/icons";
import { loginAction, type LoginState } from "./actions";

const initialState: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 text-center lg:items-start lg:text-left">
        <div className="flex size-10 items-center justify-center rounded-[10px] bg-ink font-display text-lg text-canvas lg:hidden">
          A
        </div>
        <div>
          <h1 className="font-display text-2xl tracking-tight text-ink">
            Welcome back
          </h1>
          <p className="mt-1 text-sm text-slate">
            Internal tool — accounts are issued by an admin.
          </p>
        </div>
      </div>

      <Card className="shadow-md">
        <div className="p-6">
          <form action={formAction} className="flex flex-col gap-4">
            {state.error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-input bg-rose/10 px-3 py-2 text-sm text-rose ring-1 ring-inset ring-rose/25"
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
              placeholder="you@aystudios.io"
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
            />

            <Button
              type="submit"
              size="lg"
              loading={pending}
              className="mt-1 w-full"
            >
              Sign in
            </Button>
          </form>
        </div>
      </Card>

      <p className="text-center text-xs text-slate lg:text-left">
        Trouble signing in? Ask an admin to check your account.
      </p>
    </div>
  );
}
