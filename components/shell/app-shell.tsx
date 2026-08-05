"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import type { Role } from "@/lib/auth/config";
import type { BusinessOption } from "@/lib/shell/context";
import { ToastProvider } from "@/components/ui";
import { Menu, X } from "@/components/ui/icons";
import { focusRing } from "@/components/ui/styles";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

/** Cookie the sidebar collapse preference persists in (read by the layout). */
export const SIDEBAR_COOKIE = "sidebar_collapsed";

type AppShellProps = {
  children: React.ReactNode;
  user: { name: string; email: string; role: Role };
  options: BusinessOption[];
  selected: BusinessOption;
  unread: number;
  initialCollapsed?: boolean;
};

export function AppShell({
  children,
  user,
  options,
  selected,
  unread,
  initialCollapsed = false,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Persist the collapse preference so it survives reloads and matches SSR.
  function toggleCollapsed() {
    setCollapsed((value) => {
      const next = !value;
      document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }

  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-ink">
      <div className="hidden h-screen shrink-0 lg:block">
        <Sidebar
          role={user.role}
          collapsed={collapsed}
          onToggle={toggleCollapsed}
        />
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-ink/30"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[min(20rem,calc(100vw-3rem))] bg-surface shadow-lg">
            <Sidebar
              role={user.role}
              onNavigate={() => setMobileOpen(false)}
              mobile
            />
          </div>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className={cn(
              "absolute right-3 top-3 flex size-10 items-center justify-center rounded-input bg-surface text-slate shadow-md",
              focusRing,
            )}
          >
            <X size={18} />
          </button>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          user={user}
          options={options}
          selected={selected}
          unread={unread}
          mobileMenuButton={
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
              className={cn(
                "flex size-10 items-center justify-center rounded-input text-slate transition-colors hover:bg-canvas hover:text-ink lg:hidden",
                focusRing,
              )}
            >
              <Menu size={20} />
            </button>
          }
        />
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8">
          <ToastProvider>{children}</ToastProvider>
        </main>
      </div>
    </div>
  );
}
