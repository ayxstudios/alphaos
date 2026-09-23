"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addTeamMember, resetMemberPassword, setMemberActive } from "@/app/(app)/designers/actions";
import type { TeamMember } from "@/lib/team/manage";
import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Avatar, Badge, Button, DataPanel, Drawer, Input, SectionHeader, Select, useToast } from "@/components/ui";
import { CredentialsOnce, makePassword } from "./credentials-once";
import { SignInLinkDrawer } from "./sign-in-link-drawer";

type Filter = "staff" | "designers" | "inactive";

const ROLE_LABEL: Record<TeamMember["role"], string> = { admin: "Admin", va: "VA", designer: "Designer" };

/** Phone tap targets are 44px; desktop keeps the standard 40px controls. */
const TAP = "min-h-11 sm:min-h-0";

/**
 * Admin-only "Team and sign-ins" on the Designers page: everyone who can sign
 * in, with Add VA or admin, Sign-in link (a private no-password link, see
 * lib/auth/login-link.ts), Reset password, and Deactivate / Reactivate.
 * Designers themselves are added with the roster's Add designer (it also links
 * their business); they show up here once added.
 */
export function TeamPanel({ members, currentUserId }: { members: TeamMember[]; currentUserId: string }) {
  const [filter, setFilter] = useState<Filter>("staff");
  const [dialog, setDialog] = useState<{ kind: "deactivate" | "password" | "link"; member: TeamMember } | null>(null);
  const router = useRouter();
  const toast = useToast();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const groups: Record<Filter, TeamMember[]> = {
    staff: members.filter((m) => m.active && m.role !== "designer"),
    designers: members.filter((m) => m.active && m.role === "designer"),
    inactive: members.filter((m) => !m.active),
  };
  const tabs: { id: Filter; label: string }[] = [
    { id: "staff", label: "Admins and VAs" },
    { id: "designers", label: "Designers" },
    { id: "inactive", label: "Deactivated" },
  ];
  const shown = groups[filter];

  function reactivate(member: TeamMember) {
    setPendingId(member.id);
    startTransition(async () => {
      const res = await setMemberActive(member.id, true);
      setPendingId(null);
      if (!res.ok) {
        toast({ variant: "danger", title: "Could not reactivate", description: res.message });
        return;
      }
      toast({
        variant: "success",
        title: `${member.name} is active again`,
        description:
          member.role === "designer"
            ? "They can sign in and are back on the roster at their old place."
            : "They can sign in with their old password, or reset it.",
      });
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3" data-tour="team">
      <SectionHeader
        title="Team and sign-ins"
        description="Everyone who can sign in. Deactivate someone who leaves: they cannot sign in or get new orders, and their orders and history stay."
        actions={<AddTeammate />}
      />
      <DataPanel>
        <div role="tablist" aria-label="Show" className="flex flex-wrap gap-1 border-b border-line p-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={filter === t.id}
              onClick={() => setFilter(t.id)}
              className={cn(
                "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-input px-2 text-sm font-medium sm:h-9 sm:px-3",
                "transition-colors motion-hover",
                filter === t.id ? "bg-pigment-soft text-pigment" : "text-slate hover:bg-canvas hover:text-ink",
                focusRing,
              )}
            >
              {t.label}
              <span className="text-xs tabular-nums opacity-80">{groups[t.id].length}</span>
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate">
            {filter === "inactive" ? "Nobody is deactivated." : "Nobody here yet."}
          </p>
        ) : (
          <ul className="divide-y divide-line/70">
            {shown.map((m) => {
              const isYou = m.id === currentUserId;
              return (
                <li key={m.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar name={m.name} />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink">
                        <span className="truncate">{m.name}</span>
                        <Badge>{ROLE_LABEL[m.role]}</Badge>
                        {isYou && <Badge variant="info">You</Badge>}
                        {!m.active && <Badge variant="warning">Deactivated</Badge>}
                        {m.active && m.link && <Badge variant="success">Link</Badge>}
                      </p>
                      <p className="truncate text-sm text-slate">{m.email}</p>
                      {m.role === "designer" && !m.active && m.openOrders > 0 && (
                        <p className="mt-0.5 text-xs text-amber">
                          {m.openOrders} open {m.openOrders === 1 ? "order is" : "orders are"} still with them.
                          Reassign from the order page.
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                    {m.active && (
                      <Button
                        variant="secondary"
                        className={cn(TAP, "col-span-2 sm:col-auto")}
                        onClick={() => setDialog({ kind: "link", member: m })}
                      >
                        Sign-in link
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      className={TAP}
                      onClick={() => setDialog({ kind: "password", member: m })}
                    >
                      Reset password
                    </Button>
                    {m.active ? (
                      isYou ? (
                        <span className="self-center text-center text-xs text-slate sm:w-28">Signed in as you</span>
                      ) : (
                        <Button
                          variant="secondary"
                          className={TAP}
                          onClick={() => setDialog({ kind: "deactivate", member: m })}
                        >
                          Deactivate
                        </Button>
                      )
                    ) : (
                      <Button
                        variant="secondary"
                        className={TAP}
                        loading={pendingId === m.id}
                        onClick={() => reactivate(m)}
                      >
                        Reactivate
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DataPanel>

      <DeactivateDrawer
        member={dialog?.kind === "deactivate" ? dialog.member : null}
        onClose={() => setDialog(null)}
      />
      <ResetPasswordDrawer
        member={dialog?.kind === "password" ? dialog.member : null}
        isYou={dialog?.member.id === currentUserId}
        onClose={() => setDialog(null)}
      />
      <SignInLinkDrawer
        member={dialog?.kind === "link" ? dialog.member : null}
        isYou={dialog?.member.id === currentUserId}
        onClose={() => setDialog(null)}
      />
    </section>
  );
}

function DeactivateDrawer({ member, onClose }: { member: TeamMember | null; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    setError(null);
    onClose();
  }

  function confirm() {
    if (!member) return;
    setError(null);
    startTransition(async () => {
      const res = await setMemberActive(member.id, false);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast({
        variant: "success",
        title: `${member.name} is deactivated`,
        description:
          res.openOrders > 0
            ? `${res.openOrders} open ${res.openOrders === 1 ? "order is" : "orders are"} still with them. Reassign from the order page.`
            : "They can no longer sign in. Their history stays.",
      });
      close();
      router.refresh();
    });
  }

  return (
    <Drawer open={!!member} onClose={close} title="Deactivate">
      {member && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink">
            Deactivate <span className="font-semibold">{member.name}</span> ({member.email})?
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate">
            <li>They cannot sign in, a session they have open ends on their next click, and their sign-in link stops working.</li>
            {member.role === "designer" && (
              <li>They get no new orders and leave the roster and the Designers board list.</li>
            )}
            {member.role === "designer" && (
              <li>Orders already with them stay with them until you reassign them.</li>
            )}
            <li>Their orders, pay and history stay. You can reactivate them any time.</li>
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
              Deactivate
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function ResetPasswordDrawer({
  member,
  isYou,
  onClose,
}: {
  member: TeamMember | null;
  isYou: boolean;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    setPassword("");
    setDone(null);
    setError(null);
    onClose();
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!member) return;
    setError(null);
    startTransition(async () => {
      const res = await resetMemberPassword(member.id, password);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setDone({ email: member.email, password });
      setPassword("");
    });
  }

  return (
    <Drawer open={!!member} onClose={close} title="Reset password">
      {member && done ? (
        <CredentialsOnce
          lead={
            isYou
              ? "Your password is changed. You will be asked to sign in again with it. Your sign-in link, if you had one, has stopped working."
              : `${member.name}'s password is changed. Any session they had open has ended, and their sign-in link has stopped working.`
          }
          email={done.email}
          password={done.password}
          onDone={close}
        />
      ) : member ? (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-sm text-slate">
            Set a new password for <span className="font-medium text-ink">{member.name}</span>. It is shown to you
            once, and every session they have open ends.
          </p>
          <PasswordField value={password} onChange={setPassword} disabled={pending} label="New password" />
          {error && (
            <p role="alert" className="text-sm text-rose">
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" className={TAP} onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" className={TAP} loading={pending}>
              Set password
            </Button>
          </div>
        </form>
      ) : null}
    </Drawer>
  );
}

/** Password input with a "Make one" helper; plain text so the admin can read what they set. */
export function PasswordField({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Input
        label={label}
        type="text"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        hint="At least 8 characters. You see it once, then send it to them directly."
        autoComplete="new-password"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        minLength={8}
        required
        disabled={disabled}
        className={cn(TAP, "font-mono")}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(TAP, "self-start")}
        onClick={() => onChange(makePassword())}
        disabled={disabled}
      >
        Make one for me
      </Button>
    </div>
  );
}

/** Add a VA (default) or another admin, with a password the admin sets. */
function AddTeammate() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"va" | "admin">("va");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<{ name: string; email: string; password: string; role: "va" | "admin" } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close() {
    setOpen(false);
    setName("");
    setEmail("");
    setPassword("");
    setRole("va");
    setError(null);
    setDone(null);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await addTeamMember({ name, email, password, role });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setDone({ name: name.trim(), email: email.trim().toLowerCase(), password, role });
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" variant="secondary" className={TAP} onClick={() => setOpen(true)}>
        Add VA or admin
      </Button>
      <Drawer open={open} onClose={close} title={done ? "Account ready" : "Add VA or admin"}>
        {done ? (
          <CredentialsOnce
            lead={`${done.name} is added as ${done.role === "admin" ? "an admin" : "a VA"}.`}
            email={done.email}
            password={done.password}
            onDone={close}
          />
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm text-slate">
              A VA sees every order and designer board, runs QC and approves customer emails. An admin can do
              everything, including this page.
            </p>
            <Select
              label="Role"
              value={role}
              onChange={(e) => setRole(e.currentTarget.value === "admin" ? "admin" : "va")}
              disabled={pending}
              className={TAP}
            >
              <option value="va">VA</option>
              <option value="admin">Admin</option>
            </Select>
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              autoComplete="off"
              required
              disabled={pending}
              className={TAP}
            />
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              autoComplete="off"
              autoCapitalize="off"
              required
              disabled={pending}
              className={TAP}
            />
            <PasswordField value={password} onChange={setPassword} disabled={pending} label="Password" />
            {error && (
              <p role="alert" className="text-sm text-rose">
                {error}
              </p>
            )}
            <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" className={TAP} onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" className={TAP} loading={pending}>
                Add {role === "admin" ? "admin" : "VA"}
              </Button>
            </div>
          </form>
        )}
      </Drawer>
    </>
  );
}
