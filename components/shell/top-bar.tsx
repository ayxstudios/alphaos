"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cn } from "@/lib/utils";
import { Avatar, Badge } from "@/components/ui";
import { focusRing } from "@/components/ui/styles";
import {
  Bell,
  Building,
  ChevronDown,
  Check,
  LogOut,
  Search,
} from "@/components/ui/icons";
import type { Role } from "@/lib/auth/config";
import type { BusinessOption } from "@/lib/shell/context";
import { Popover } from "./popover";
import { setBusiness, signOutAction } from "@/app/(app)/actions";

type TopBarProps = {
  user: { name: string; email: string; role: Role };
  options: BusinessOption[];
  selected: BusinessOption;
  unread: number;
  mobileMenuButton?: React.ReactNode;
};

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  va: "VA",
  designer: "Designer",
};

export function TopBar({
  user,
  options,
  selected,
  unread,
  mobileMenuButton,
}: TopBarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");

  function choose(id: string, close: () => void) {
    close();
    startTransition(async () => {
      await setBusiness(id);
      router.refresh();
    });
  }

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    router.push(
      trimmed ? `/orders?q=${encodeURIComponent(trimmed)}` : "/orders",
    );
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur-none sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {mobileMenuButton}
        <Popover
          align="start"
          ariaLabel="Switch workspace"
          triggerClassName={cn(
            "inline-flex h-10 max-w-[13rem] items-center gap-2 rounded-input border border-line bg-surface px-2.5 text-sm font-medium text-ink",
            "transition-colors duration-150 ease-standard motion-hover hover:bg-canvas",
            pending && "opacity-60",
          )}
          trigger={
            <>
              <Building size={16} className="shrink-0 text-pigment" />
              <span className="truncate">{selected.name}</span>
              <ChevronDown size={15} className="shrink-0 text-slate" />
            </>
          }
        >
          {(close) => (
            <div className="flex flex-col">
              <p className="px-2 py-1.5 text-xs font-medium uppercase text-slate">
                Workspace
              </p>
              {options.map((o) => {
                const active = o.id === selected.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="menuitem"
                    onClick={() => choose(o.id, close)}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-input px-2 py-1.5 text-left text-sm",
                      "transition-colors motion-hover hover:bg-canvas",
                      focusRing,
                      active ? "text-pigment" : "text-ink",
                    )}
                  >
                    <span className="truncate">{o.name}</span>
                    {active && <Check size={15} className="shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </Popover>

        <form
          role="search"
          onSubmit={submitSearch}
          className="relative hidden w-full max-w-md sm:block"
        >
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search orders or customers"
            className={cn(
              "h-10 w-full rounded-input border border-line bg-canvas pl-9 pr-3 text-sm text-ink placeholder:text-slate/75",
              "transition-colors focus:bg-surface",
              focusRing,
            )}
          />
        </form>
      </div>

      <div className="flex items-center gap-2">
        <Popover
          ariaLabel={`Notifications${unread ? `, ${unread} unread` : ""}`}
          triggerClassName={cn(
            "relative inline-flex size-9 items-center justify-center rounded-input text-slate",
            "transition-colors motion-hover hover:bg-canvas hover:text-ink",
          )}
          trigger={
            <>
              <Bell size={18} />
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-rose px-1 text-[10px] font-semibold leading-4 text-surface">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </>
          }
        >
          {() => (
            <div className="flex flex-col gap-1 p-2">
              <p className="text-sm font-medium text-ink">Notifications</p>
              <p className="text-xs text-slate">
                {unread > 0
                  ? `You have ${unread} unread notification${unread === 1 ? "" : "s"}.`
                  : "You're all caught up."}
              </p>
            </div>
          )}
        </Popover>

        {/* User menu */}
        <Popover
          ariaLabel="Account menu"
          triggerClassName={cn(
            "inline-flex items-center gap-2 rounded-input py-1 pl-1 pr-2",
            "transition-colors motion-hover hover:bg-canvas",
          )}
          trigger={
            <>
              <Avatar name={user.name} size="sm" />
              <span className="hidden max-w-28 truncate text-sm font-medium text-ink md:inline">
                {user.name}
              </span>
              <ChevronDown size={15} className="text-slate" />
            </>
          }
        >
          {() => (
            <div className="flex flex-col">
              <div className="flex flex-col gap-0.5 px-2 py-1.5">
                <span className="truncate text-sm font-medium text-ink">
                  {user.name}
                </span>
                <span className="truncate text-xs text-slate">
                  {user.email}
                </span>
                <Badge variant="info" className="mt-1 w-fit">
                  {ROLE_LABEL[user.role]}
                </Badge>
              </div>
              <div className="my-1 h-px bg-line" />
              <form action={signOutAction}>
                <button
                  type="submit"
                  role="menuitem"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-sm text-ink",
                    "transition-colors motion-hover hover:bg-canvas",
                    focusRing,
                  )}
                >
                  <LogOut size={16} className="text-slate" />
                  Sign out
                </button>
              </form>
            </div>
          )}
        </Popover>
      </div>
    </header>
  );
}
