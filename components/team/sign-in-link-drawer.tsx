"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { makeSignInLink, revokeMemberSignInLink } from "@/app/(app)/designers/actions";
import type { TeamMember } from "@/lib/team/manage";
import { formatAt } from "@/lib/time";
import { Button, Drawer, useToast } from "@/components/ui";
import { Copy } from "@/components/ui/icons";

/** Phone tap targets are 44px; desktop keeps the standard 40px controls. */
const TAP = "min-h-11 sm:min-h-0";

const day = (iso: string | null | undefined) => formatAt(iso, { day: "numeric", month: "short", year: "numeric" });

/**
 * One person's private sign-in link (lib/auth/login-link.ts): create, replace
 * or revoke. The full URL is shown ONCE, right after it is made (only its hash
 * is stored), with a copy button and the expiry date. Anyone holding the link
 * signs in as this person, so it goes to them directly and to nobody else.
 */
export function SignInLinkDrawer({
  member,
  isYou,
  onClose,
}: {
  member: TeamMember | null;
  isYou: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<"make" | "revoke" | null>(null);

  function close() {
    setMade(null);
    setCopied(false);
    setError(null);
    onClose();
  }

  function make() {
    if (!member) return;
    setError(null);
    setAction("make");
    startTransition(async () => {
      const res = await makeSignInLink(member.id);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      // NEXT_PUBLIC_APP_URL gives the full URL; without it (local only) use this origin.
      const url = res.url.startsWith("/") ? `${window.location.origin}${res.url}` : res.url;
      setMade({ url, expiresAt: res.expiresAt });
      router.refresh();
    });
  }

  function revoke() {
    if (!member) return;
    setError(null);
    setAction("revoke");
    startTransition(async () => {
      const res = await revokeMemberSignInLink(member.id);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({
        variant: "success",
        title: "Link revoked",
        description: `${member.name}'s sign-in link no longer works. They can still sign in with their password.`,
      });
      close();
      router.refresh();
    });
  }

  async function copy() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.url);
      setCopied(true);
    } catch {
      toast({ variant: "danger", title: "Could not copy", description: "Select the link and copy it by hand." });
    }
  }

  const link = member?.link ?? null;

  return (
    <Drawer open={!!member} onClose={close} title="Sign-in link">
      {member && made ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink">
            {isYou ? "Your" : `${member.name}'s`} sign-in link is ready. Opening it signs{" "}
            {isYou ? "you" : "them"} in with no password.
          </p>
          <div className="flex flex-col gap-1 rounded-input border border-line bg-canvas p-3">
            <span className="text-xs text-slate">Link</span>
            <span className="break-all font-mono text-sm font-medium text-ink select-all" data-testid="sign-in-link-url">
              {made.url}
            </span>
            <span className="pt-1 text-xs text-slate">Works until {day(made.expiresAt)}</span>
          </div>
          <p className="text-sm text-slate">
            Shown only now. Anyone with this link signs in as {isYou ? "you" : member.name}, so send it to{" "}
            {isYou ? "yourself" : "them"} directly and nowhere else. Any older link of{" "}
            {isYou ? "yours" : "theirs"} has stopped working.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" className={TAP} onClick={copy}>
              <Copy size={16} />
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button type="button" className={TAP} onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : member ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate">
            A private link that signs <span className="font-medium text-ink">{member.name}</span> in without typing a
            password. The normal sign-in page keeps asking for one.
          </p>
          <div className="flex flex-col gap-1 rounded-input border border-line bg-canvas p-3 text-sm">
            {link ? (
              <>
                <span className="font-medium text-sage">A link is active</span>
                <span className="text-slate">Works until {day(link.expiresAt)}</span>
                <span className="text-slate">
                  {link.lastUsedAt ? `Last used ${day(link.lastUsedAt)}` : "Not used yet"}
                </span>
              </>
            ) : (
              <span className="text-slate">No active link.</span>
            )}
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate">
            <li>It works for 90 days, as often as they like.</li>
            <li>Making a new one stops the old one.</li>
            <li>Resetting their password or deactivating them stops it too.</li>
          </ul>
          {error && (
            <p role="alert" className="text-sm text-rose">
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" className={TAP} onClick={close} disabled={pending}>
              Cancel
            </Button>
            {link && (
              <Button
                type="button"
                variant="secondary"
                className={TAP}
                loading={pending && action === "revoke"}
                disabled={pending}
                onClick={revoke}
              >
                Revoke link
              </Button>
            )}
            <Button
              type="button"
              className={TAP}
              loading={pending && action === "make"}
              disabled={pending}
              onClick={make}
            >
              {link ? "Replace link" : "Create link"}
            </Button>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
