"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Grid, ListChecks, Package, Mail, Columns, Calendar, Menu, type IconProps } from "@/components/ui/icons";
import type { ComponentType } from "react";
import type { Role } from "@/lib/auth/config";

type Tab = { label: string; href: string; icon: ComponentType<IconProps> };

const ADMIN_VA_TABS: Tab[] = [
  { label: "Home", href: "/dashboard", icon: Grid },
  { label: "Today", href: "/today", icon: ListChecks },
  { label: "Orders", href: "/orders", icon: Package },
  { label: "Messages", href: "/emails", icon: Mail },
];

const DESIGNER_TABS: Tab[] = [
  { label: "Home", href: "/dashboard", icon: Grid },
  { label: "My Board", href: "/board", icon: Columns },
  { label: "My Week", href: "/me", icon: Calendar },
];

/**
 * Phone-only sticky bottom navigation, for every role: admin/va get the
 * four places they live day to day (Home is the charts overview, the full
 * queue moved to /today); designers get their own three pages. "More" opens
 * the same mobile sidebar drawer for everything else. The floating Alpha
 * launcher sits above this bar (see components/alpha/alpha-chat.tsx).
 */
export function BottomTabs({ role, onMore }: { role: Role; onMore: () => void }) {
  const pathname = usePathname();
  const tabs = role === "designer" ? DESIGNER_TABS : ADMIN_VA_TABS;
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex h-16 items-stretch border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + "/");
        const Glyph = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "flex min-h-11 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium",
              focusRing,
              active ? "text-pigment" : "text-slate",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Glyph size={20} />
            {tab.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        className={cn(
          "flex min-h-11 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium text-slate",
          focusRing,
        )}
      >
        <Menu size={20} />
        More
      </button>
    </nav>
  );
}
