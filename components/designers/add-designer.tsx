"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addDesigner } from "@/app/(app)/designers/actions";
import type { BusinessOption } from "@/lib/shell/context";
import { Button, Drawer, Input, Select, useToast } from "@/components/ui";

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
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessId, setBusinessId] = useState(businesses[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setName("");
    setEmail("");
    setPassword("");
    setError(null);
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
      toast({
        variant: "success",
        title: "Designer added",
        description: `${name.trim()} can sign in with ${email.trim().toLowerCase()} and the temporary password.`,
      });
      reset();
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)}>
        Add designer
      </Button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Add designer">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-sm text-slate">
            The designer signs in with this email and temporary password, then sees only the
            orders assigned to them on their board. They start with a daily limit of 5 and no styles; set both in the roster.
          </p>
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            autoComplete="off"
            required
            disabled={pending}
          />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            autoComplete="off"
            required
            disabled={pending}
          />
          <Input
            label="Temporary password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            hint="At least 8 characters. Share it with the designer directly."
            autoComplete="new-password"
            minLength={8}
            required
            disabled={pending}
          />
          {businesses.length > 1 && (
            <Select
              label="Business"
              value={businessId}
              onChange={(e) => setBusinessId(e.currentTarget.value)}
              disabled={pending}
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
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Add designer
            </Button>
          </div>
        </form>
      </Drawer>
    </>
  );
}
