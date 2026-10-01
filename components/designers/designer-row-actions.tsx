"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setMemberActive } from "@/app/(app)/designers/actions";
import type { TeamMember } from "@/lib/team/manage";
import { SignInLinkDrawer } from "@/components/team/sign-in-link-drawer";
import { Button, Drawer, useToast } from "@/components/ui";
import { Copy, X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";

/** Phone tap targets are 44px; desktop keeps the compact row controls. */
const TAP = "min-h-11 sm:min-h-0";

/**
 * The two roster-row actions a VA (or admin) reaches for when a designer joins
 * or leaves: their sign-in link (made once, sent over WhatsApp, signs them in
 * with no password) and Remove (deactivate — history and orders stay).
 * SignInLinkDrawer is the same drawer the admin team panel uses, so the link
 * rules (shown once, new link replaces old) read identically everywhere.
 */
export function DesignerRowActions({ userId, name }: { userId: string; name: string }) {
  const [linkFor, setLinkFor] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState(false);

  // The drawer only reads id, name and link; the rest keeps the type honest.
  const asMember: TeamMember = {
    id: userId,
    name,
    email: "",
    role: "designer",
    active: true,
    openOrders: 0,
    link: null,
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setLinkFor(asMember)}
        className={cn(
          "flex h-11 items-center gap-1.5 rounded-input px-1 text-xs font-medium text-slate hover:text-ink lg:h-8",
          focusRing,
        )}
      >
        <Copy size={13} />
        Sign-in link
      </button>
      <button
        type="button"
        onClick={() => setRemoving(true)}
        className={cn(
          "flex h-11 items-center gap-1.5 rounded-input px-1 text-xs font-medium text-slate hover:text-rose lg:h-8",
          focusRing,
        )}
      >
        <X size={13} />
        Remove
      </button>

      <SignInLinkDrawer member={linkFor} isYou={false} onClose={() => setLinkFor(null)} />
      <RemoveDesignerDrawer userId={userId} name={name} open={removing} onClose={() => setRemoving(false)} />
    </>
  );
}

function RemoveDesignerDrawer({
  userId,
  name,
  open,
  onClose,
}: {
  userId: string;
  name: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    setError(null);
    onClose();
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      const res = await setMemberActive(userId, false);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({
        variant: "success",
        title: `${name} is removed`,
        description:
          res.openOrders > 0
            ? `${res.openOrders} open ${res.openOrders === 1 ? "order is" : "orders are"} still with them. Reassign from the order page.`
            : "They can no longer sign in. Their orders, pay and history stay.",
      });
      close();
      router.refresh();
    });
  }

  return (
    <Drawer open={open} onClose={close} title="Remove designer">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink">
          Remove <span className="font-semibold">{name}</span> from the roster?
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate">
          <li>They cannot sign in and their sign-in link stops working.</li>
          <li>They get no new orders and leave this list and Boards.</li>
          <li>Orders already with them stay with them until you reassign them.</li>
          <li>Their orders, pay and history stay. An admin can bring them back any time.</li>
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
          <Button type="button" variant="danger" className={TAP} loading={pending} onClick={confirm}>
            Remove
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
