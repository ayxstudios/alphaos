"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addDesigner } from "@/app/(app)/designers/actions";
import type { BusinessOption } from "@/lib/shell/context";
import { Button, Drawer, Input, Select } from "@/components/ui";
import { CredentialsOnce } from "@/components/team/credentials-once";
import { PasswordField } from "@/components/team/team-panel";

/** Phone tap targets are 44px; desktop keeps the standard 40px controls. */
const TAP = "min-h-11 sm:min-h-0";

/**
 * "Add designer" for the roster: a small drawer that mints the designer's
 * login and attaches them to a business, so their board (and the finished-
 * portrait upload on it) exists without anyone touching the database.
 */
export function AddDesigner({
  businesses,
  variant = "primary",
}: {
  businesses: BusinessOption[];
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessId, setBusinessId] = useState(businesses[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; email: string; password: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setName("");
    setEmail("");
    setPassword("");
    setError(null);
    setDone(null);
  }

  function close() {
    const added = !!done;
    reset();
    setOpen(false);
    // Refresh only after the details were seen: adding the first designer swaps
    // the empty state (and this drawer with it) for the roster.
    if (added) router.refresh();
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await addDesigner({
        name,
        email,
        password,
        businessIds: businessId ? [businessId] : [],
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      // Shown once: the admin copies the sign-in details and sends them on.
      setDone({ name: name.trim(), email: email.trim().toLowerCase(), password });
    });
  }

  return (
    <>
      <Button type="button" variant={variant} className={TAP} onClick={() => setOpen(true)}>
        Add designer
      </Button>
      <Drawer open={open} onClose={close} title={done ? "Designer added" : "Add designer"}>
        {done ? (
          <CredentialsOnce
            lead={`${done.name} is added. Their board, with the finished-portrait upload, is ready.`}
            email={done.email}
            password={done.password}
            onDone={close}
          />
        ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-sm text-slate">
            The designer signs in with this email and password, then sees only the
            orders assigned to them on their board. They start with a daily limit of 5 and no styles; set both in the roster.
          </p>
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
          {businesses.length > 1 && (
            <Select
              label="Business"
              value={businessId}
              onChange={(e) => setBusinessId(e.currentTarget.value)}
              disabled={pending}
              className={TAP}
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
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
              Add designer
            </Button>
          </div>
        </form>
        )}
      </Drawer>
    </>
  );
}
