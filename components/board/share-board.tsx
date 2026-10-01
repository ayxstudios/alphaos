"use client";

import { useState, useTransition } from "react";

import {
  addHelperAction,
  listMyHelpers,
  recreateHelperLinkAction,
  removeHelperAction,
} from "@/app/(app)/board/share-actions";
import type { Helper } from "@/lib/team/helpers";
import { formatAt } from "@/lib/time";
import { Button, Drawer, Input, useToast } from "@/components/ui";
import { Copy, Users, X } from "@/components/ui/icons";
import { focusRing } from "@/components/ui/styles";
import { cn } from "@/lib/utils";

/** Phone tap targets are 44px; desktop keeps the standard 40px controls. */
const TAP = "min-h-11 sm:min-h-0";

const day = (iso: string | null | undefined) => formatAt(iso, { day: "numeric", month: "short", year: "numeric" });

const absolute = (url: string) => (url.startsWith("/") ? `${window.location.origin}${url}` : url);

type Made = { url: string; expiresAt: string };

/**
 * "Share" on My Board (designers only): add teammates who work this board with
 * you. They sign in through a private link, see your orders, and never see your
 * pay. The link is shown once, right after it is made (only its hash is
 * stored), so a row keeps it in memory only until the panel is closed.
 */
export function ShareBoard() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [helpers, setHelpers] = useState<Helper[] | null>(null);
  const [links, setLinks] = useState<Record<string, Made>>({});
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Helper | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function refresh() {
    return listMyHelpers().then(setHelpers, () => setError("Could not load your team. Try again."));
  }

  function openPanel() {
    setOpen(true);
    setError(null);
    void refresh();
  }

  function close() {
    setOpen(false);
    setLinks({});
    setName("");
    setError(null);
    setRemoving(null);
    setCopiedId(null);
  }

  async function copy(id: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2500);
    } catch {
      toast({ variant: "danger", title: "Could not copy", description: "Select the link and copy it by hand." });
    }
  }

  function add(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy("add");
    startTransition(async () => {
      const res = await addHelperAction(name);
      setBusy(null);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setLinks((cur) => ({ ...cur, [res.helperId]: { url: absolute(res.url), expiresAt: res.expiresAt } }));
      setName("");
      await refresh();
    });
  }

  function newLink(helper: Helper, thenCopy: boolean) {
    setError(null);
    setBusy(helper.id);
    startTransition(async () => {
      const res = await recreateHelperLinkAction(helper.id);
      setBusy(null);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      const made = { url: absolute(res.url), expiresAt: res.expiresAt };
      setLinks((cur) => ({ ...cur, [helper.id]: made }));
      if (thenCopy) await copy(helper.id, made.url);
      await refresh();
    });
  }

  function remove(helper: Helper) {
    setError(null);
    setBusy(helper.id);
    startTransition(async () => {
      const res = await removeHelperAction(helper.id);
      setBusy(null);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setRemoving(null);
      setLinks((cur) => {
        const next = { ...cur };
        delete next[helper.id];
        return next;
      });
      toast({
        variant: "success",
        title: `${helper.name} is removed`,
        description: "They can no longer sign in and their link stopped working.",
      });
      await refresh();
    });
  }

  const active = (helpers ?? []).filter((h) => h.active);

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        data-tour="board:share"
        className={cn(
          "inline-flex h-11 w-fit items-center gap-1.5 rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas lg:h-9",
          focusRing,
        )}
      >
        <Users size={15} />
        Share
      </button>

      <Drawer open={open} onClose={close} title="Your team">
        <div className="flex flex-col gap-5">
          <p className="text-sm text-slate">
            Teammates can work this board with you: open cards, move them and upload. They never see your pay or any
            of your earnings.
          </p>

          {helpers === null ? (
            <p className="text-sm text-slate" role="status">
              Loading your team...
            </p>
          ) : active.length === 0 ? (
            <p className="rounded-input border border-line bg-canvas p-3 text-sm text-slate">
              No teammates yet. Add one below and send them their link.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {active.map((h) => {
                const made = links[h.id];
                const rowBusy = pending && busy === h.id;
                return (
                  <li key={h.id} className="flex flex-col gap-2 rounded-input border border-line p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{h.name}</p>
                        <p className={cn("text-xs", h.link ? "text-sage" : "text-slate")}>
                          {h.link
                            ? h.link.lastUsedAt
                              ? `Link active until ${day(h.link.expiresAt)}, last used ${day(h.link.lastUsedAt)}`
                              : `Link active until ${day(h.link.expiresAt)}, not used yet`
                            : "No active link"}
                        </p>
                      </div>
                    </div>
                    {made && (
                      <div className="flex flex-col gap-1 rounded-input border border-line bg-canvas p-3">
                        <span className="text-xs text-slate">Sign-in link, shown only now</span>
                        <span className="break-all font-mono text-sm font-medium text-ink select-all" data-testid="helper-link-url">
                          {made.url}
                        </span>
                        <span className="pt-1 text-xs text-slate">
                          Opening it signs {h.name} straight in, no password. Works until {day(made.expiresAt)}. A new
                          link stops the old one. Send it to them directly and nowhere else.
                        </span>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        className={TAP}
                        disabled={pending}
                        loading={rowBusy}
                        onClick={() => (made ? void copy(h.id, made.url) : newLink(h, true))}
                      >
                        <Copy size={15} />
                        {copiedId === h.id ? "Copied" : "Copy link"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className={TAP}
                        disabled={pending}
                        onClick={() => newLink(h, false)}
                      >
                        New link
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className={cn(TAP, "text-rose")}
                        disabled={pending}
                        onClick={() => setRemoving(h)}
                      >
                        <X size={15} />
                        Remove
                      </Button>
                    </div>
                    {!made && (
                      <p className="text-xs text-slate">Links are shown once. Copy link makes a fresh one and stops the old.</p>
                    )}
                    {removing?.id === h.id && (
                      <div className="flex flex-col gap-2 rounded-input bg-canvas p-3" role="alert">
                        <p className="text-sm text-ink">
                          Remove <span className="font-semibold">{h.name}</span>? They can no longer sign in.
                        </p>
                        <div className="flex gap-2">
                          <Button type="button" variant="ghost" className={TAP} onClick={() => setRemoving(null)}>
                            Cancel
                          </Button>
                          <Button type="button" variant="danger" className={TAP} loading={rowBusy} onClick={() => remove(h)}>
                            Remove
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <form onSubmit={add} className="flex flex-col gap-3 border-t border-line pt-4">
            <Input
              label="Add teammate"
              hint="Their name. You get a sign-in link to send them."
              placeholder="e.g. Sam"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoComplete="off"
            />
            <Button
              type="submit"
              className={cn(TAP, "w-fit")}
              disabled={pending || name.trim().length < 2}
              loading={pending && busy === "add"}
            >
              Add and get link
            </Button>
          </form>

          {error && (
            <p role="alert" className="text-sm text-rose">
              {error}
            </p>
          )}
        </div>
      </Drawer>
    </>
  );
}
