"use client";

import { useState } from "react";

import { Button, useToast } from "@/components/ui";
import { Copy } from "@/components/ui/icons";

/** A readable password for an admin to hand over: 14 characters, no look-alikes (0/O, 1/l/I). */
export function makePassword(length = 14): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * The sign-in details, shown ONCE right after an admin creates an account or
 * resets a password. The password is never stored in clear or shown again, so
 * this is the moment to copy it and send it to the person directly.
 */
export function CredentialsOnce({
  lead,
  email,
  password,
  onDone,
}: {
  lead: string;
  email: string;
  password: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = `Sign in to AlphaOS at ${window.location.origin}/login\nEmail: ${email}\nPassword: ${password}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toast({ variant: "danger", title: "Could not copy", description: "Select the details and copy them by hand." });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink">{lead}</p>
      <dl className="flex flex-col gap-2 rounded-input border border-line bg-canvas p-3 text-sm">
        <div className="flex flex-col">
          <dt className="text-xs text-slate">Email</dt>
          <dd className="break-all font-medium text-ink select-all">{email}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-slate">Password</dt>
          <dd className="break-all font-mono text-base font-medium text-ink select-all">{password}</dd>
        </div>
      </dl>
      <p className="text-sm text-slate">
        This password is shown only now. Send it to them directly; they can sign in straight away.
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" className="min-h-11 sm:min-h-0" onClick={copy}>
          <Copy size={16} />
          {copied ? "Copied" : "Copy sign-in details"}
        </Button>
        <Button type="button" className="min-h-11 sm:min-h-0" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
